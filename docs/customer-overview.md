# SharePoint Knowledge Search: Customer Overview

This service makes the contents of your SharePoint document libraries searchable for AI assistants (for example in Langdock). Assistants can answer questions grounded in your internal documents, with links back to the original files.

It is built for large document estates: the architecture is designed to handle multi-million-document libraries with incremental updates, so your assistants stay current without re-processing everything.

## How it works

```
SharePoint (source of truth)
      │  read-only sync (Microsoft Graph)
      ▼
Ingestion pipeline:  extract text → split into chunks → create embeddings (OpenAI)
      ▼
Vector index (Pinecone)  +  document inventory (Postgres)
      ▲
      │  semantic search via MCP
AI assistant (e.g. Langdock)
```

Key properties:

- **SharePoint stays the source of truth.** The service never writes to SharePoint. Documents are added, updated, and removed in SharePoint as usual; the sync picks up the changes.
- **Incremental sync.** After the first full crawl, only new, changed, and deleted files are processed (using Microsoft's delta API and content versioning). Unchanged documents are never re-processed or re-billed.
- **Deletions propagate.** When a file is removed from SharePoint, its indexed content is removed from the search index on the next sync.
- **Managed from chat.** Browsing libraries, starting indexing, and checking sync status are available as assistant tools (MCP). The only step outside chat is a one-time Microsoft sign-in.

## What you need to provide

| Requirement | What it is for | Effort |
|---|---|---|
| Microsoft Entra app registration | Lets the service read SharePoint via Microsoft Graph (read-only scopes: `Sites.Read.All`, `Files.Read.All`) | One-time, ~10 minutes, admin consent may be required |
| One-time sign-in | A user with access to the relevant SharePoint sites consents in the browser; the service maintains access from then on | One click |
| OpenAI API key | Creates the text embeddings used for semantic search. No chat models are called; embeddings only | Account + key |
| Pinecone account + index | Stores the searchable vectors (dimension 1536, cosine metric) | Account + one index |
| Hosting (e.g. Railway) | Runs the API and the background sync worker, plus Postgres and Redis | Two small services + two managed add-ons |
| Service API key | A secret you generate; protects the search and admin endpoints | One `openssl rand -hex 32` |

## Where your data lives

| Store | Contents |
|---|---|
| SharePoint | Your documents. Never modified by this service. |
| Postgres | Document inventory: names, IDs, version tags, sync history. No document content. Also the Microsoft OAuth tokens. |
| Pinecone | Text chunks of indexed documents and their embedding vectors. This is the searchable copy of your content. |
| OpenAI | Receives chunk text transiently to compute embeddings. With an EU data residency project, all calls stay in the EU (`OPENAI_BASE_URL=https://eu.api.openai.com/v1`). |

## Using it from Langdock

Connect the service as an MCP integration (server URL `https://<your-host>/mcp`, auth header `Authorization: Bearer <service API key>`). Assistants then have these tools:

| Tool | What the assistant can do with it |
|---|---|
| `search_documents` | Answer questions from your indexed documents, with source links |
| `list_sharepoint_libraries` | Show which SharePoint libraries are available for indexing |
| `index_sharepoint_library` | Start indexing a library ("index the contracts library") |
| `list_sources` | Report what is indexed and whether syncs succeeded |
| `sync_source` | Refresh a library on demand |

Typical onboarding conversation: "What libraries do we have?" → "Index the Engineering wiki" → (sync runs in the background) → "What does our onboarding policy say about laptops?"

## Scale and cost expectations

- **Embedding cost** is the main variable cost: roughly $0.02 per million tokens with the default model. A multi-million-document initial crawl typically lands in the tens to low hundreds of dollars; after that, only changed documents incur cost.
- **Initial crawl time** depends on document count and configured rate limits. The pipeline is resumable: interruptions (rate limits, restarts) continue where they left off rather than starting over.
- **File handling:** PDF, Word (docx), and plain text/Markdown are extracted today. Files above a configurable size cap (default 50 MB) are skipped and reported.
- **Query cost** is negligible (one small embedding call per question).

## Current limitations (read before rollout)

- **No per-user permission trimming.** Search results reflect everything the indexed account could read. Anyone with access to the assistant/integration can find content from any indexed library, regardless of their own SharePoint permissions. Index only libraries whose content is appropriate for the whole audience of the assistant.
- **Library-level granularity.** Indexing is per document library; folder-level selection within a library is not yet available.
- **Supported formats.** PowerPoint, images, and scanned PDFs (OCR) are not extracted yet; such files are skipped and recorded.
- **Token storage.** Microsoft OAuth tokens are currently stored unencrypted in the service's database. Encryption at rest is planned before broader production use; until then, treat database access as sensitive.
- **Manual sync cadence.** Syncs are triggered on demand (via chat or API). Scheduled automatic syncs are planned.

## Ideas on the roadmap

- Scheduled background syncs (e.g. every 2 hours)
- Folder-level source scoping and file-type filters
- Permission-aware search (trim results to the asking user's SharePoint rights)
- Additional extractors (PPTX, OCR for scans)
- Additional sources beyond SharePoint/OneDrive via the same connector interface
