import { query } from "../db";

/**
 * Granola OAuth + MCP transport.
 *
 * Granola is a *source*, not the extractor. This module does exactly two things:
 * list the user's meetings and fetch a raw transcript. Everything the graph is
 * built from — people, relationships, warmth, hooks — comes from our own
 * structured-output model call in `lib/extraction/`, against the transcript this
 * module returns. Granola's own `query_granola_meetings` tool is deliberately
 * unused: a conversational endpoint cannot promise a schema, and the claim
 * ledger needs one.
 *
 * Token handling: the OAuth tokens are encrypted with a key derived from a
 * random secret that only ever lives in the user's cookie. The database row is
 * useless without that cookie, so a database dump does not leak Granola access.
 */

const MCP_ENDPOINT = "https://mcp.granola.ai/mcp";
const AUTH_ORIGIN = "https://mcp-auth.granola.ai";
const COOKIE = "waze_granola_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface GranolaSession {
  clientId: string;
  redirect?: string;
  verifier?: string;
  state?: string | null;
  pendingUntil?: number;
  accessToken?: string;
  refreshToken?: string;
  expires?: number;
}

// --- crypto helpers ---------------------------------------------------------

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const unb64url = (s: string) =>
  Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function keyFor(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encrypt(secret: string, data: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await keyFor(secret),
    new TextEncoder().encode(JSON.stringify(data)),
  );
  return `${b64url(iv)}.${b64url(new Uint8Array(cipher))}`;
}

async function decrypt(secret: string, blob: string): Promise<GranolaSession> {
  const [iv, cipher] = blob.split(".");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64url(iv) },
    await keyFor(secret),
    unb64url(cipher),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as GranolaSession;
}

// --- session storage --------------------------------------------------------

export function cookieSecret(request: Request): string {
  return request.headers.get("cookie")?.match(new RegExp(`(?:^|; )${COOKIE}=([^;]+)`))?.[1] ?? "";
}

export async function readSession(request: Request): Promise<GranolaSession | null> {
  const secret = cookieSecret(request);
  if (!secret) return null;
  const rows = await query<{ data: string }>(
    `SELECT data FROM granola_sessions WHERE id = $1 AND expires_at > now()`,
    [await sha256Hex(secret)],
  );
  if (!rows[0]) return null;
  try {
    return await decrypt(secret, rows[0].data);
  } catch {
    // A rotated cookie cannot decrypt an old row; treat it as signed out.
    return null;
  }
}

async function writeSession(secret: string, data: GranolaSession): Promise<void> {
  await query(
    `INSERT INTO granola_sessions (id, data, expires_at)
     VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at`,
    [await sha256Hex(secret), await encrypt(secret, data), String(SESSION_TTL_MS)],
  );
}

export async function disconnect(request: Request): Promise<void> {
  const secret = cookieSecret(request);
  if (secret) await query(`DELETE FROM granola_sessions WHERE id = $1`, [await sha256Hex(secret)]);
}

// --- OAuth ------------------------------------------------------------------

interface AuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
}

/**
 * `fetch` in Node reports every transport failure as the single word "fetch
 * failed" and hides the actual reason — DNS, TLS, refused connection, timeout —
 * one level down in `cause`. Surfacing that chain is the difference between an
 * error a user can act on and one they can only stare at.
 */
function describeFetchError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 4; depth++) {
    const code = (current as { code?: string }).code;
    parts.push(code ? `${code}: ${current.message}` : current.message);
    current = (current as { cause?: unknown }).cause;
  }
  const text = [...new Set(parts)].join(" — ");
  if (/UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_UNTRUSTED|unable to verify the first certificate/i.test(text)) {
    return `${text}. This is almost always antivirus or a corporate proxy inspecting HTTPS: Node does not read the OS certificate store, so it cannot verify the re-signed certificate. Point it at the interceptor's root CA with WAZE_EXTRA_CA_CERTS before starting the server — see "HTTPS inspection" in the README.`;
  }
  return text;
}

/**
 * One network call to Granola, with a timeout and a single retry.
 *
 * The retry is deliberately only for transport failures, never for an HTTP
 * error: a 4xx from the auth server is an answer, and repeating it would just
 * hide a real problem behind a slower one.
 */
async function granolaFetch(url: string, init: RequestInit, what: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      lastError = err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw new Error(`Could not reach Granola to ${what} (${describeFetchError(lastError)}).`);
}

async function metadata(): Promise<AuthMetadata> {
  const response = await granolaFetch(
    `${AUTH_ORIGIN}/.well-known/oauth-authorization-server`,
    { method: "GET" },
    "start sign-in",
  );
  if (!response.ok) {
    throw new Error(`Granola authentication is unavailable (HTTP ${response.status}).`);
  }
  const meta = (await response.json()) as AuthMetadata;
  // Never follow an endpoint that points somewhere other than Granola's own
  // auth origin — that would be an open redirect for the authorization code.
  for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint"] as const) {
    if (new URL(meta[key]).origin !== AUTH_ORIGIN) {
      throw new Error("Unexpected Granola authentication endpoint.");
    }
  }
  return meta;
}

/**
 * The redirect URI is derived from the incoming request's origin, so an attacker
 * who can make this app answer on a hostname they control could register that
 * hostname as a redirect target. Localhost is always allowed for development;
 * anything else must be named in `WAZE_APP_ORIGIN` before deploying publicly.
 */
function assertAllowedOrigin(origin: string): void {
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return;
  const allowed = process.env.WAZE_APP_ORIGIN;
  if (allowed && origin === allowed) return;
  throw new Error(
    allowed
      ? "Unrecognized app origin."
      : "Set WAZE_APP_ORIGIN to this deployment's origin before connecting Granola.",
  );
}

/** Dynamic client registration + PKCE. Returns the redirect that starts sign-in. */
export async function beginConnect(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;
  assertAllowedOrigin(origin);
  const redirect = `${origin}/api/granola/callback`;
  const meta = await metadata();

  const registration = await granolaFetch(
    meta.registration_endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Network Waze",
        redirect_uris: [redirect],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    },
    "register this app",
  );
  if (!registration.ok) {
    throw new Error(`Granola could not register this app (HTTP ${registration.status}). Please retry later.`);
  }
  const client = (await registration.json()) as { client_id: string };

  const secret = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = crypto.randomUUID();
  await writeSession(secret, {
    clientId: client.client_id,
    redirect,
    verifier,
    state,
    pendingUntil: Date.now() + 600_000,
  });

  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const url = new URL(meta.authorization_endpoint);
  for (const [k, v] of Object.entries({
    client_id: client.client_id,
    redirect_uri: redirect,
    response_type: "code",
    scope: "openid email profile offline_access",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: MCP_ENDPOINT,
  })) {
    url.searchParams.set(k, v);
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: url.href,
      "Cache-Control": "no-store",
      "Set-Cookie":
        `${COOKIE}=${secret}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}` +
        (origin.startsWith("https:") ? "; Secure" : ""),
    },
  });
}

export async function completeConnect(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const session = await readSession(request);
  const state = url.searchParams.get("state");

  if (!session?.state || !session.pendingUntil || state !== session.state || session.pendingUntil < Date.now()) {
    throw new Error("Granola sign-in expired. Connect again.");
  }
  if (url.searchParams.has("error")) throw new Error("Granola sign-in was cancelled.");
  const code = url.searchParams.get("code");
  if (!code) throw new Error("Granola did not return an authorization code.");

  const secret = cookieSecret(request);
  // Burn the state immediately so the code cannot be replayed.
  await writeSession(secret, { ...session, state: null });

  const meta = await metadata();
  const response = await granolaFetch(
    meta.token_endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: session.clientId,
        redirect_uri: session.redirect ?? "",
        code_verifier: session.verifier ?? "",
        resource: MCP_ENDPOINT,
      }),
    },
    "exchange the sign-in code",
  );
  if (!response.ok) {
    throw new Error(`Granola authorization failed (HTTP ${response.status}). Reconnect your account.`);
  }

  const token = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  await writeSession(secret, {
    clientId: session.clientId,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expires: Date.now() + (token.expires_in ?? 3600) * 1000,
  });

  return Response.redirect(new URL("/?connected=1", request.url), 302);
}

async function accessToken(request: Request): Promise<string> {
  const session = await readSession(request);
  if (!session?.accessToken) throw new Error("Connect your Granola account first.");
  if ((session.expires ?? 0) > Date.now() + 60_000) return session.accessToken;
  if (!session.refreshToken) throw new Error("Granola sign-in expired. Reconnect your account.");

  const meta = await metadata();
  const response = await granolaFetch(
    meta.token_endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: session.refreshToken,
        client_id: session.clientId,
        resource: MCP_ENDPOINT,
      }),
    },
    "refresh your sign-in",
  );
  if (!response.ok) throw new Error("Granola sign-in expired. Reconnect your account.");

  const token = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  await writeSession(cookieSecret(request), {
    ...session,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? session.refreshToken,
    expires: Date.now() + (token.expires_in ?? 3600) * 1000,
  });
  return token.access_token;
}

// --- MCP --------------------------------------------------------------------

export interface McpTool {
  name: string;
  inputSchema?: {
    properties?: Record<string, { default?: unknown }>;
    required?: string[];
  };
}

export interface McpClient {
  tools: McpTool[];
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export async function mcp(request: Request): Promise<McpClient> {
  const token = await accessToken(request);
  let sessionId = "";
  let version = "2025-03-26";
  let seq = 0;

  async function rpc(method: string, params: unknown, notify = false): Promise<any> {
    let response: Response;
    try {
      response = await fetch(MCP_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": version,
          ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", ...(notify ? {} : { id: ++seq }), method, params }),
        // Extraction pulls a whole transcript, so this is deliberately generous.
        signal: AbortSignal.timeout(90_000),
      });
    } catch (err) {
      throw new Error(`Could not reach Granola (${describeFetchError(err)}).`);
    }

    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? "Granola authorization expired. Reconnect your account."
          : response.status === 429
            ? "Granola rate limit reached. Please try again shortly."
            : `Granola request failed (${response.status}). Check your plan and try again.`,
      );
    }

    sessionId = response.headers.get("mcp-session-id") || sessionId;
    if (notify || response.status === 202) return null;

    const text = await response.text();
    let data: any;
    if (response.headers.get("content-type")?.includes("event-stream")) {
      const messages = text
        .split(/\r?\n\r?\n/)
        .map((block) =>
          block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n"),
        )
        .filter(Boolean);
      for (const message of messages) {
        try {
          const parsed = JSON.parse(message);
          if (parsed.id === seq) data = parsed;
        } catch {
          // Keep-alive frames and partial chunks are expected.
        }
      }
    } else {
      data = JSON.parse(text);
    }

    if (!data) throw new Error("Granola returned an incomplete response.");
    if (data.error) {
      throw new Error(`Granola could not complete this request: ${String(data.error.message).slice(0, 300)}`);
    }
    return data.result;
  }

  const init = await rpc("initialize", {
    protocolVersion: version,
    capabilities: {},
    clientInfo: { name: "network-waze", version: "1.0.0" },
  });
  version = init?.protocolVersion || version;
  await rpc("notifications/initialized", {}, true);

  const listing = await rpc("tools/list", {});
  const tools: McpTool[] = listing?.tools ?? [];

  return {
    tools,
    async call(name, args) {
      if (!tools.some((t) => t.name === name)) {
        throw new Error(
          `Your Granola account does not expose ${name}. Check your plan or workspace permissions.`,
        );
      }
      const result = await rpc("tools/call", { name, arguments: args });
      if (result?.isError) {
        throw new Error(`Granola could not complete the request: ${resultText(result).slice(0, 300)}`);
      }
      return result;
    },
  };
}

export function resultText(result: any): string {
  if (result?.structuredContent) return JSON.stringify(result.structuredContent);
  return (result?.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

/**
 * Granola names the same parameter differently across accounts and tool
 * versions, so arguments are built from the *advertised* schema rather than
 * guessed. An unknown required parameter is an error, never a silent omission
 * that returns the wrong meeting.
 */
export function toolArgs(tool: McpTool, values: { meetingId?: string }): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const properties = tool.inputSchema?.properties ?? {};
  const required = tool.inputSchema?.required ?? [];

  for (const [key, schema] of Object.entries(properties)) {
    if (/^(meeting_id|document_id|note_id)$/.test(key) && values.meetingId) {
      args[key] = values.meetingId;
    } else if (/^(meeting_ids|document_ids|note_ids)$/.test(key) && values.meetingId) {
      args[key] = [values.meetingId];
    } else if (schema?.default !== undefined) {
      args[key] = schema.default;
    } else if (required.includes(key)) {
      if (key === "limit") args[key] = 20;
      else throw new Error(`Granola requires an unsupported parameter (${key}). Its tool schema needs an adapter update.`);
    }
  }
  return args;
}
