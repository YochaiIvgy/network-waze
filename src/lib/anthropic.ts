import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod/v4";
import { env, requireAnthropic } from "./env";

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: requireAnthropic() });
  return client;
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
  const response = await anthropic().messages.parse({
    model: env.model,
    max_tokens: opts.maxTokens ?? 16000,
    thinking: { type: "adaptive" },
    system: opts.cacheSystem === false
      ? opts.system
      : [{ type: "text", text: opts.system, cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ role: "user", content: opts.user }],
    output_config: {
      effort: opts.effort ?? "high",
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
  const response = await anthropic().messages.create({
    model: env.model,
    max_tokens: opts.maxTokens ?? 4000,
    thinking: { type: "adaptive" },
    system: opts.cacheSystem === false
      ? opts.system
      : [{ type: "text", text: opts.system, cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ role: "user", content: opts.user }],
    output_config: { effort: opts.effort ?? "medium" },
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

export function hasAnthropicKey(): boolean {
  return Boolean(env.anthropicApiKey);
}
