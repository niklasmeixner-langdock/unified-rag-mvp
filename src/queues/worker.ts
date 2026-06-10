// BullMQ worker entry point. Run with `pnpm worker`.

import { createServer } from 'node:http';
import { Worker } from 'bullmq';
import { redis } from './connection.js';
import {
  type SyncSourceJobData,
  type ProcessDocumentJobData,
  processDocumentQueue,
  docJobId,
} from './queues.js';
import { prisma } from '../db/client.js';
import {
  GraphClient,
  RateLimitError as GraphRateLimitError,
  FileTooLargeError,
} from '../connectors/sharepoint/graph.js';
import { SharePointConnector } from '../connectors/sharepoint/SharePointConnector.js';
import type { Connector } from '../connectors/Connector.js';
import { processDocument } from '../pipeline/runDocument.js';
import { getFreshAccessToken } from '../connectors/sharepoint/tokens.js';
import { deleteVectors } from '../pinecone/client.js';
import { env } from '../env.js';
import pino from 'pino';

const log = pino({ name: 'worker' });

const MAX_FILE_BYTES = env.MAX_FILE_SIZE_MB * 1024 * 1024;

async function getConnectorForSource(sourceId: string): Promise<Connector> {
  const source = await prisma.source.findUniqueOrThrow({ where: { id: sourceId } });
  if (!source.oauthTokenId) {
    throw new Error(`Source ${sourceId} has no oauthToken`);
  }

  const accessToken = await getFreshAccessToken(source.oauthTokenId);
  const graph = new GraphClient(accessToken, { maxDownloadBytes: MAX_FILE_BYTES });
  const externalRef = source.externalRef as { driveId: string };
  return new SharePointConnector(
    source.connectorType === 'SHAREPOINT' ? 'sharepoint' : 'onedrive',
    graph,
    { driveId: externalRef.driveId },
  );
}

const syncWorker = new Worker<SyncSourceJobData>(
  'sync-source',
  async (job) => {
    const { sourceId } = job.data;
    log.info({ sourceId }, 'sync-source: start');

    const source = await prisma.source.findUniqueOrThrow({ where: { id: sourceId } });
    await prisma.source.update({
      where: { id: sourceId },
      data: { syncStatus: 'RUNNING', syncMessage: null },
    });
    const run = await prisma.syncRun.create({
      data: { sourceId, status: 'RUNNING' },
    });

    let scanned = 0;
    let changed = 0;
    let skipped = 0;

    try {
      const connector = await getConnectorForSource(sourceId);
      const driveId = (source.externalRef as { driveId: string }).driveId;

      for await (const page of connector.syncDelta(source.deltaCursor ?? undefined)) {
        // Tombstone deleted documents: remove their vectors from Pinecone + DB.
        if (page.deleted.length > 0) {
          const tombstoned = await prisma.document.findMany({
            where: { sourceId, externalId: { in: page.deleted } },
            select: { id: true, vectorIds: true },
          });
          if (tombstoned.length > 0) {
            await deleteVectors(tombstoned.flatMap((d) => d.vectorIds));
            await prisma.document.deleteMany({
              where: { id: { in: tombstoned.map((d) => d.id) } },
            });
          }
        }

        // One round-trip per page instead of one findUnique per document —
        // at millions of documents the per-row variant dominates sync time.
        const existing = page.documents.length
          ? await prisma.document.findMany({
              where: { sourceId, externalId: { in: page.documents.map((d) => d.externalId) } },
              select: { externalId: true, contentVersion: true },
            })
          : [];
        const knownVersions = new Map(existing.map((d) => [d.externalId, d.contentVersion]));

        const jobs = [];
        for (const ref of page.documents) {
          scanned += 1;
          if (ref.sizeBytes !== undefined && ref.sizeBytes > MAX_FILE_BYTES) {
            skipped += 1;
            log.warn(
              { sourceId, externalId: ref.externalId, name: ref.name, sizeBytes: ref.sizeBytes },
              'sync-source: skipping oversized file',
            );
            continue;
          }
          if (
            knownVersions.has(ref.externalId) &&
            knownVersions.get(ref.externalId) === (ref.contentVersion ?? null)
          ) {
            continue;
          }
          changed += 1;
          jobs.push({
            name: 'process',
            data: {
              sourceId,
              externalId: ref.externalId,
              name: ref.name,
              mimeType: ref.mimeType,
              contentVersion: ref.contentVersion,
              sourceUrl: ref.sourceUrl,
              driveId,
            },
            opts: { jobId: docJobId(sourceId, ref.externalId, ref.contentVersion) },
          });
        }
        if (jobs.length > 0) await processDocumentQueue.addBulk(jobs);

        // Checkpoint cursor per page so we can resume on crash.
        await prisma.source.update({
          where: { id: sourceId },
          data: { deltaCursor: page.nextCursor },
        });
      }

      await prisma.source.update({
        where: { id: sourceId },
        data: { syncStatus: 'SUCCEEDED', lastSyncedAt: new Date() },
      });
      await prisma.syncRun.update({
        where: { id: run.id },
        data: {
          status: 'SUCCEEDED',
          finishedAt: new Date(),
          documentsScanned: scanned,
          documentsChanged: changed,
        },
      });
      log.info({ sourceId, scanned, changed, skipped }, 'sync-source: done');
    } catch (err) {
      // Graph throttled us. The cursor is checkpointed per page, so pause the
      // queue for the advertised window and re-queue without burning an attempt.
      if (err instanceof GraphRateLimitError) {
        log.warn({ sourceId, retryAfterSeconds: err.retryAfterSeconds }, 'sync-source: throttled');
        await prisma.syncRun.update({
          where: { id: run.id },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            error: 'Graph 429 — sync re-queued, will resume from cursor',
            documentsScanned: scanned,
            documentsChanged: changed,
          },
        });
        await syncWorker.rateLimit(err.retryAfterSeconds * 1000);
        throw Worker.RateLimitError();
      }

      const message = err instanceof Error ? err.message : String(err);
      await prisma.source.update({
        where: { id: sourceId },
        data: { syncStatus: 'FAILED', syncMessage: message },
      });
      await prisma.syncRun.update({
        where: { id: run.id },
        data: { status: 'FAILED', finishedAt: new Date(), error: message },
      });
      throw err;
    }
  },
  { connection: redis, concurrency: 2 },
);

const processWorker = new Worker<ProcessDocumentJobData>(
  'process-document',
  async (job) => {
    const { sourceId, externalId, name, mimeType, contentVersion, sourceUrl, driveId } = job.data;
    log.info({ sourceId, externalId, name }, 'process-document: start');

    const connector = await getConnectorForSource(sourceId);

    let fetched;
    try {
      fetched = await connector.fetchDocument({
        externalId,
        name,
        mimeType,
        contentVersion,
        sourceUrl,
        raw: { driveId },
      });
    } catch (err) {
      if (err instanceof GraphRateLimitError) {
        log.warn({ sourceId, externalId, retryAfterSeconds: err.retryAfterSeconds }, 'process-document: throttled');
        await processWorker.rateLimit(err.retryAfterSeconds * 1000);
        throw Worker.RateLimitError();
      }
      // Oversized files are a permanent skip, not a failure: record and complete.
      if (err instanceof FileTooLargeError) {
        await prisma.document.upsert({
          where: { sourceId_externalId: { sourceId, externalId } },
          create: {
            sourceId,
            externalId,
            name,
            mimeType,
            sourceUrl,
            contentVersion,
            vectorIds: [],
            error: err.message,
          },
          update: { name, mimeType, sourceUrl, contentVersion, error: err.message },
        });
        log.warn({ sourceId, externalId, name, sizeBytes: err.sizeBytes }, 'process-document: skipped oversized file');
        return;
      }
      throw err;
    }

    // Upsert document row first so we have a stable documentId for vector IDs.
    const doc = await prisma.document.upsert({
      where: { sourceId_externalId: { sourceId, externalId } },
      create: {
        sourceId,
        externalId,
        name,
        mimeType,
        sourceUrl,
        contentVersion,
        vectorIds: [],
      },
      update: { name, mimeType, sourceUrl, contentVersion, error: null },
    });

    // If we're replacing existing chunks, delete old vectors first.
    if (doc.vectorIds.length > 0) {
      await deleteVectors(doc.vectorIds);
    }

    try {
      const result = await processDocument(fetched, { sourceId, documentId: doc.id });
      await prisma.document.update({
        where: { id: doc.id },
        data: {
          vectorIds: result.vectorIds,
          extractedAt: new Date(),
          embeddedAt: new Date(),
        },
      });
      log.info({ documentId: doc.id, chunks: result.chunkCount }, 'process-document: done');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.document.update({
        where: { id: doc.id },
        data: { error: message },
      });
      throw err;
    }
  },
  {
    connection: redis,
    concurrency: 4,
    // Leaky-bucket rate limit: 60 process-document jobs per minute.
    // Tune to stay under OpenAI embeddings RPM + Pinecone upsert limits.
    limiter: { max: 60, duration: 60_000 },
  },
);

// Minimal liveness endpoint so the worker can run behind the same Railway
// healthcheck config as the API.
createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(env.PORT, '0.0.0.0', () => {
  log.info(`[boot] worker health endpoint listening on :${env.PORT}`);
});

log.info('Workers started: sync-source, process-document');
