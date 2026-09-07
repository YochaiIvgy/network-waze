import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/**
 * Launch a command after pointing Node at extra CAs.
 *
 * Node (this app) does not read the OS certificate store. Cloudflare's
 * workerd runtime (network-analysis / wrangler / vinext) does — that is why
 * Granola sign-in can work there and fail here with
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE when antivirus re-signs HTTPS.
 *
 * NODE_EXTRA_CA_CERTS / --use-system-ca have to be set before the process
 * starts, so this wrapper:
 *   - on Node 22.15+: passes --use-system-ca (Windows CryptoAPI / macOS Keychain)
 *   - on older Node + Windows: dumps Trusted Root CAs into a PEM bundle
 *   - always honours WAZE_EXTRA_CA_CERTS from the environment or .env
 *
 *   node scripts/with-ca.mjs next dev
 *   node scripts/with-ca.mjs tsx scripts/ingest.ts
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });

applyExtraCas();

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error("Usage: node scripts/with-ca.mjs <command> [args...]");
  process.exit(1);
}

const child = spawn(cmd, args, {
  stdio: "inherit",
  env: process.env,
  cwd: root,
  // Windows looks up .cmd shims in node_modules/.bin only through the shell.
  shell: process.platform === "win32",
});

child.on("error", (err) => {
  console.error(err);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

function nodeHasSystemCa() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 15);
}

function applyExtraCas() {
  const parts = [];

  if (nodeHasSystemCa()) {
    const opts = process.env.NODE_OPTIONS || "";
    if (!/(^|\s)--use-system-ca(\s|$)/.test(opts)) {
      process.env.NODE_OPTIONS = [opts, "--use-system-ca"].filter(Boolean).join(" ").trim();
    }
  } else if (process.platform === "win32") {
    const cache = path.join(root, ".waze-data", "windows-roots.pem");
    refreshWindowsRootCache(cache);
    if (fs.existsSync(cache)) parts.push(fs.readFileSync(cache, "utf8"));
  }

  const extra = process.env.WAZE_EXTRA_CA_CERTS;
  if (extra) {
    const resolved = path.isAbsolute(extra) ? extra : path.resolve(root, extra);
    if (fs.existsSync(resolved)) parts.push(fs.readFileSync(resolved, "utf8"));
    else console.warn(`with-ca: WAZE_EXTRA_CA_CERTS not found: ${resolved}`);
  }

  if (!parts.length) return;
  const dest = path.join(root, ".waze-data", "node-extra-ca.pem");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, parts.join("\n"));
  process.env.NODE_EXTRA_CA_CERTS = dest;
}

function refreshWindowsRootCache(cache) {
  const maxAgeMs = 12 * 60 * 60 * 1000;
  try {
    if (fs.existsSync(cache) && Date.now() - fs.statSync(cache).mtimeMs < maxAgeMs) return;
  } catch {
    // Recreate the cache if we cannot read it.
  }

  const ps = `
    $ErrorActionPreference = 'Continue'
    $sb = New-Object System.Text.StringBuilder
    foreach ($storePath in @('Cert:\\LocalMachine\\Root', 'Cert:\\CurrentUser\\Root')) {
      Get-ChildItem $storePath -ErrorAction SilentlyContinue | ForEach-Object {
        try {
          if (-not $_.RawData -or $_.RawData.Length -lt 1) { return }
          [void]$sb.AppendLine('-----BEGIN CERTIFICATE-----')
          [void]$sb.AppendLine([Convert]::ToBase64String($_.RawData, [Base64FormattingOptions]::InsertLineBreaks))
          [void]$sb.AppendLine('-----END CERTIFICATE-----')
        } catch {}
      }
    }
    [Console]::Out.Write($sb.ToString())
  `;

  try {
    const pem = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
      { encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
    );
    if (!pem.includes("BEGIN CERTIFICATE")) return;
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, pem);
  } catch (err) {
    console.warn("with-ca: could not read the Windows certificate store:", err.message);
  }
}
