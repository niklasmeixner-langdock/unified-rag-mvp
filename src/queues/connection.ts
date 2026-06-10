import { Redis } from 'ioredis';
import { env } from '../env.js';

// BullMQ requires maxRetriesPerRequest=null + enableReadyCheck=false on the connection.
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
