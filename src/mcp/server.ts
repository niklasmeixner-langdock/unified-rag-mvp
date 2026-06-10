// MCP server exposing retrieval as a tool. Mounted at POST /mcp via the
// Streamable HTTP transport in stateless mode (see src/api/routes.ts), so
// remote MCP clients (e.g. Langdock integrations) can query the index.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { embedTexts } from '../pipeline/embed.js';
import { queryVectors } from '../pinecone/client.js';

// One instance per request — stateless transport, and the SDK's protocol
// layer holds per-connection state that must not be shared across requests.
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'unified-rag-mvp', version: '0.1.0' });

  server.registerTool(
    'search_documents',
    {
      title: 'Search documents',
      description:
        'Semantic search over the indexed document corpus (SharePoint / OneDrive). ' +
        'Call this whenever the answer depends on company documents or internal knowledge ' +
        'rather than general knowledge. Returns the most relevant text chunks with their ' +
        'source document name, link, and relevance score.',
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
      if (!vector) {
        return { content: [{ type: 'text' as const, text: 'No matching documents found.' }] };
      }
      const hits = await queryVectors(vector, topK ?? 10);
      if (hits.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No matching documents found.' }] };
      }
      return {
        content: hits.map((h) => ({
          type: 'text' as const,
          text:
            `Source: ${h.metadata.name}` +
            (h.metadata.sourceUrl ? ` (${h.metadata.sourceUrl})` : '') +
            ` — relevance ${h.score.toFixed(3)}\n${h.metadata.text}`,
        })),
      };
    },
  );

  return server;
}
