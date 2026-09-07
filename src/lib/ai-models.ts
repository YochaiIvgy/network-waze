import { z } from "zod";
import type { ListedModel, Provider } from "./ai-providers";

export const modelsQuery = z.object({
  provider: z.enum(["anthropic", "openai", "gemini"]),
  apiKey: z.string().trim().max(4096).optional(),
});

const SKIP = /audio|realtime|transcribe|tts|whisper|dall-e|dall_e|embedding|moderation|imagen|image|computer|codex|search|sora|davinci|babbage|ada|instruct|veo|aqa|lyria|robotics/;
const OPENAI_CHAT = /^(gpt-4o|gpt-4\.|gpt-4-|gpt-5|o1|o3|o4|chatgpt-)/;
function headers(provider: Provider, apiKey: string): Record<string, string> {
  if (provider === "anthropic") return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  if (provider === "gemini") return { "x-goog-api-key": apiKey };
  return { Authorization: `Bearer ${apiKey}` };
}

async function getJson(url: string, requestHeaders: Record<string, string>) {
  const response = await fetch(url, { headers: requestHeaders, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    const status = response.status;
    await response.text().catch(() => "");
    throw new Error(status === 401 || status === 403
      ? "That API key was rejected. Check it and try again."
      : status === 429
        ? "The provider rate-limited the model list request. Try again in a moment."
        : `Could not list models (${status}).`);
  }
  return response.json() as Promise<Record<string, unknown>>;
}

async function anthropicModels(apiKey: string): Promise<ListedModel[]> {
  const models: ListedModel[] = [];
  let after = "";
  do {
    const url = new URL("https://api.anthropic.com/v1/models");
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after_id", after);
    const page = await getJson(url.toString(), headers("anthropic", apiKey));
    const rows = (page.data as Array<{ id?: string; display_name?: string; capabilities?: { structured_outputs?: { supported?: boolean } } }> | undefined) ?? [];
    for (const row of rows) {
      if (!row.id || row.capabilities?.structured_outputs?.supported === false) continue;
      models.push({ id: row.id, label: row.display_name || row.id });
    }
    after = page.has_more && page.last_id ? String(page.last_id) : "";
  } while (after && models.length < 200);
  return models;
}

async function openaiModels(apiKey: string): Promise<ListedModel[]> {
  const page = await getJson("https://api.openai.com/v1/models", headers("openai", apiKey));
  return ((page.data as Array<{ id?: string; created?: number }> | undefined) ?? [])
    .filter(row => {
      const id = (row.id ?? "").toLowerCase();
      return OPENAI_CHAT.test(id) && !SKIP.test(id);
    })
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
    .map(row => ({ id: row.id!, label: row.id! }));
}

async function geminiModels(apiKey: string): Promise<ListedModel[]> {
  const models: ListedModel[] = [];
  let token = "";
  do {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("pageSize", "100");
    if (token) url.searchParams.set("pageToken", token);
    const page = await getJson(url.toString(), headers("gemini", apiKey));
    for (const row of (page.models as Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }> | undefined) ?? []) {
      const id = (row.name ?? "").replace(/^models\//, "");
      const methods = row.supportedGenerationMethods ?? [];
      if (!id || !methods.includes("generateContent") || SKIP.test(id.toLowerCase()) || !id.toLowerCase().includes("gemini")) continue;
      models.push({ id, label: row.displayName || id });
    }
    token = typeof page.nextPageToken === "string" ? page.nextPageToken : "";
  } while (token && models.length < 200);
  return models;
}

export async function listProviderModels(provider: Provider, apiKey: string): Promise<ListedModel[]> {
  const models = provider === "anthropic" ? await anthropicModels(apiKey)
    : provider === "openai" ? await openaiModels(apiKey)
    : await geminiModels(apiKey);
  const seen = new Set<string>();
  return models.filter(model => seen.has(model.id) ? false : (seen.add(model.id), true));
}
