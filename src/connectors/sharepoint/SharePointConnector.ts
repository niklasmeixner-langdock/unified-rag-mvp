import type { Connector, DocumentRef, Document, DeltaPage, ConnectorType } from '../Connector.js';
import { GraphClient, type DriveItem } from './graph.js';

export interface SharePointSourceRef {
  // The drive to sync. For SharePoint document libraries this is a /sites/{siteId}/drives/{driveId} ID.
  driveId: string;
}

export class SharePointConnector implements Connector {
  readonly type: ConnectorType;

  constructor(
    type: 'sharepoint' | 'onedrive',
    private readonly graph: GraphClient,
    private readonly source: SharePointSourceRef,
  ) {
    this.type = type;
  }

  // Used for the first sync of a new source. After the first delta run we have
  // a cursor, so this is effectively only called on (re)initialization.
  async *listAllDocuments(): AsyncIterable<DocumentRef> {
    for await (const page of this.syncDelta(undefined)) {
      for (const doc of page.documents) yield doc;
      if (!page.hasMore) break;
    }
  }

  // Drives the /drive/root/delta endpoint, paging via @odata.nextLink within a
  // single sync, and surfacing @odata.deltaLink as the cursor for the next run.
  async *syncDelta(cursor: string | undefined): AsyncIterable<DeltaPage> {
    let response = await this.graph.getDelta(this.source.driveId, cursor);

    while (true) {
      const documents: DocumentRef[] = [];
      const deleted: string[] = [];

      for (const item of response.value) {
        // Folders and tombstones aren't documents — skip but record deletions.
        if (item.deleted) {
          deleted.push(item.id);
          continue;
        }
        if (item.folder) continue;
        if (!item.file) continue;

        documents.push(toDocumentRef(item, this.source.driveId));
      }

      const hasNextPage = !!response['@odata.nextLink'];
      const deltaLink = response['@odata.deltaLink'];

      yield {
        documents,
        deleted,
        nextCursor: hasNextPage ? response['@odata.nextLink']! : deltaLink!,
        hasMore: hasNextPage,
      };

      if (!hasNextPage) return;
      response = await this.graph.getDeltaPage(response['@odata.nextLink']!);
    }
  }

  async fetchDocument(ref: DocumentRef): Promise<Document> {
    const bytes = await this.graph.downloadItem(this.source.driveId, ref.externalId);
    return { ...ref, bytes };
  }
}

function toDocumentRef(item: DriveItem, driveId: string): DocumentRef {
  return {
    externalId: item.id,
    name: item.name,
    mimeType: item.file?.mimeType ?? 'application/octet-stream',
    contentVersion: item.eTag,
    sourceUrl: item.webUrl,
    raw: { driveId, parentPath: item.parentReference?.path },
  };
}
