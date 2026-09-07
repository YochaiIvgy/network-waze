function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export const env = {
  databaseUrl: optional("DATABASE_URL"),
  anthropicApiKey: optional("ANTHROPIC_API_KEY"),
  model: optional("WAZE_MODEL") ?? "claude-opus-5",
  embeddingProvider: (optional("WAZE_EMBEDDING_PROVIDER") ?? "hash") as "hash" | "voyage",
  voyageApiKey: optional("VOYAGE_API_KEY"),
  workspaceSlug: optional("WAZE_WORKSPACE") ?? "default",
  /** Where the embedded PGlite database lives when DATABASE_URL is unset. */
  embeddedDataDir: optional("WAZE_DATA_DIR") ?? "./.waze-data",
};

/** The app browses seeded data fine without a key; only ingest/search need one. */
export function requireAnthropic(): string {
  if (!env.anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Extraction and natural-language search need it; " +
        "browsing an already-populated graph does not.",
    );
  }
  return env.anthropicApiKey;
}
