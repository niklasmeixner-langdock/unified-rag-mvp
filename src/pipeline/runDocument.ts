// End-to-end pipeline for one document: extract → chunk → embed → upsert.
// Provider-agnostic; takes a fetched Document and emits Pinecone vector IDs.

import type { Document } from '../connectors/Connector.js';
import { extractText, UnsupportedMimeError } from './extract.js';
import { chunkText } from './chunk.js';
import { embedTexts } from './embed.js';
import { upsertVectors, type VectorRecord } from '../pinecone/client.js';

export interface ProcessResult {
  vectorIds: string[];
  chunkCount: number;
}

export async function processDocument(
  doc: Document,
  ctx: { sourceId: string; documentId: string },
): Promise<ProcessResult> {
  let extracted;
  try {
    extracted = await extractText(doc);
  } catch (err) {
    if (err instanceof UnsupportedMimeError) {
      return { vectorIds: [], chunkCount: 0 };
    }
    throw err;
  }

  const chunks = chunkText(extracted.text, doc.name);
  if (chunks.length === 0) return { vectorIds: [], chunkCount: 0 };

  const vectors = await embedTexts(chunks.map((c) => c.text));

  const records: VectorRecord[] = chunks.map((chunk, i) => ({
    id: `${ctx.documentId}:${chunk.index}`,
    values: vectors[i]!,
    metadata: {
      sourceId: ctx.sourceId,
      documentId: ctx.documentId,
      chunkIndex: chunk.index,
      text: chunk.text,
      name: chunk.name,
      sourceUrl: doc.sourceUrl,
    },
  }));

  await upsertVectors(records);

  return {
    vectorIds: records.map((r) => r.id),
    chunkCount: records.length,
  };
}
