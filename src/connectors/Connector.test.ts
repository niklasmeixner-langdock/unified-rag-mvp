// Contract test: any Connector implementation must satisfy these invariants.
// A new source should slot in here without changes to the downstream pipeline.

import { describe, it, expect } from 'vitest';
import type { Connector, DeltaPage, DocumentRef } from './Connector.js';

class InMemoryConnector implements Connector {
  readonly type = 'sharepoint' as const;
  private cursorSeq = 0;
  private docs: Map<string, { ref: DocumentRef; bytes: Buffer }> = new Map();

  add(ref: DocumentRef, bytes: Buffer) {
    this.docs.set(ref.externalId, { ref, bytes });
  }

  async *listAllDocuments(): AsyncIterable<DocumentRef> {
    for (const { ref } of this.docs.values()) yield ref;
  }

  async *syncDelta(cursor: string | undefined): AsyncIterable<DeltaPage> {
    const docs = [...this.docs.values()].map((d) => d.ref);
    yield {
      documents: docs,
      deleted: [],
      nextCursor: `cursor-${++this.cursorSeq}`,
      hasMore: false,
    };
  }

  async fetchDocument(ref: DocumentRef) {
    const found = this.docs.get(ref.externalId);
    if (!found) throw new Error(`unknown doc ${ref.externalId}`);
    return { ...ref, bytes: found.bytes };
  }
}

describe('Connector contract', () => {
  it('listAllDocuments yields each document once', async () => {
    const c = new InMemoryConnector();
    c.add({ externalId: 'a', name: 'a.txt', mimeType: 'text/plain' }, Buffer.from('aa'));
    c.add({ externalId: 'b', name: 'b.txt', mimeType: 'text/plain' }, Buffer.from('bb'));

    const ids: string[] = [];
    for await (const ref of c.listAllDocuments()) ids.push(ref.externalId);
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  it('syncDelta returns a cursor and terminates when hasMore is false', async () => {
    const c = new InMemoryConnector();
    c.add({ externalId: 'a', name: 'a.txt', mimeType: 'text/plain' }, Buffer.from('aa'));

    const pages: DeltaPage[] = [];
    for await (const page of c.syncDelta(undefined)) pages.push(page);

    expect(pages.length).toBe(1);
    expect(pages[0]!.hasMore).toBe(false);
    expect(pages[0]!.nextCursor).toBeTruthy();
    expect(pages[0]!.documents.map((d) => d.externalId)).toEqual(['a']);
  });

  it('fetchDocument returns bytes for a known ref', async () => {
    const c = new InMemoryConnector();
    const ref = { externalId: 'a', name: 'a.txt', mimeType: 'text/plain' };
    c.add(ref, Buffer.from('hello world'));

    const doc = await c.fetchDocument(ref);
    expect(doc.bytes.toString('utf8')).toBe('hello world');
    expect(doc.externalId).toBe('a');
  });
});
