import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AgentLogger, McpOAuthCredentials, McpOAuthStore } from "../../types.ts";
import { consoleLogger } from "../../shared/logger.ts";

/** The default store: credentials live as long as the process. */
export class MemoryMcpOAuthStore implements McpOAuthStore {
  private readonly entries = new Map<string, McpOAuthCredentials>();

  async load(key: string): Promise<McpOAuthCredentials | undefined> {
    return this.entries.get(key);
  }

  async save(key: string, credentials: McpOAuthCredentials | undefined): Promise<void> {
    if (credentials) {
      this.entries.set(key, credentials);
    } else {
      this.entries.delete(key);
    }
  }
}

const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_IDLE_MS = 90 * DAY_MS;
/** Maximum interval between usage checkpoints triggered by reads. */
const TOUCH_INTERVAL_MS = DAY_MS;

export interface FileMcpOAuthStoreOptions {
  logger?: AgentLogger;
  /**
   * Drop an entry once it has gone unused this long (default 90 days). Every
   * new browser or cleared cookie is a new user with entries of their own, so
   * without this the file only grows. A dropped user authorizes again.
   * Must be a positive finite number.
   */
  maxIdleMs?: number;
}

/**
 * Persists MCP OAuth credentials to one JSON file, so a restart doesn't mean
 * authorizing every server again. The file holds bearer and refresh tokens in
 * plain text: it is written with mode 0600 and must stay out of version control.
 *
 * Each read updates last use in memory. Usage timestamps are checkpointed at
 * daily intervals, or half of `maxIdleMs` for shorter retention periods;
 * entries idle longer than `maxIdleMs` are dropped before they can be read.
 *
 * Built for a single process: the file is read once, then kept in memory, and
 * writes are serialized and atomic (write a temp file, then rename).
 */
export function createFileMcpOAuthStore(
  path: string,
  options: FileMcpOAuthStoreOptions = {},
): McpOAuthStore {
  return new FileMcpOAuthStore(
    path,
    options.logger ?? consoleLogger,
    options.maxIdleMs ?? DEFAULT_MAX_IDLE_MS,
  );
}

/** One entry as the file holds it. */
interface StoredCredentials extends McpOAuthCredentials {
  /** ISO timestamp. Missing in files written before it existed. */
  lastUsedAt?: string;
}

interface Entry {
  credentials: McpOAuthCredentials;
  lastUsedAt: number;
  persistedLastUsedAt: number;
}

class FileMcpOAuthStore implements McpOAuthStore {
  private readonly path: string;
  private readonly logger: AgentLogger;
  private readonly maxIdleMs: number;
  private data: Promise<Map<string, Entry>> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(path: string, logger: AgentLogger, maxIdleMs: number) {
    if (!Number.isFinite(maxIdleMs) || maxIdleMs <= 0) {
      throw new RangeError("maxIdleMs must be a positive finite number");
    }
    this.path = path;
    this.logger = logger;
    this.maxIdleMs = maxIdleMs;
  }

  async load(key: string): Promise<McpOAuthCredentials | undefined> {
    const data = await this.read();
    const entry = data.get(key);
    if (!entry) {
      return undefined;
    }
    const now = Date.now();
    // Expiration must be checked before this read can renew the entry.
    if (now - entry.lastUsedAt > this.maxIdleMs) {
      data.delete(key);
      await this.persistUsage(data);
      return undefined;
    }
    // Track every use in memory, independently of the write throttle. Short
    // retention periods also need more frequent checkpoints across restarts.
    entry.lastUsedAt = now;
    if (now - entry.persistedLastUsedAt >= Math.min(TOUCH_INTERVAL_MS, this.maxIdleMs / 2)) {
      await this.persistUsage(data);
    }
    return entry.credentials;
  }

  async save(key: string, credentials: McpOAuthCredentials | undefined): Promise<void> {
    const data = await this.read();
    if (credentials) {
      data.set(key, { credentials, lastUsedAt: Date.now(), persistedLastUsedAt: 0 });
    } else {
      data.delete(key);
    }
    await this.persist(data);
  }

  private read(): Promise<Map<string, Entry>> {
    this.data ??= readFile(this.path, "utf8").then(
      (text) => {
        try {
          const parsed: unknown = JSON.parse(text);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            return this.fromFile(parsed as Record<string, StoredCredentials>);
          }
        } catch {
          // Fall through: an unreadable file is treated as empty and rewritten.
        }
        this.logger.warn(`[mcp] ignoring malformed OAuth store ${this.path}`);
        return new Map();
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return new Map();
        }
        throw error;
      },
    );
    return this.data;
  }

  private fromFile(file: Record<string, StoredCredentials>): Map<string, Entry> {
    const now = Date.now();
    const data = new Map<string, Entry>();
    for (const [key, { lastUsedAt, ...credentials }] of Object.entries(file)) {
      // An entry from before `lastUsedAt` existed starts its idle clock now.
      const used = lastUsedAt === undefined ? NaN : Date.parse(lastUsedAt);
      const lastUse = Number.isNaN(used) ? now : used;
      data.set(key, { credentials, lastUsedAt: lastUse, persistedLastUsedAt: lastUse });
    }
    const dropped = this.dropIdle(data, now);
    if (dropped > 0) {
      this.logger.info(`[mcp] dropped ${dropped} OAuth store entries unused for too long`);
    }
    return data;
  }

  /** Removes the entries idle longer than `maxIdleMs`; returns how many. */
  private dropIdle(data: Map<string, Entry>, now: number): number {
    let dropped = 0;
    for (const [key, entry] of data) {
      if (now - entry.lastUsedAt > this.maxIdleMs) {
        data.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  private persist(data: Map<string, Entry>): Promise<void> {
    this.dropIdle(data, Date.now());
    const entries = Array.from(data, ([key, entry]) => ({ key, entry, used: entry.lastUsedAt }));
    const file: Record<string, StoredCredentials> = {};
    for (const { key, entry, used } of entries) {
      file[key] = { ...entry.credentials, lastUsedAt: new Date(used).toISOString() };
    }
    const snapshot = JSON.stringify(file, null, 2);
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        await this.write(snapshot);
        for (const { entry, used } of entries) {
          entry.persistedLastUsedAt = used;
        }
      });
    return this.writing;
  }

  private async persistUsage(data: Map<string, Entry>): Promise<void> {
    // Only bookkeeping: a failed write must not fail the read. Keep the last
    // successful checkpoint so a later read retries a failed write.
    await this.persist(data).catch((error: unknown) => {
      this.logger.warn(`[mcp] failed to update OAuth store ${this.path}: ${String(error)}`);
    });
  }

  private async write(contents: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, contents, { mode: 0o600 });
    await rename(temp, this.path);
  }
}
