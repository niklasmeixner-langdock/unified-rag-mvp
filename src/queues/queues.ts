// Two-stage queue pipeline:
//   sync-source     → enumerate delta + enqueue process-document jobs (one per file)
//   process-document → fetch bytes + extract text + chunk + embed + upsert vectors
//
// The split decouples API enumeration cost from per-document embedding cost,
// and lets the per-document stage be rate-limited independently to protect
// OpenAI / Pinecone quotas.

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

export const syncSourceQueue = new Queue<SyncSourceJobData>('sync-source', {
  connection: redis,
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 30_000 } },
});

export const processDocumentQueue = new Queue<ProcessDocumentJobData>('process-document', {
  connection: redis,
  defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 10_000 } },
});
