// MCP server exposing retrieval + SharePoint source management as tools.
// Mounted at POST /mcp via the Streamable HTTP transport in stateless mode
// (see src/api/routes.ts), so remote MCP clients (e.g. Langdock) can query
// the index and manage what gets indexed, all from chat.
//
// The only step that cannot happen over MCP is the one-time Microsoft OAuth
// consent (browser flow at /oauth/start); every tool that needs Graph access
// picks up the most recent grant automatically.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { syncSourceQueue } from '../queues/queues.js';
import { embedTexts } from '../pipeline/embed.js';
import { queryVectors } from '../pinecone/client.js';
import { GraphClient } from '../connectors/sharepoint/graph.js';
import { getFreshAccessToken, getLatestTokenId } from '../connectors/sharepoint/tokens.js';

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

async function graphClient(): Promise<GraphClient> {
  const tokenId = await getLatestTokenId();
  return new GraphClient(await getFreshAccessToken(tokenId));
}

async function enqueueSync(sourceId: string): Promise<void> {
  await prisma.source.update({ where: { id: sourceId }, data: { syncStatus: 'PENDING' } });
  await syncSourceQueue.add('sync', { sourceId });
}

// One instance per request — stateless transport, and the SDK's protocol
// layer holds per-connection state that must not be shared across requests.
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'unified-rag-mvp', version: '0.1.0' });

  server.registerTool(
    'search_documents',
    {
      title: 'Search indexed documents',
      description:
        'Semantic search over the indexed SharePoint document corpus. Call this whenever the ' +
        'answer depends on company documents or internal knowledge rather than general ' +
        'knowledge. Returns the most relevant text chunks with their source document name, ' +
        'link, and relevance score.',
      inputSchema: {
        query: z.string().min(1).describe('Natural-language search query'),
        topK: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Number of chunks to return (default 10)'),
      },
    },
    async ({ query, topK }) => {
      const [vector] = await embedTexts([query]);
      if (!vector) return text('No matching documents found.');
      const hits = await queryVectors(vector, topK ?? 10);
      if (hits.length === 0) return text('No matching documents found.');
      // Metadata first: the count up top keeps the LLM from hallucinating it.
      return {
        content: [
          { type: 'text' as const, text: `${hits.length} matching chunks:` },
          ...hits.map((h) => ({
            type: 'text' as const,
            text:
              `Source: ${h.metadata.name}` +
              (h.metadata.sourceUrl ? ` (${h.metadata.sourceUrl})` : '') +
              `, relevance ${h.score.toFixed(3)}\n${h.metadata.text}`,
          })),
        ],
      };
    },
  );

  server.registerTool(
    'list_sharepoint_libraries',
    {
      title: 'List SharePoint document libraries',
      description:
        'Browse the SharePoint sites and document libraries visible to the connected Microsoft ' +
        'account. Call this when the user wants to see what could be indexed, or before ' +
        'index_sharepoint_library to find the driveId of the library to index. Do not call it ' +
        'for searching document contents; use search_documents for that.',
      inputSchema: {
        siteSearch: z
          .string()
          .optional()
          .describe('Filter sites by name, e.g. "Engineering" (default: list all sites)'),
      },
    },
    async ({ siteSearch }) => {
      const graph = await graphClient();
      const sites = await graph.searchSites(siteSearch ?? '*');
      if (sites.length === 0) return text('No SharePoint sites found for that search.');

      const lines: string[] = [];
      const inaccessible: string[] = [];
      for (const site of sites.slice(0, 15)) {
        let drives;
        try {
          drives = await graph.listSiteDrives(site.id);
        } catch {
          inaccessible.push(site.displayName ?? site.name ?? site.id);
          continue;
        }
        for (const drive of drives) {
          lines.push(
            `Site "${site.displayName ?? site.name ?? site.id}", library "${drive.name}"\n  driveId: ${drive.id}`,
          );
        }
      }
      if (lines.length === 0) return text('No accessible document libraries found.');

      // Metadata and notices before the data so they survive truncation.
      const header: string[] = [`${lines.length} document libraries:`];
      if (sites.length > 15) {
        header.push(`Notice: only the first 15 of ${sites.length} sites were checked; narrow with siteSearch.`);
      }
      if (inaccessible.length > 0) {
        header.push(`Notice: ${inaccessible.length} sites could not be read (${inaccessible.join(', ')}).`);
      }
      return text([...header, ...lines].join('\n'));
    },
  );

  server.registerTool(
    'index_sharepoint_library',
    {
      title: 'Index a SharePoint library',
      description:
        'Register a SharePoint document library for indexing and start its first sync. Call ' +
        'this when the user asks to index, add, or connect a SharePoint library. Get the ' +
        'driveId from list_sharepoint_libraries first; never guess it. Indexing large ' +
        'libraries runs in the background; use list_sources to check progress.',
      inputSchema: {
        driveId: z
          .string()
          .min(1)
          .describe('Drive ID of the document library, as returned by list_sharepoint_libraries'),
        label: z
          .string()
          .min(1)
          .describe('Human-readable name for this source, e.g. "Engineering wiki"'),
      },
    },
    async ({ driveId, label }) => {
      const oauthTokenId = await getLatestTokenId();
      const existing = await prisma.source.findFirst({
        where: { externalRef: { equals: { driveId } } },
      });
      if (existing) {
        return text(
          `This library is already indexed as "${existing.label}" (sourceId: ${existing.id}, status: ${existing.syncStatus}). Use sync_source to re-sync it.`,
        );
      }
      const source = await prisma.source.create({
        data: {
          connectorType: 'SHAREPOINT',
          label,
          externalRef: { driveId },
          oauthTokenId,
        },
      });
      await enqueueSync(source.id);
      return text(
        `Source "${label}" created (sourceId: ${source.id}) and initial sync started. Use list_sources to check progress.`,
      );
    },
  );

  server.registerTool(
    'list_sources',
    {
      title: 'List indexed sources',
      description:
        'List all registered SharePoint sources with their sync status, last sync time, and ' +
        'indexed document count. Call this when the user asks what is indexed, whether a sync ' +
        'finished, or why search results seem incomplete.',
      inputSchema: {},
    },
    async () => {
      const sources = await prisma.source.findMany({
        include: { _count: { select: { documents: true } } },
        orderBy: { createdAt: 'asc' },
      });
      if (sources.length === 0) {
        return text('No sources registered yet. Use index_sharepoint_library to add one.');
      }
      return text(
        [
          `${sources.length} sources:`,
          ...sources.map(
            (s) =>
              `"${s.label}" (sourceId: ${s.id})\n` +
              `  status: ${s.syncStatus}` +
              (s.syncMessage ? ` (${s.syncMessage})` : '') +
              `, documents: ${s._count.documents}` +
              `, last synced: ${s.lastSyncedAt?.toISOString() ?? 'never'}`,
          ),
        ].join('\n'),
      );
    },
  );

  server.registerTool(
    'sync_source',
    {
      title: 'Re-sync a source',
      description:
        'Start an incremental sync of an already-indexed SharePoint source, picking up new, ' +
        'changed, and deleted documents since the last sync. Call this when the user asks to ' +
        'refresh, re-index, or update a source. Get the sourceId from list_sources. Syncs run ' +
        'in the background.',
      inputSchema: {
        sourceId: z.string().uuid().describe('Source ID, as returned by list_sources'),
      },
    },
    async ({ sourceId }) => {
      const source = await prisma.source.findUnique({ where: { id: sourceId } });
      if (!source) return text(`No source with ID ${sourceId}. Use list_sources to see valid IDs.`);
      if (source.syncStatus === 'RUNNING' || source.syncStatus === 'PENDING') {
        return text(`Source "${source.label}" already has a sync ${source.syncStatus.toLowerCase()}.`);
      }
      await enqueueSync(sourceId);
      return text(`Sync started for "${source.label}". Use list_sources to check progress.`);
    },
  );

  return server;
}
