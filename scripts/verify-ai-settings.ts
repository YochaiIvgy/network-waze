import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { aiConfig, publicSettings, resolveApiKey, saveSettings, settingsUpdate } from "../src/lib/ai-settings";
import { listProviderModels } from "../src/lib/ai-models";
import { callStructured, callText } from "../src/lib/anthropic";

async function main() {
  const directory = mkdtempSync(join(tmpdir(), "waze-settings-test-"));
  process.env.WAZE_SETTINGS_DIR = directory;
  const originalFetch = globalThis.fetch;
  try {
    saveSettings({ provider: "openai", model: "test-model", apiKey: "test-secret" });
    assert.equal(aiConfig().apiKey, "test-secret");
    assert.ok(!JSON.stringify(publicSettings()).includes("test-secret"));
    saveSettings({ provider: "openai", model: "second-model", apiKey: "" });
    assert.equal(aiConfig().apiKey, "test-secret");
    assert.equal(aiConfig().model, "second-model");
    assert.equal(settingsUpdate.safeParse({ provider: "invalid", model: "x" }).success, false);
    assert.equal(resolveApiKey("openai"), "test-secret");
    assert.equal(resolveApiKey("openai", "override-key"), "override-key");
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.includes("api.anthropic.com")) {
        return Response.json({ data: [
          { id: "claude-opus-5", display_name: "Claude Opus 5", capabilities: { structured_outputs: { supported: true } } },
          { id: "claude-no-json", display_name: "No JSON", capabilities: { structured_outputs: { supported: false } } },
        ], has_more: false });
      }
      if (href.includes("api.openai.com/v1/models")) {
        return Response.json({ data: [
          { id: "gpt-4.1", created: 20 },
          { id: "text-embedding-3-large", created: 30 },
          { id: "gpt-4o-audio-preview", created: 25 },
          { id: "whisper-1", created: 10 },
        ] });
      }
      assert.ok(href.includes("generativelanguage.googleapis.com"));
      return Response.json({ models: [
        { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/text-embedding-004", displayName: "Embeddings", supportedGenerationMethods: ["embedContent"] },
      ] });
    };
    assert.deepEqual(await listProviderModels("anthropic", "test-secret"), [{ id: "claude-opus-5", label: "Claude Opus 5" }]);
    assert.deepEqual(await listProviderModels("openai", "test-secret"), [{ id: "gpt-4.1", label: "gpt-4.1" }]);
    assert.deepEqual(await listProviderModels("gemini", "test-secret"), [{ id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" }]);
    globalThis.fetch = async () => new Response("test-secret", { status: 401 });
    await assert.rejects(() => listProviderModels("openai", "test-secret"), error => error instanceof Error && error.message.includes("rejected") && !error.message.includes("test-secret"));
    for (const provider of ["openai", "gemini"] as const) {
      saveSettings({ provider, model: "test-model", apiKey: "test-secret" });
      globalThis.fetch = async (url, options) => {
        const body = JSON.parse(options!.body as string);
        if (provider === "openai") {
          assert.ok(String(url).includes("api.openai.com"));
          assert.equal(body.response_format.json_schema.strict, true);
          return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"name":"Ada"}' } }], usage: { prompt_tokens: 7, completion_tokens: 4 } });
        }
        assert.ok(String(url).includes("generativelanguage.googleapis.com"));
        assert.equal(body.generationConfig.responseMimeType, "application/json");
        return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"name":"Ada"}' }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4 } });
      };
      const result = await callStructured({ system: "Extract", user: "Ada", schema: z.object({ name: z.string() }) });
      assert.deepEqual(result.data, { name: "Ada" });
      assert.equal(result.usage.input_tokens, 7);
      globalThis.fetch = async () => Response.json(provider === "openai" ? { choices: [{ finish_reason: "stop", message: { content: '{"name":42}' } }] } : { candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"name":42}' }] } }] });
      await assert.rejects(() => callStructured({ system: "Extract", user: "Ada", schema: z.object({ name: z.string() }) }));
      globalThis.fetch = async () => new Response("test-secret", { status: 401 });
      await assert.rejects(() => callText({ system: "Hi", user: "Hi" }), error => error instanceof Error && error.message.includes("401") && !error.message.includes("test-secret"));
    }
    saveSettings({ provider: "openai", model: "test-model", removeKey: true });
    assert.notEqual(publicSettings().providers.openai.source, "saved");
    assert.equal(publicSettings().providers.gemini.source, "saved");
    console.log("AI settings and provider adapter checks passed.");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.WAZE_SETTINGS_DIR;
    rmSync(directory, { recursive: true, force: true });
  }
}
void main();
