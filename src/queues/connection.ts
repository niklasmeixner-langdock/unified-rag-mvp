import { Redis } from 'ioredis';
import { env } from '../env.js';

// BullMQ requires maxRetriesPerRequest=null + enableReadyCheck=false on the connection.
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// ioredis retries forever (good); without a listener each failed attempt dumps
// a full AggregateError stack to stderr. Keep it to one line per attempt.
redis.on('error', (err) => {
  console.error(`[redis] connection error: ${err.message}`);
});
