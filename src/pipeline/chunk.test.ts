import { describe, it, expect } from 'vitest';
import { chunkText } from './chunk.js';

describe('chunkText', () => {
  it('returns no chunks for empty input', () => {
    expect(chunkText('', 'doc.txt')).toEqual([]);
    expect(chunkText('   ', 'doc.txt')).toEqual([]);
  });

  it('returns a single chunk for short input', () => {
    const chunks = chunkText('hello world', 'doc.txt');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ text: 'hello world', name: 'doc.txt', index: 0 });
  });

  it('splits long input with overlap', () => {
    const text = 'a'.repeat(5000);
    const chunks = chunkText(text, 'long.txt', { size: 1000, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('rejects overlap >= size', () => {
    expect(() => chunkText('x', 'd', { size: 100, overlap: 100 })).toThrow();
  });
});
