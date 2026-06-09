import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { env } from './env.js';
import { registerRoutes } from './api/routes.js';

const app = Fastify({ logger: { level: 'info' } });

await app.register(sensible);
await registerRoutes(app);

app.listen({ port: env.PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
