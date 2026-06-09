import { Pinecone } from '@pinecone-database/pinecone';
import { env } from '../env.js';

const client = new Pinecone({ apiKey: env.PINECONE_API_KEY });
export const index = client.index(env.PINECONE_INDEX).namespace(env.PINECONE_NAMESPACE);

export interface VectorRecord {
  id: string;
  values: number[];
  metadata: {
    sourceId: string;
    documentId: string;
    chunkIndex: number;
    text: string;
    name: string;
    sourceUrl?: string;
  };
}

export async function upsertVectors(records: VectorRecord[]): Promise<void> {
  if (records.length === 0) return;
  // Pinecone recommends batches of <=100 for upsert.
  for (let i = 0; i < records.length; i += 100) {
    await index.upsert(records.slice(i, i + 100));
  }
}

export async function deleteVectors(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await index.deleteMany(ids);
}

export interface QueryHit {
  id: string;
  score: number;
  metadata: VectorRecord['metadata'];
}

export async function queryVectors(vector: number[], topK: number): Promise<QueryHit[]> {
  const res = await index.query({ vector, topK, includeMetadata: true });
  return (res.matches ?? []).map((m) => ({
    id: m.id,
    score: m.score ?? 0,
    metadata: m.metadata as VectorRecord['metadata'],
  }));
}
