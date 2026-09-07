import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod/v4";
import { aiConfig } from "./ai-settings";
import { callOtherProvider } from "./ai-completion";

export function anthropic(): Anthropic {
  const { apiKey } = aiConfig();
  if (!apiKey) throw new Error("Add an API key in Settings to use AI features.");
  return new Anthropic({ apiKey });
}
export interface StructuredCallOptions<T extends z.ZodType> {
  system: string;
  user: string;
  schema: T;
  /** Cached prefix stays byte-identical across calls; that is the whole point. */
  cacheSystem?: boolean;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
}

export interface StructuredResult<T> {
  data: T;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

/**
 * One structured call. Returns typed data or throws — a malformed extraction is
 * never allowed to reach the claim ledger.
 */
export async function callStructured<T extends z.ZodType>(
  opts: StructuredCallOptions<T>,
): Promise<StructuredResult<z.infer<T>>> {
  if (aiConfig().provider !== "anthropic") {
    const result = await callOtherProvider(opts, zodOutputFormat(opts.schema).schema);
    return { data: opts.schema.parse(JSON.parse(result.text)) as z.infer<T>, usage: result.usage };
  }
  const response = await anthropic().messages.parse({
    model: aiConfig().model,
    max_tokens: opts.maxTokens ?? 16000,

    system: opts.cacheSystem === false
      ? opts.system
      : [{ type: "text", text: opts.system, cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ role: "user", content: opts.user }],
    output_config: {

      format: zodOutputFormat(opts.schema),
    },
  });

  if (response.stop_reason === "refusal") {
    throw new Error(
      `Model declined the request (${response.stop_details?.category ?? "unspecified"}).`,
    );
  }
  if (!response.parsed_output) {
    throw new Error("Structured output failed to parse against the schema.");
  }

  const u = response.usage;
  return {
    data: response.parsed_output as z.infer<T>,
    usage: {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    },
  };
}

/** Prose generation: dossiers, edge context cards, answer composition. */
export async function callText(opts: {
  system: string;
  user: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
  cacheSystem?: boolean;
}): Promise<string> {
  if (aiConfig().provider !== "anthropic") return (await callOtherProvider(opts)).text;
  const response = await anthropic().messages.create({
    model: aiConfig().model,
    max_tokens: opts.maxTokens ?? 4000,

    system: opts.cacheSystem === false
      ? opts.system
      : [{ type: "text", text: opts.system, cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ role: "user", content: opts.user }],

  });

  if (response.stop_reason === "refusal") {
    throw new Error(`Model declined the request (${response.stop_details?.category ?? "unspecified"}).`);
  }
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export function hasAIKey(): boolean {
  return Boolean(aiConfig().apiKey);
}
