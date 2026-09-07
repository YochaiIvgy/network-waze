import { createHash } from "node:crypto";
import { env } from "./env";

export const EMBEDDING_DIM = env.embeddingProvider === "voyage" ? 1024 : 512;

/**
 * Two providers behind one seam.
 *
 * `hash` is a deterministic character-n-gram hashing embedding. It is genuinely
 * useful — it captures lexical overlap, which is most of what entity resolution
 * needs — and it costs nothing, so the demo and the test suite run offline.
 * `voyage` is the real semantic embedding, used when a key is present.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (env.embeddingProvider === "voyage" && env.voyageApiKey) {
    return embedVoyage(texts);
  }
  return texts.map(hashEmbed);
}

export async function embedOne(text: string): Promise<number[]> {
  return (await embed([text]))[0];
}

async function embedVoyage(texts: string[]): Promise<number[][]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.voyageApiKey}`,
    },
    body: JSON.stringify({ model: "voyage-3", input: texts, input_type: "document" }),
  });
  if (!res.ok) {
    throw new Error(`Voyage embeddings failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
  const out = new Array<number[]>(texts.length);
  for (const row of json.data) out[row.index] = row.embedding;
  return out;
}

/** Hashed trigrams + word unigrams, L2-normalised. */
function hashEmbed(text: string): number[] {
  const vec = new Array<number>(EMBEDDING_DIM).fill(0);
  const clean = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return vec;

  const add = (token: string, weight: number) => {
    const h = createHash("md5").update(token).digest();
    const idx = h.readUInt32LE(0) % EMBEDDING_DIM;
    const sign = h[4] & 1 ? 1 : -1;
    vec[idx] += sign * weight;
  };

  for (const word of clean.split(" ")) {
    if (word.length < 2) continue;
    add(`w:${word}`, 1);
    for (let i = 0; i <= word.length - 3; i++) add(`t:${word.slice(i, i + 3)}`, 0.4);
  }

  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? vec.map((v) => v / norm) : vec;
}

export function cosine(a: number[] | null, b: number[] | null): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
