# unified-rag-mvp

Standalone document ingestion + retrieval service. Pulls documents from configured sources (initial connector: Microsoft SharePoint / OneDrive), extracts text, embeds with OpenAI, stores vectors in Pinecone, and exposes a `/query` endpoint for downstream consumers.

## Status

Scaffold. Not yet end-to-end tested against a live tenant.

## Local setup

```bash
cp .env.example .env   # fill in MS app credentials, OpenAI key, Pinecone key
pnpm install
docker compose up -d   # postgres + redis
pnpm prisma:generate
pnpm prisma:migrate    # create tables
pnpm dev               # terminal A — API server
pnpm worker            # terminal B — BullMQ worker
```

OAuth onboarding:

1. Visit `http://localhost:3000/oauth/start` in a browser.
2. Consent against the target Microsoft tenant.
3. The callback returns an `oauthTokenId`.
4. `POST /sources` with `{ connectorType, label, driveId, oauthTokenId }`.
5. `POST /sources/:id/sync` to kick off ingestion.

## Architecture

```
HTTP API (Fastify)        BullMQ Workers           Storage
─────────────────         ────────────────         ───────
POST /sources       ──→   sync-source     ──┐
POST /sources/:id        ↳ delta list        │
POST /query              ↳ enqueue per-doc   │     Postgres:
                         process-document    │      - sources
                         ↳ fetch bytes       │      - documents
                         ↳ extract           │      - oauth_tokens
                         ↳ chunk             │      - sync_runs
                         ↳ embed (OpenAI)    │
                         ↳ upsert Pinecone ──┘     Pinecone:
                                                    - chunk vectors
                                                    - chunk metadata
```

## Connector interface

The provider-agnostic ingestion contract. To add a new source, implement `src/connectors/Connector.ts`; the downstream pipeline does not change.

## Query API contract

```
POST /query
Authorization: Bearer <API_KEY>
Content-Type: application/json

{ "text": "your search query", "topK": 10 }

→ { "chunks": [{ "text": "...", "sourceName": "...", "sourceUrl": "...", "score": 0.87 }] }
```

## MCP integration (Langdock etc.)

The service exposes an MCP server at `POST /mcp` (Streamable HTTP, stateless) with a
`search_documents` tool wrapping the same retrieval path as `/query`.

To connect from Langdock: **Integrations → MCP → add server**, enter
`https://<host>/mcp` as the endpoint, choose API-key / custom-header auth, and send
`Authorization: Bearer <API_KEY>`. "Test connection" should list the
`search_documents` tool.

## Configuration

See `.env.example`. Required: Microsoft Entra app (client ID + secret + tenant ID), OpenAI API key, Pinecone API key + index, Postgres URL, Redis URL.

## Credentials — who authenticates to whom

Three separate layers; don't conflate them:

| Credential | Direction | Purpose |
|---|---|---|
| `API_KEY` | Client (e.g. Langdock) → this service | Protects `/query`, `/sources`, `/mcp`. **Not issued by any provider** — generate it yourself (`openssl rand -hex 32`) and set the same value in the service env and in the client's auth config (`Authorization: Bearer <key>`). A Langdock API key does NOT work here — that authenticates you to Langdock's API, the wrong direction. |
| Entra app (`MS_TENANT_ID` / `MS_CLIENT_ID` / `MS_CLIENT_SECRET`) + OAuth consent | This service → SharePoint | Ingestion only. One browser consent via `/oauth/start`; the refresh token is stored in Postgres and refreshed automatically. Query clients never touch SharePoint. |
| `OPENAI_API_KEY`, `PINECONE_API_KEY`, `DATABASE_URL`, `REDIS_URL` | This service → providers | Plain env vars. On Railway, set them on **both** services (API and worker). |

### What the OpenAI key is for

Embeddings only (`OPENAI_EMBEDDING_MODEL`, default `text-embedding-3-small`) — this service never calls a chat/completion model. Answer generation happens in the consumer (e.g. the Langdock assistant). Two call sites:

1. **Ingestion** — every chunk is embedded once before the Pinecone upsert. Bulk of the spend; eTag dedup ensures unchanged docs are never re-embedded.
2. **Query time** — one tiny embedding request per `/query` / `search_documents` call.

At ~$0.02 per 1M tokens, an initial multi-million-document crawl typically lands in the tens-to-low-hundreds of dollars; steady state is near zero.

⚠️ **The embedding model is baked into the index.** Vectors from different models aren't comparable — switching models later means re-embedding the entire corpus. Decide (e.g. `text-embedding-3-small` vs `-3-large`, ~6× cost, better retrieval) **before** the initial crawl.

## License

Private — not yet licensed for external use.
