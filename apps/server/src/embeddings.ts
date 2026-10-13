import { EMBEDDING_DIMENSIONS } from "@nibblet/db";
import { z } from "zod";

/**
 * Turns text into vectors for memory search. Every backend must produce
 * `EMBEDDING_DIMENSIONS`-wide, normalised vectors, so switching backend
 * only means re-embedding, never a schema change.
 */
export interface Embedder {
  readonly name: string;
  embed(texts: string[], kind: "query" | "document"): Promise<number[][]>;
}

/** bge-small-en-v1.5 in-process via transformers.js. No container, no API key. */
function localEmbedder(cacheDir: string): Embedder {
  type Extractor = (
    texts: string[],
    options: { pooling: "cls"; normalize: true },
  ) => Promise<{ tolist(): number[][] }>;
  let extractor: Promise<Extractor> | null = null;
  const load = async (): Promise<Extractor> => {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = cacheDir;
    return pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { dtype: "q8" });
  };
  return {
    name: "local:bge-small-en-v1.5",
    async embed(texts, kind) {
      extractor ??= load();
      // bge models want this instruction on queries, and nothing on documents.
      const inputs =
        kind === "query"
          ? texts.map((t) => `Represent this sentence for searching relevant passages: ${t}`)
          : texts;
      const out = await (await extractor)(inputs, { pooling: "cls", normalize: true });
      return out.tolist();
    },
  };
}

const OllamaResponse = z.object({ embeddings: z.array(z.array(z.number())) });

function ollamaEmbedder(url: string, model = "all-minilm"): Embedder {
  return {
    name: `ollama:${model}`,
    async embed(texts) {
      const res = await fetch(`${url}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok) throw new Error(`Ollama embed failed: ${res.status}`);
      return OllamaResponse.parse(await res.json()).embeddings;
    },
  };
}

function teiEmbedder(url: string): Embedder {
  return {
    name: "tei",
    async embed(texts) {
      const res = await fetch(`${url}/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inputs: texts, normalize: true, truncate: true }),
      });
      if (!res.ok) throw new Error(`TEI embed failed: ${res.status}`);
      return z.array(z.array(z.number())).parse(await res.json());
    },
  };
}

export function createEmbedder(spec: string, dataDir: string): Embedder {
  const [kind, ...rest] = spec.split(":");
  const url = rest.join(":");
  const inner =
    kind === "ollama"
      ? ollamaEmbedder(url)
      : kind === "tei"
        ? teiEmbedder(url)
        : localEmbedder(`${dataDir}/models`);
  return {
    name: inner.name,
    async embed(texts, kindOf) {
      if (texts.length === 0) return [];
      const vectors = await inner.embed(texts, kindOf);
      for (const v of vectors) {
        if (v.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(
            `${inner.name} gave ${v.length} dimensions; nibblet stores ${EMBEDDING_DIMENSIONS}`,
          );
        }
      }
      return vectors;
    },
  };
}
