// Batched OpenAI embeddings. Batch size is configurable via EMBEDDING_BATCH_SIZE
// (default 128) — kept under OpenAI's per-request limit while amortizing HTTP overhead.

import OpenAI from 'openai';
import { env } from '../env.js';

const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const batchSize = env.EMBEDDING_BATCH_SIZE;
  const all: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const res = await client.embeddings.create({
      model: env.OPENAI_EMBEDDING_MODEL,
      input: batch,
    });
    for (const row of res.data) all.push(row.embedding);
  }
  return all;
}
