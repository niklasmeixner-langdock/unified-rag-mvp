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

## Configuration

See `.env.example`. Required: Microsoft Entra app (client ID + secret + tenant ID), OpenAI API key, Pinecone API key + index, Postgres URL, Redis URL.

## License

Private — not yet licensed for external use.
