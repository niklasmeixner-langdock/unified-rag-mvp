import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { buildMcpServer } from '../mcp/server.js';
import { prisma } from '../db/client.js';
import { syncSourceQueue } from '../queues/queues.js';
import { embedTexts } from '../pipeline/embed.js';
import { queryVectors } from '../pinecone/client.js';
import { buildAuthorizeUrl, exchangeAuthorizationCode } from '../connectors/sharepoint/oauth.js';
import { GraphClient } from '../connectors/sharepoint/graph.js';
import { getFreshAccessToken, getLatestTokenId } from '../connectors/sharepoint/tokens.js';
import { env } from '../env.js';
import { requireApiKey } from './auth.js';

const CreateSourceBody = z.object({
  connectorType: z.enum(['SHAREPOINT', 'ONEDRIVE']),
  label: z.string().min(1),
  driveId: z.string().min(1),
  oauthTokenId: z.string().uuid(),
});

const QueryBody = z.object({
  text: z.string().min(1),
  topK: z.number().int().min(1).max(50).default(10),
});

export async function registerRoutes(app: FastifyInstance) {
  // Health check — no auth.
  app.get('/health', async () => ({ ok: true }));

  // --- OAuth (manual, single-tenant flow; no auth required on these endpoints) ---
  // Hit /oauth/start in a browser; it redirects to Microsoft and back to /oauth/callback.

  app.get('/oauth/start', async (_req, reply) => {
    const state = crypto.randomUUID();
    const url = buildAuthorizeUrl({
      scope: env.MS_OAUTH_SCOPES,
      redirectUrl: env.MS_OAUTH_REDIRECT_URI,
      state,
    });
    return reply.redirect(url);
  });

  app.get<{ Querystring: { code?: string; error?: string } }>('/oauth/callback', async (req, reply) => {
    const { code, error } = req.query;
    if (error) return reply.code(400).send({ error });
    if (!code) return reply.code(400).send({ error: 'missing code' });

    const tokens = await exchangeAuthorizationCode({
      code,
      redirectUrl: env.MS_OAUTH_REDIRECT_URI,
    });
    const saved = await prisma.oAuthToken.create({
      data: {
        provider: 'microsoft',
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        scope: tokens.scope,
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      },
    });
    return { oauthTokenId: saved.id, scope: saved.scope };
  });

  // --- API-key-protected endpoints ---

  app.register(async (instance) => {
    instance.addHook('onRequest', requireApiKey);

    instance.post('/sources', async (req, reply) => {
      const body = CreateSourceBody.parse(req.body);
      const source = await prisma.source.create({
        data: {
          connectorType: body.connectorType,
          label: body.label,
          externalRef: { driveId: body.driveId },
          oauthTokenId: body.oauthTokenId,
        },
      });
      return reply.code(201).send({ id: source.id });
    });

    instance.post<{ Params: { id: string } }>('/sources/:id/sync', async (req) => {
      const { id } = req.params;
      await prisma.source.findUniqueOrThrow({ where: { id } });
      await prisma.source.update({ where: { id }, data: { syncStatus: 'PENDING' } });
      const job = await syncSourceQueue.add('sync', { sourceId: id });
      return { jobId: job.id };
    });

    instance.get<{ Params: { id: string } }>('/sources/:id', async (req) => {
      const source = await prisma.source.findUniqueOrThrow({
        where: { id: req.params.id },
        include: { _count: { select: { documents: true } } },
      });
      return source;
    });

    // Which Microsoft account the service is acting as (most recent OAuth grant).
    instance.get('/oauth/whoami', async () => {
      const tokenId = await getLatestTokenId();
      const token = await prisma.oAuthToken.findUniqueOrThrow({ where: { id: tokenId } });
      const graph = new GraphClient(await getFreshAccessToken(tokenId));
      const me = await graph.getMe();
      return {
        displayName: me.displayName,
        userPrincipalName: me.userPrincipalName,
        mail: me.mail,
        scope: token.scope,
        grantedAt: token.createdAt,
      };
    });

    // --- MCP endpoint (Streamable HTTP, stateless) ---
    // Remote MCP clients (e.g. Langdock integrations) connect here with
    // `Authorization: Bearer <API_KEY>` and get the search_documents tool.

    instance.post('/mcp', async (req, reply) => {
      const server = buildMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless — no session tracking
        enableJsonResponse: true,
      });
      reply.raw.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      // The SDK writes to the raw response, so take it out of Fastify's hands.
      reply.hijack();
      try {
        await transport.handleRequest(req.raw, reply.raw, req.body);
      } catch (err) {
        req.log.error({ err }, 'mcp request failed');
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { 'content-type': 'application/json' });
          reply.raw.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal server error' },
              id: null,
            }),
          );
        }
      }
    });

    // Stateless server: no SSE stream to resume (GET), no session to end (DELETE).
    const mcpMethodNotAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
      reply.code(405).send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed' },
        id: null,
      });
    instance.get('/mcp', mcpMethodNotAllowed);
    instance.delete('/mcp', mcpMethodNotAllowed);

    // Retrieval endpoint — accepts a text query, returns top-k matching chunks.
    instance.post('/query', async (req) => {
      const body = QueryBody.parse(req.body);
      const [vector] = await embedTexts([body.text]);
      if (!vector) return { chunks: [] };
      const hits = await queryVectors(vector, body.topK);
      return {
        chunks: hits.map((h) => ({
          text: h.metadata.text,
          sourceName: h.metadata.name,
          sourceUrl: h.metadata.sourceUrl,
          score: h.score,
        })),
      };
    });
  });
}
