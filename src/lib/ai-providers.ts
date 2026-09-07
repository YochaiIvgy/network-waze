export const PROVIDERS = {
  anthropic: { label: "Claude · Anthropic", model: "claude-opus-5", models: ["claude-opus-5", "claude-sonnet-4-6", "claude-haiku-4-5"] },
  openai: { label: "OpenAI", model: "gpt-4.1", models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o"] },
  gemini: { label: "Gemini · Google", model: "gemini-2.5-flash", models: ["gemini-2.5-flash", "gemini-2.5-pro"] },
} as const;
export type Provider = keyof typeof PROVIDERS;
export interface ListedModel { id: string; label: string }
export interface PublicSettings {
  provider: Provider;
  providers: Record<Provider, { model: string; configured: boolean; source: "saved" | "environment" | null }>;
}
