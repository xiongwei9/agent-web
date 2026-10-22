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

/**
 * Persists MCP OAuth credentials to one JSON file, so a restart doesn't mean
 * authorizing every server again. The file holds bearer and refresh tokens in
 * plain text: it is written with mode 0600 and must stay out of version control.
 *
 * Built for a single process: the file is read once, then kept in memory, and
 * writes are serialized and atomic (write a temp file, then rename).
 */
export function createFileMcpOAuthStore(
  path: string,
  options: { logger?: AgentLogger } = {},
): McpOAuthStore {
  return new FileMcpOAuthStore(path, options.logger ?? consoleLogger);
}

type StoreFile = Record<string, McpOAuthCredentials>;

class FileMcpOAuthStore implements McpOAuthStore {
  private readonly path: string;
  private readonly logger: AgentLogger;
  private data: Promise<StoreFile> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(path: string, logger: AgentLogger) {
    this.path = path;
    this.logger = logger;
  }

  async load(key: string): Promise<McpOAuthCredentials | undefined> {
    return (await this.read())[key];
  }

  async save(key: string, credentials: McpOAuthCredentials | undefined): Promise<void> {
    const data = await this.read();
    if (credentials) {
      data[key] = credentials;
    } else {
      delete data[key];
    }

    const snapshot = JSON.stringify(data, null, 2);
    this.writing = this.writing.catch(() => {}).then(() => this.write(snapshot));
    await this.writing;
  }

  private read(): Promise<StoreFile> {
    this.data ??= readFile(this.path, "utf8").then(
      (text) => {
        try {
          const parsed: unknown = JSON.parse(text);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            return parsed as StoreFile;
          }
        } catch {
          // Fall through: an unreadable file is treated as empty and rewritten.
        }
        this.logger.warn(`[mcp] ignoring malformed OAuth store ${this.path}`);
        return {};
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return {};
        }
        throw error;
      },
    );
    return this.data;
  }

  private async write(contents: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, contents, { mode: 0o600 });
    await rename(temp, this.path);
  }
}
