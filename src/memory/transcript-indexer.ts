/**
 * Session Transcript Indexer
 *
 * Indexes conversation transcripts into chunks for cross-session recall.
 * Uses hybrid BM25 + semantic search over stored chunks.
 */

import type { Message, ContentBlock } from '../providers/types.js';

export interface TranscriptChunk {
  sessionId: string;
  userId: string;
  content: string;
  embedding?: number[];
  createdAt: number;
  messageRange: [number, number]; // start/end message indices
}

export interface TranscriptSearchResult {
  chunk: TranscriptChunk;
  score: number;
}

export interface TranscriptIndexerDeps {
  /** Store a chunk. Implementation should handle persistence (e.g., SQLite). */
  storeChunk: (chunk: TranscriptChunk) => void;
  /** Search stored chunks. Implementation should do BM25 + optional semantic search. */
  searchChunks: (query: string, options?: { userId?: string; limit?: number }) => Promise<TranscriptSearchResult[]>;
  /** Get the last indexed message count for a session (for delta indexing). */
  getLastIndexedCount: (sessionId: string) => number;
  /** Set the last indexed message count for a session. */
  setLastIndexedCount: (sessionId: string, count: number) => void;
  /** Generate embedding for text. Returns undefined if embeddings unavailable. */
  embed?: (text: string) => Promise<number[] | undefined>;
}

/** Target chunk size in characters (~400 tokens at 4 chars/token) */
const CHUNK_SIZE_CHARS = 1600;
/** Overlap between chunks in characters (~80 tokens) */
const CHUNK_OVERLAP_CHARS = 320;

export class TranscriptIndexer {
  private deps: TranscriptIndexerDeps;

  constructor(deps: TranscriptIndexerDeps) {
    this.deps = deps;
  }

  /**
   * Index a completed session's full transcript.
   */
  async indexSession(
    sessionId: string,
    messages: Message[],
    userId: string
  ): Promise<void> {
    const chunks = this.chunkMessages(sessionId, messages, userId, 0);
    for (const chunk of chunks) {
      if (this.deps.embed) {
        try {
          chunk.embedding = await this.deps.embed(chunk.content);
        } catch {
          // Embedding failure is non-fatal
        }
      }
      this.deps.storeChunk(chunk);
    }
    this.deps.setLastIndexedCount(sessionId, messages.length);
  }

  /**
   * Search across all indexed transcripts.
   */
  async search(
    query: string,
    options?: { userId?: string; limit?: number }
  ): Promise<TranscriptSearchResult[]> {
    return this.deps.searchChunks(query, options);
  }

  /**
   * Delta indexing: only index new messages since last index.
   */
  async indexDelta(
    sessionId: string,
    messages: Message[],
    userId: string
  ): Promise<void> {
    const lastCount = this.deps.getLastIndexedCount(sessionId);
    if (messages.length <= lastCount) return;

    // Include some overlap from previously indexed messages for context continuity
    const overlapMessages = Math.min(2, lastCount);
    const startIdx = Math.max(0, lastCount - overlapMessages);
    const newMessages = messages.slice(startIdx);

    const chunks = this.chunkMessages(sessionId, newMessages, userId, startIdx);
    for (const chunk of chunks) {
      if (this.deps.embed) {
        try {
          chunk.embedding = await this.deps.embed(chunk.content);
        } catch {
          // Embedding failure is non-fatal
        }
      }
      this.deps.storeChunk(chunk);
    }
    this.deps.setLastIndexedCount(sessionId, messages.length);
  }

  /**
   * Chunk conversation messages into ~400 token segments with overlap.
   */
  private chunkMessages(
    sessionId: string,
    messages: Message[],
    userId: string,
    startOffset: number
  ): TranscriptChunk[] {
    // Convert messages to text
    const textParts: { text: string; msgIdx: number }[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const role = msg.role;
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else {
        text = (msg.content as ContentBlock[])
          .filter(b => b.type === 'text')
          .map(b => (b as { text: string }).text)
          .join('\n');
      }
      if (text.trim()) {
        textParts.push({ text: `${role}: ${text}`, msgIdx: i + startOffset });
      }
    }

    if (textParts.length === 0) return [];

    // Concatenate all text
    const fullText = textParts.map(p => p.text).join('\n');

    // Build chunks with overlap
    const chunks: TranscriptChunk[] = [];
    let pos = 0;
    while (pos < fullText.length) {
      const end = Math.min(pos + CHUNK_SIZE_CHARS, fullText.length);
      const chunkText = fullText.slice(pos, end);

      // Determine message range for this chunk
      const chunkStart = pos;
      const chunkEnd = end;
      let startMsgIdx = textParts[0].msgIdx;
      let endMsgIdx = textParts[textParts.length - 1].msgIdx;

      let currentPos = 0;
      for (const part of textParts) {
        const partEnd = currentPos + part.text.length + 1; // +1 for \n
        if (currentPos <= chunkStart && chunkStart < partEnd) {
          startMsgIdx = part.msgIdx;
        }
        if (currentPos < chunkEnd && chunkEnd <= partEnd) {
          endMsgIdx = part.msgIdx;
        }
        currentPos = partEnd;
      }

      chunks.push({
        sessionId,
        userId,
        content: chunkText,
        createdAt: Date.now(),
        messageRange: [startMsgIdx, endMsgIdx],
      });

      // Advance with overlap
      pos = end - CHUNK_OVERLAP_CHARS;
      if (pos >= fullText.length - CHUNK_OVERLAP_CHARS) {
        // Last chunk — don't create a tiny trailing chunk
        break;
      }
    }

    return chunks;
  }
}
