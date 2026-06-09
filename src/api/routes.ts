import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { syncSourceQueue } from '../queues/queues.js';
import { embedTexts } from '../pipeline/embed.js';
import { queryVectors } from '../pinecone/client.js';
import { buildAuthorizeUrl, exchangeAuthorizationCode } from '../connectors/sharepoint/oauth.js';
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
