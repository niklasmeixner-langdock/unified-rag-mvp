// MIME-dispatch text extraction. Returns plain text + optional structural hints.

import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import type { Document } from '../connectors/Connector.js';

export interface ExtractedText {
  text: string;
  // Optional structural breakpoints (page numbers, headings) — extractor-specific.
  pageHints?: number[];
}

export async function extractText(doc: Document): Promise<ExtractedText> {
  const mime = doc.mimeType.toLowerCase();

  if (mime === 'application/pdf' || doc.name.endsWith('.pdf')) {
    const parsed = await pdf(doc.bytes);
    return { text: parsed.text };
  }

  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    doc.name.endsWith('.docx')
  ) {
    const { value } = await mammoth.extractRawText({ buffer: doc.bytes });
    return { text: value };
  }

  if (mime.startsWith('text/') || doc.name.endsWith('.txt') || doc.name.endsWith('.md')) {
    return { text: doc.bytes.toString('utf8') };
  }

  // Unsupported types (e.g. PPTX, images) surface as a typed skip so callers can record them.
  throw new UnsupportedMimeError(doc.mimeType, doc.name);
}

export class UnsupportedMimeError extends Error {
  constructor(public readonly mimeType: string, name: string) {
    super(`Unsupported MIME type ${mimeType} for ${name}`);
    this.name = 'UnsupportedMimeError';
  }
}
