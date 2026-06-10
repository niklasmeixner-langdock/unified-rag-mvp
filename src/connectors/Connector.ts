// Provider-agnostic ingestion interface. Concrete implementations encapsulate
// auth and API details; the downstream extract/chunk/embed/upsert pipeline
// only sees DocumentRef / Document.

export type ConnectorType = 'sharepoint' | 'onedrive';

export interface DocumentRef {
  // Provider-stable ID for this document. Stable across syncs.
  externalId: string;
  name: string;
  mimeType: string;
  // Optional provider hash/etag — used to skip re-extraction when unchanged.
  contentVersion?: string;
  // Size in bytes when the provider reports it — used to skip oversized files
  // before downloading them.
  sizeBytes?: number;
  // Optional user-facing URL for source attribution in retrieval results.
  sourceUrl?: string;
  // Provider raw metadata, opaque to the pipeline.
  raw?: unknown;
}

export interface Document extends DocumentRef {
  // Raw bytes of the file. Streamed by the connector, buffered by the pipeline.
  bytes: Buffer;
}

export interface DeltaPage {
  documents: DocumentRef[];
  // Documents that were deleted from the source since the last sync — caller
  // is responsible for tombstoning their chunks in Pinecone + Postgres.
  deleted: string[];
  // Cursor to pass back on the next sync. Opaque to the caller.
  nextCursor: string;
  // True when there are more pages in this delta run.
  hasMore: boolean;
}

// Implementations get whatever they need (OAuth tokens, source config) via
// constructor injection, not via the interface.
export interface Connector {
  readonly type: ConnectorType;

  // Discover all documents under the source. Used for initial / full re-syncs.
  listAllDocuments(): AsyncIterable<DocumentRef>;

  // Incremental sync. `cursor` is whatever this connector returned last time
  // (or undefined for the first call). Returns a page of changes + a new cursor.
  // Yields one page at a time so the caller can checkpoint per page.
  syncDelta(cursor: string | undefined): AsyncIterable<DeltaPage>;

  // Fetch the actual bytes for a given document ref.
  fetchDocument(ref: DocumentRef): Promise<Document>;
}
