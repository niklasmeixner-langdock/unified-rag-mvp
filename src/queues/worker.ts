// BullMQ worker entry point. Run with `pnpm worker`.

import { Worker } from 'bullmq';
import { redis } from './connection.js';
import {
  type SyncSourceJobData,
  type ProcessDocumentJobData,
  processDocumentQueue,
} from './queues.js';
import { prisma } from '../db/client.js';
import { GraphClient } from '../connectors/sharepoint/graph.js';
import { SharePointConnector } from '../connectors/sharepoint/SharePointConnector.js';
import type { Connector } from '../connectors/Connector.js';
import { processDocument } from '../pipeline/runDocument.js';
import { refreshAccessToken } from '../connectors/sharepoint/oauth.js';
import { deleteVectors } from '../pinecone/client.js';
import pino from 'pino';

const log = pino({ name: 'worker' });

async function getConnectorForSource(sourceId: string): Promise<Connector> {
  const source = await prisma.source.findUniqueOrThrow({
    where: { id: sourceId },
    include: { oauthToken: true },
  });
  if (!source.oauthToken) {
    throw new Error(`Source ${sourceId} has no oauthToken`);
  }

  // Refresh if within 5 minutes of expiry.
  // TODO: encrypt tokens at rest before any non-local deployment.
  let accessToken = source.oauthToken.accessToken;
  if (source.oauthToken.expiresAt.getTime() - Date.now() < 5 * 60_000) {
    const refreshed = await refreshAccessToken(source.oauthToken.refreshToken);
    accessToken = refreshed.access_token;
    await prisma.oAuthToken.update({
      where: { id: source.oauthToken.id },
      data: {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token ?? source.oauthToken.refreshToken,
        expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
      },
    });
  }

  const graph = new GraphClient(accessToken);
  const externalRef = source.externalRef as { driveId: string };
  return new SharePointConnector(
    source.connectorType === 'SHAREPOINT' ? 'sharepoint' : 'onedrive',
    graph,
    { driveId: externalRef.driveId },
  );
}

new Worker<SyncSourceJobData>(
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

    try {
      const connector = await getConnectorForSource(sourceId);
      const driveId = (source.externalRef as { driveId: string }).driveId;

      for await (const page of connector.syncDelta(source.deltaCursor ?? undefined)) {
        // Tombstone deleted documents: remove their vectors from Pinecone + DB.
        for (const externalId of page.deleted) {
          const doc = await prisma.document.findUnique({
            where: { sourceId_externalId: { sourceId, externalId } },
          });
          if (doc) {
            await deleteVectors(doc.vectorIds);
            await prisma.document.delete({ where: { id: doc.id } });
          }
        }

        for (const ref of page.documents) {
          scanned += 1;
          const existing = await prisma.document.findUnique({
            where: { sourceId_externalId: { sourceId, externalId: ref.externalId } },
          });
          if (existing && existing.contentVersion === ref.contentVersion) continue;
          changed += 1;
          await processDocumentQueue.add('process', {
            sourceId,
            externalId: ref.externalId,
            name: ref.name,
            mimeType: ref.mimeType,
            contentVersion: ref.contentVersion,
            sourceUrl: ref.sourceUrl,
            driveId,
          });
        }

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
      log.info({ sourceId, scanned, changed }, 'sync-source: done');
    } catch (err) {
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

new Worker<ProcessDocumentJobData>(
  'process-document',
  async (job) => {
    const { sourceId, externalId, name, mimeType, contentVersion, sourceUrl, driveId } = job.data;
    log.info({ sourceId, externalId, name }, 'process-document: start');

    const connector = await getConnectorForSource(sourceId);
    const fetched = await connector.fetchDocument({
      externalId,
      name,
      mimeType,
      contentVersion,
      sourceUrl,
      raw: { driveId },
    });

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

log.info('Workers started: sync-source, process-document');
