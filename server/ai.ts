// Embeddings and optional metadata extraction through any OpenAI-compatible API.
// Defaults point at a local Ollama service so record text never leaves your servers.
import { config } from "./config.ts";

export async function embed(text: string): Promise<number[] | null> {
  const provider = config.embeddingProvider;
  if (provider === "none") return null;
  if (provider === "fake") return fakeEmbedding(text, config.embeddingDim);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.embeddingApiKey) headers.Authorization = `Bearer ${config.embeddingApiKey}`;
  try {
    const r = await fetch(`${config.embeddingApiBase}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: config.embeddingModel, input: text.slice(0, 32000) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) {
      console.error(`Embedding request failed: ${r.status} ${await r.text().catch(() => "")}`);
      return null;
    }
    const d = await r.json();
    const v: number[] = d?.data?.[0]?.embedding;
    if (!Array.isArray(v) || v.length !== config.embeddingDim) {
      console.error(`Embedding has ${v?.length ?? 0} dimensions; EMBEDDING_DIM is ${config.embeddingDim}`);
      return null;
    }
    return v;
  } catch (err) {
    // Records are still saved; `deno task reembed` fills missing embeddings later.
    console.error(`Embedding request failed: ${(err as Error).message}`);
    return null;
  }
}

export async function extractTags(text: string): Promise<Record<string, unknown>> {
  if (!config.metadataExtraction) return {};
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.llmApiKey) headers.Authorization = `Bearer ${config.llmApiKey}`;
  try {
    const r = await fetch(`${config.llmApiBase}/chat/completions`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        model: config.llmModel,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: 'Extract metadata from the note. Return JSON with "people" (array), "action_items" (array), "dates_mentioned" (YYYY-MM-DD array) and "topics" (1-3 short tags). Only extract what is explicitly there.',
          },
          { role: "user", content: text.slice(0, 16000) },
        ],
      }),
    });
    const d = await r.json();
    return JSON.parse(d.choices[0].message.content);
  } catch {
    return {};
  }
}

/** Deterministic unit vector for tests: similar text gives identical vectors, nothing leaves the machine. */
export function fakeEmbedding(text: string, dim: number): number[] {
  const v = new Array(dim).fill(0);
  for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 2166136261;
    for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
    v[Math.abs(h) % dim] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
