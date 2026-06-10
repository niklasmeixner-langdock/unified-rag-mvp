import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { env } from './env.js';
import { registerRoutes } from './api/routes.js';

const app = Fastify({ logger: { level: 'info' } });

await app.register(sensible);
await registerRoutes(app);

try {
  const address = await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info(`[boot] API listening at ${address}`);
} catch (err) {
  app.log.error(err, '[boot] listen failed');
  process.exit(1);
}
