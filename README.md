# unified-rag-mvp

Standalone document ingestion + retrieval service. Pulls documents from configured sources (initial connector: Microsoft SharePoint), extracts text, embeds with OpenAI, stores vectors in Pinecone, and exposes the result to AI assistants via MCP (plus a plain `/query` endpoint).

For a non-technical introduction (what it does, requirements, data flow, limitations), see [docs/customer-overview.md](docs/customer-overview.md).

## Local setup

```bash
cp .env.example .env   # fill in MS app credentials, OpenAI key, Pinecone key
pnpm install
docker compose up -d   # postgres + redis
pnpm prisma:generate
pnpm prisma:migrate    # create tables
pnpm dev               # terminal A: API server
pnpm worker            # terminal B: sync worker
```

Onboarding:

1. Visit `http://localhost:3000/oauth/start` in a browser and consent against the target Microsoft tenant.
2. Everything else works through the MCP tools (or the REST API): list libraries, index one, search.
3. `GET /oauth/whoami` shows which Microsoft account the service is acting as.

## Architecture

```
HTTP API (Fastify)        BullMQ Workers           Storage
─────────────────         ────────────────         ───────
POST /mcp           ──→   sync-source     ──┐
POST /sources            ↳ delta list        │
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

Two processes from one codebase, selected via `PROCESS_TYPE`:

| `PROCESS_TYPE` | Role | Entry behavior |
|---|---|---|
| unset / `server` | HTTP API (MCP, REST, OAuth) | Serves on `PORT`, healthcheck at `/health` |
| `worker` | Background sync (download, extract, embed, upsert) | Also serves `/health` on `PORT` for liveness |

## Deployment (any platform)

The service is a standard containerized Node app; nothing is tied to a specific host. You need:

- A way to run **two long-lived processes** from the same image (Docker, Kubernetes, Fly.io, Render, Railway, a VM with systemd, ...): one with `PROCESS_TYPE=server` (expose `PORT`), one with `PROCESS_TYPE=worker` (no public exposure needed)
- **Postgres** and **Redis** reachable from both
- The environment variables from `.env.example` set on both processes
- `pnpm prisma migrate deploy` executed against the database before (or at) each release
- A public HTTPS URL for the API process; register `https://<host>/oauth/callback` as a redirect URI on the Entra app and set it as `MS_OAUTH_REDIRECT_URI`

The provided `Dockerfile` builds the image; the default command runs the server. Example with plain Docker:

```bash
docker build -t unified-rag .
docker run --env-file .env -e PROCESS_TYPE=server -p 3000:3000 unified-rag
docker run --env-file .env -e PROCESS_TYPE=worker unified-rag
```

`railway.json` contains a working example configuration for Railway (build from Dockerfile, migrations as pre-deploy command, healthcheck on `/health`); translate the same three settings to whatever platform you use.

## MCP integration

The service exposes an MCP server at `POST /mcp` (Streamable HTTP, stateless). Apart from the one-time OAuth consent in a browser, everything is operable from an MCP client:

| Tool | Purpose |
|---|---|
| `search_documents` | Semantic search over the indexed corpus (same path as `/query`) |
| `list_sharepoint_libraries` | Browse sites/libraries of the connected account, find driveIds |
| `index_sharepoint_library` | Register a library and start its first sync |
| `list_sources` | Show indexed sources, sync status, document counts |
| `sync_source` | Trigger an incremental re-sync |

To connect from an MCP client (e.g. Langdock: Integrations → MCP → add server): endpoint `https://<host>/mcp`, auth via custom header `Authorization: Bearer <API_KEY>`. A connection test should list the five tools.

## Query API contract

```
POST /query
Authorization: Bearer <API_KEY>
Content-Type: application/json

{ "text": "your search query", "topK": 10 }

→ { "chunks": [{ "text": "...", "sourceName": "...", "sourceUrl": "...", "score": 0.87 }] }
```

## Configuration

See `.env.example`. Required: Microsoft Entra app (client ID + secret + tenant ID), OpenAI API key, Pinecone API key + index (dimension 1536, cosine, for the default embedding model), Postgres URL, Redis URL.

Note for OpenAI projects with EU data residency: set `OPENAI_BASE_URL=https://eu.api.openai.com/v1`.

## Credentials: who authenticates to whom

Three separate layers; don't conflate them:

| Credential | Direction | Purpose |
|---|---|---|
| `API_KEY` | Client (e.g. Langdock) → this service | Protects `/query`, `/sources`, `/mcp`. **Not issued by any provider**: generate it yourself (`openssl rand -hex 32`) and set the same value in the service env and in the client's auth config (`Authorization: Bearer <key>`). |
| Entra app (`MS_TENANT_ID` / `MS_CLIENT_ID` / `MS_CLIENT_SECRET`) + OAuth consent | This service → SharePoint | Ingestion only. One browser consent via `/oauth/start`; the refresh token is stored in Postgres and refreshed automatically. Query clients never touch SharePoint. |
| `OPENAI_API_KEY`, `PINECONE_API_KEY`, `DATABASE_URL`, `REDIS_URL` | This service → providers | Plain env vars, set on **both** processes (server and worker). |

### What the OpenAI key is for

Embeddings only (`OPENAI_EMBEDDING_MODEL`, default `text-embedding-3-small`); this service never calls a chat/completion model. Answer generation happens in the consumer (e.g. the assistant). Two call sites:

1. **Ingestion**: every chunk is embedded once before the Pinecone upsert. Bulk of the spend; eTag dedup ensures unchanged docs are never re-embedded.
2. **Query time**: one tiny embedding request per `/query` / `search_documents` call.

At ~$0.02 per 1M tokens, an initial multi-million-document crawl typically lands in the tens-to-low-hundreds of dollars; steady state is near zero.

⚠️ **The embedding model is baked into the index.** Vectors from different models aren't comparable; switching models later means re-embedding the entire corpus. Decide (e.g. `text-embedding-3-small` vs `-3-large`, ~6× cost, better retrieval) **before** the initial crawl.

## Connector interface

The provider-agnostic ingestion contract. To add a new source, implement `src/connectors/Connector.ts`; the downstream pipeline does not change.

## License

Private; not yet licensed for external use.
