// Sliding-window text chunking with paragraph/sentence-aware breakpoints.

export interface Chunk {
  text: string;
  // Original document name — repeated on each chunk for retrieval-time attribution.
  name: string;
  // Optional sub-source (e.g. PDF page number); preserved for callers that pass it.
  subsource?: string;
  // Ordinal within the document.
  index: number;
}

export interface ChunkOptions {
  // Approximate target size in characters. ~1500 chars ≈ ~400 tokens for English.
  size?: number;
  // Overlap between adjacent chunks to preserve context across boundaries.
  overlap?: number;
}

export function chunkText(
  text: string,
  name: string,
  opts: ChunkOptions = {},
): Chunk[] {
  const size = opts.size ?? 1500;
  const overlap = opts.overlap ?? 200;
  if (overlap >= size) throw new Error('overlap must be smaller than size');

  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length === 0) return [];

  const chunks: Chunk[] = [];
  let cursor = 0;
  let index = 0;
  while (cursor < normalized.length) {
    const end = Math.min(cursor + size, normalized.length);
    // Prefer breaking at a paragraph/sentence boundary near `end` rather than mid-word.
    const breakAt = end < normalized.length ? findBreakpoint(normalized, end) : end;
    const slice = normalized.slice(cursor, breakAt).trim();
    if (slice.length > 0) chunks.push({ text: slice, name, index });
    if (breakAt >= normalized.length) break;
    cursor = Math.max(breakAt - overlap, cursor + 1);
    index += 1;
  }
  return chunks;
}

function findBreakpoint(text: string, target: number): number {
  // Look backwards up to ~200 chars for a paragraph or sentence break.
  const lo = Math.max(0, target - 200);
  for (let i = target; i >= lo; i--) {
    if (text[i] === '\n' && text[i - 1] === '\n') return i;
  }
  for (let i = target; i >= lo; i--) {
    if (text[i] === '.' || text[i] === '\n') return i + 1;
  }
  return target;
}
