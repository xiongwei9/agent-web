import type { CompactionStore, CompactionSummary, CompactionThread } from "../types.ts";

const DEFAULT_MAX_THREADS = 500;

/**
 * The default store: each user's thread's latest summary lives as long as the
 * process, the least recently used thread dropped first once more than
 * `maxThreads` are kept.
 */
export class MemoryCompactionStore implements CompactionStore {
  private readonly entries = new Map<string, CompactionSummary>();
  private readonly maxThreads: number;

  constructor(maxThreads = DEFAULT_MAX_THREADS) {
    this.maxThreads = maxThreads;
  }

  async load(thread: CompactionThread): Promise<CompactionSummary | undefined> {
    const key = keyOf(thread);
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  async save(thread: CompactionThread, summary: CompactionSummary): Promise<void> {
    const key = keyOf(thread);
    this.entries.delete(key);
    this.entries.set(key, summary);
    if (this.entries.size > this.maxThreads) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }
}

/** Users' threads kept apart, even with the same thread id. */
function keyOf({ threadId, userId }: CompactionThread): string {
  return JSON.stringify([userId ?? null, threadId]);
}
