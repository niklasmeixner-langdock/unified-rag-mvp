// Two-stage queue pipeline:
//   sync-source     → enumerate delta + enqueue process-document jobs (one per file)
//   process-document → fetch bytes + extract text + chunk + embed + upsert vectors
//
// The split decouples API enumeration cost from per-document embedding cost,
// and lets the per-document stage be rate-limited independently to protect
// OpenAI / Pinecone quotas.

import { createHash } from 'node:crypto';
import { Queue } from 'bullmq';
import { redis } from './connection.js';

export interface SyncSourceJobData {
  sourceId: string;
}

export interface ProcessDocumentJobData {
  sourceId: string;
  externalId: string;
  name: string;
  mimeType: string;
  contentVersion?: string;
  sourceUrl?: string;
  driveId: string;
}

// Completed/failed jobs must be evicted: an initial 4M-doc crawl would otherwise
// retain 4M job payloads in Redis indefinitely.
export const syncSourceQueue = new Queue<SyncSourceJobData>('sync-source', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { age: 24 * 3600 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
});

export const processDocumentQueue = new Queue<ProcessDocumentJobData>('process-document', {
  connection: redis,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { age: 3600, count: 10_000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
});

// Deterministic job ID so re-triggered syncs don't enqueue duplicates of jobs
// already waiting/active for the same document version. Hashed because BullMQ
// reserves ':' in custom job IDs and Graph item IDs are unconstrained.
export function docJobId(sourceId: string, externalId: string, contentVersion?: string): string {
  return createHash('sha1')
    .update(`${sourceId}\n${externalId}\n${contentVersion ?? ''}`)
    .digest('hex');
}
