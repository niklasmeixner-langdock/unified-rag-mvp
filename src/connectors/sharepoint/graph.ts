// Minimal Microsoft Graph v1.0 client — only the endpoints this service needs.
// Endpoint reference: https://learn.microsoft.com/en-us/graph/api/overview

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export interface DriveItem {
  id: string;
  name: string;
  size?: number;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  webUrl?: string;
  eTag?: string;
  parentReference?: { driveId: string; path?: string };
  // Direct (pre-authenticated) download URL — present on individual item responses.
  '@microsoft.graph.downloadUrl'?: string;
  // Tombstone for deleted items in /delta responses.
  deleted?: { state?: string };
}

export interface DeltaResponse {
  value: DriveItem[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

export class GraphClient {
  constructor(
    private readonly accessToken: string,
    private readonly opts: { maxDownloadBytes?: number } = {},
  ) {}

  private async request<T>(url: string): Promise<T> {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
      },
    });

    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after') || '60';
      throw new RateLimitError(`Graph 429 — retry after ${retryAfter}s`, Number(retryAfter));
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Graph API error (${res.status}): ${body}`);
    }

    return (await res.json()) as T;
  }

  // /drives/{driveId}/root/delta — cursor-based incremental sync.
  // `cursor` is the @odata.deltaLink returned by a previous run (or undefined for first call).
  // See https://learn.microsoft.com/en-us/graph/api/driveitem-delta
  async getDelta(driveId: string, cursor: string | undefined): Promise<DeltaResponse> {
    const url = cursor ?? `${GRAPH_BASE}/drives/${driveId}/root/delta`;
    return this.request<DeltaResponse>(url);
  }

  // Follow @odata.nextLink during a delta run (paging within one sync).
  async getDeltaPage(nextLink: string): Promise<DeltaResponse> {
    return this.request<DeltaResponse>(nextLink);
  }

  // Get a single driveItem by ID. Returned object includes @microsoft.graph.downloadUrl.
  async getItem(driveId: string, itemId: string): Promise<DriveItem> {
    return this.request<DriveItem>(`${GRAPH_BASE}/drives/${driveId}/items/${itemId}`);
  }

  // Download bytes. `@microsoft.graph.downloadUrl` is a pre-authenticated short-lived URL —
  // it must be fetched WITHOUT the Authorization header (sending one causes 401).
  // See https://learn.microsoft.com/en-us/graph/api/driveitem-get-content
  async downloadItem(driveId: string, itemId: string): Promise<Buffer> {
    const item = await this.getItem(driveId, itemId);
    const max = this.opts.maxDownloadBytes;
    if (max !== undefined && item.size !== undefined && item.size > max) {
      throw new FileTooLargeError(itemId, item.size, max);
    }
    const downloadUrl = item['@microsoft.graph.downloadUrl'];
    if (!downloadUrl) {
      throw new Error(`No downloadUrl on driveItem ${itemId} (likely a folder or unsupported type)`);
    }
    const res = await fetch(downloadUrl);
    if (!res.ok) {
      throw new Error(`Download failed (${res.status}) for item ${itemId}`);
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  }
}

export class RateLimitError extends Error {
  constructor(message: string, public readonly retryAfterSeconds: number) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export class FileTooLargeError extends Error {
  constructor(itemId: string, public readonly sizeBytes: number, public readonly maxBytes: number) {
    super(`Item ${itemId} is ${sizeBytes} bytes — exceeds the ${maxBytes}-byte download cap`);
    this.name = 'FileTooLargeError';
  }
}
