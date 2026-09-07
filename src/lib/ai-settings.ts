import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PROVIDERS, type Provider, type PublicSettings } from "./ai-providers";

const entry = z.object({ model: z.string().trim().min(1).max(200), apiKey: z.string().max(4096).optional() });
const schema = z.object({ provider: z.enum(["anthropic", "openai", "gemini"]), providers: z.object({ anthropic: entry, openai: entry, gemini: entry }) });
const directory = () => resolve(process.env.WAZE_SETTINGS_DIR ?? ".waze-settings");
const filename = () => join(directory(), "ai.json");
function read() {
  if (existsSync(filename())) return schema.parse(JSON.parse(readFileSync(filename(), "utf8")));
  return schema.parse({ provider: "anthropic", providers: Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, { model: id === "anthropic" ? process.env.WAZE_MODEL || p.model : p.model }])) });
}
function environmentKey(provider: Provider) {
  return provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : provider === "openai" ? process.env.OPENAI_API_KEY : process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
}
export function resolveApiKey(provider: Provider, override?: string) {
  return override?.trim() || read().providers[provider].apiKey || environmentKey(provider);
}
export function aiConfig() {
  const settings = read();
  return { provider: settings.provider, model: settings.providers[settings.provider].model, apiKey: resolveApiKey(settings.provider) };
}
export function publicSettings(): PublicSettings {
  const settings = read();
  return { provider: settings.provider, providers: Object.fromEntries(Object.entries(settings.providers).map(([id, value]) => [id, { model: value.model, configured: Boolean(value.apiKey || environmentKey(id as Provider)), source: value.apiKey ? "saved" : environmentKey(id as Provider) ? "environment" : null }])) as PublicSettings["providers"] };
}
export const settingsUpdate = z.object({ provider: z.enum(["anthropic", "openai", "gemini"]), model: z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9._:/-]+$/), apiKey: z.string().trim().max(4096).optional(), removeKey: z.boolean().optional() });
export function saveSettings(input: z.infer<typeof settingsUpdate>) {
  const update = settingsUpdate.parse(input);
  const settings = read();
  settings.provider = update.provider;
  const config = settings.providers[update.provider];
  config.model = update.model;
  if (update.removeKey) delete config.apiKey;
  else if (update.apiKey) config.apiKey = update.apiKey;
  mkdirSync(directory(), { recursive: true, mode: 0o700 });
  const temporary = join(directory(), `${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(settings), { mode: 0o600 });
  renameSync(temporary, filename());
  return publicSettings();
}
