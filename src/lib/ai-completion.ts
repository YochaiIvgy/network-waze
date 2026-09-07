import { aiConfig } from "./ai-settings";

export async function callOtherProvider(opts: { system: string; user: string; maxTokens?: number }, schema?: Record<string, unknown>) {
  const { provider, model, apiKey } = aiConfig();
  if (!apiKey) throw new Error("Add an API key in Settings to use AI features.");
  const gemini = provider === "gemini";
  const response = await fetch(gemini
    ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
    : "https://api.openai.com/v1/chat/completions", {
    method: "POST", signal: AbortSignal.timeout(180_000),
    headers: { "Content-Type": "application/json", ...(gemini ? { "x-goog-api-key": apiKey } : { Authorization: `Bearer ${apiKey}` }) },
    body: JSON.stringify(gemini ? {
      systemInstruction: { parts: [{ text: opts.system }] }, contents: [{ role: "user", parts: [{ text: opts.user }] }],
      generationConfig: { maxOutputTokens: opts.maxTokens ?? 16000, ...(schema ? { responseMimeType: "application/json", responseJsonSchema: schema } : {}) },
    } : {
      model, max_completion_tokens: opts.maxTokens ?? 16000,
      messages: [{ role: "system", content: opts.system }, { role: "user", content: opts.user }],
      ...(schema ? { response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema } } } : {}),
    }),
  });
  if (!response.ok) throw new Error(`${provider} request failed (${response.status}). Check your API key, model access, and quota in Settings.`);
  const data = await response.json();
  const candidate = data.candidates?.[0];
  const choice = data.choices?.[0];
  if (gemini ? candidate?.finishReason !== "STOP" : choice?.finish_reason !== "stop") throw new Error("The model did not return a complete answer. Try another model in Settings.");
  const text: string = gemini ? (candidate.content?.parts ?? []).filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text ?? "").join("\n") : choice.message?.content ?? "";
  if (!text.trim() || choice?.message?.refusal) throw new Error("The model returned no usable answer.");
  return { text, usage: { input_tokens: data.usage?.prompt_tokens ?? data.usageMetadata?.promptTokenCount ?? 0, output_tokens: data.usage?.completion_tokens ?? data.usageMetadata?.candidatesTokenCount ?? 0, cache_read_input_tokens: data.usage?.prompt_tokens_details?.cached_tokens ?? data.usageMetadata?.cachedContentTokenCount ?? 0, cache_creation_input_tokens: 0 } };
}
