# Deploy runbook

Deploys the service to Railway as **two services** (API + worker) backed by
Railway-managed Postgres and Redis. Vectors live in Pinecone; Postgres holds
metadata/sync state only.

## 0. Prerequisites

- Railway account (this deploy: work-owned private instance)
- Access to the Azure AD (Microsoft Entra) tenant the documents live in
- OpenAI API key
- Pinecone account

## 1. Pinecone index

Create a serverless index **before** first deploy. The embedding model
`text-embedding-3-small` outputs **1536 dimensions**, so:

- Dimensions: `1536`
- Metric: `cosine`
- Note the index name → `PINECONE_INDEX`
- Pick a namespace for this customer → `PINECONE_NAMESPACE`

## 2. Microsoft Entra app registration

In the Azure portal → *App registrations* → *New registration*:

1. Name it (e.g. `unified-rag`).
2. Supported account types: single tenant.
3. **Redirect URI**: leave blank for now — added in step 6 once the Railway
   API URL exists. (Type will be *Web*.)
4. After creating, record:
   - *Application (client) ID* → `MS_CLIENT_ID`
   - *Directory (tenant) ID* → `MS_TENANT_ID`
5. *Certificates & secrets* → *New client secret* → record the **value** (not
   the ID) → `MS_CLIENT_SECRET`.
6. *API permissions* → add **Microsoft Graph → Delegated**:
   `Sites.Read.All`, `Files.Read.All`, `User.Read`, `offline_access`.
   Grant admin consent.

## 3. Railway project + datastores

1. New project → *Deploy from GitHub repo* → select `unified-rag-mvp`.
2. Railway detects `railway.json` (Dockerfile build). This first service is the
   **API**.
3. Add **Postgres** plugin (New → Database → PostgreSQL).
4. Add **Redis** plugin (New → Database → Redis).

## 4. API service env vars

On the API service → *Variables*. Reference the datastore vars Railway exposes:

```
PORT=3000
API_KEY=<the generated 32-byte hex secret>
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}

MS_TENANT_ID=<from step 2>
MS_CLIENT_ID=<from step 2>
MS_CLIENT_SECRET=<from step 2>
MS_OAUTH_REDIRECT_URI=<set in step 6 — placeholder for now>
MS_OAUTH_SCOPES=Sites.Read.All Files.Read.All offline_access User.Read

OPENAI_API_KEY=<your key>
OPENAI_EMBEDDING_MODEL=text-embedding-3-small

PINECONE_API_KEY=<your key>
PINECONE_INDEX=<from step 1>
PINECONE_NAMESPACE=<from step 1>

EMBEDDING_BATCH_SIZE=128
```

`env.ts` validates these on boot; the service won't start if any are missing.

## 5. Worker service

Add a **second service** in the same project, from the **same repo**:

1. New → *GitHub Repo* → same repo.
2. *Settings → Deploy → Start Command*: `node dist/queues/worker.js`
   (overrides the Dockerfile `CMD`, which defaults to the API server).
3. Remove the healthcheck path (worker has no HTTP server).
4. Copy the **same env vars** as the API service (it shares Postgres, Redis,
   OpenAI, Pinecone). It does not need to run migrations.

> Only the API service runs `prisma migrate deploy` (via the `railway.json`
> start command). Keep that off the worker to avoid concurrent-migration races.

## 6. Wire the OAuth redirect URI

1. After the API service's first successful deploy, copy its public URL
   (e.g. `https://unified-rag-api-production.up.railway.app`).
2. Set `MS_OAUTH_REDIRECT_URI=<API URL>/oauth/callback` on **both** services
   and redeploy.
3. In the Entra app → *Authentication* → add the same URL as a **Web**
   redirect URI.

## 7. OAuth onboarding (one-time, manual)

1. In a browser, visit `<API URL>/oauth/start` → sign in → consent.
2. The callback returns JSON with an `oauthTokenId`. Record it.

## 8. Register a source + sync

```bash
API=https://<api-url>
KEY=<API_KEY>

# Create the source (driveId-targeted)
curl -sS -X POST "$API/sources" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"connectorType":"SHAREPOINT","label":"Customer drive","driveId":"<DRIVE_ID>","oauthTokenId":"<from step 7>"}'

# Trigger a sync (enqueues; worker processes)
curl -sS -X POST "$API/sources/<source-id>/sync" -H "Authorization: Bearer $KEY"

# Check status
curl -sS "$API/sources/<source-id>" -H "Authorization: Bearer $KEY"
```

## 9. Query

```bash
curl -sS -X POST "$API/query" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"text":"your question","topK":10}'
```

## Notes / known gaps

- OAuth tokens are stored in plaintext in Postgres — encrypt at rest before
  handling production customer data.
- No cron scheduler yet; sync runs only when `/sources/:id/sync` is called.
- PPTX extraction is unsupported (typed skip).
- The local `pnpm install` workaround for a TLS-inspecting proxy
  (`NODE_EXTRA_CA_CERTS`) is **not needed on Railway** — its build network has
  no interception, so Node's bundled CAs validate the registry directly.
