import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  API_KEY: z.string().min(16),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  MS_TENANT_ID: z.string().min(1),
  MS_CLIENT_ID: z.string().min(1),
  MS_CLIENT_SECRET: z.string().min(1),
  MS_OAUTH_REDIRECT_URI: z.string().url(),
  MS_OAUTH_SCOPES: z.string().default('Sites.Read.All Files.Read.All offline_access User.Read'),

  OPENAI_API_KEY: z.string().min(1),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),

  PINECONE_API_KEY: z.string().min(1),
  PINECONE_INDEX: z.string().min(1),
  PINECONE_NAMESPACE: z.string().min(1),

  SYNC_CRON: z.string().default('0 */2 * * *'),
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().positive().default(128),
  MAX_FILE_SIZE_MB: z.coerce.number().positive().default(50),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('[env] invalid environment variables:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export type Env = z.infer<typeof schema>;
