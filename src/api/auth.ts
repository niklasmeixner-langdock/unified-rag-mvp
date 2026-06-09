import type { FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../env.js';

export async function requireApiKey(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'missing bearer token' });
  }
  const token = header.slice('Bearer '.length).trim();
  if (token !== env.API_KEY) {
    return reply.code(401).send({ error: 'invalid api key' });
  }
}
