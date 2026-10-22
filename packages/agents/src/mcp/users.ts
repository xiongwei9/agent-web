import type {
  McpConfig,
  McpConnections,
  McpOAuthCredentials,
  McpOAuthStore,
  McpServerConfig,
  McpServerInfo,
} from "../types.ts";
import { MemoryMcpOAuthStore } from "./oauth/store.ts";
import { McpToolRegistry, type McpToolRegistryOptions } from "./registry.ts";

/** The scope of runs without a `userId`. Its store keys stay unprefixed. */
export const SHARED_USER = "default";
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;

export interface McpUserConnectionsOptions extends McpToolRegistryOptions {
  idleTimeoutMs?: number;
}

/**
 * Keeps one {@link McpToolRegistry} per user, so each user has their own MCP
 * connections, OAuth client registrations, and tokens — one user's
 * authorization never serves another's run.
 *
 * Every user's credentials go to the one configured store under a per-user
 * key. A registry left unused for `idleTimeoutMs` is closed and dropped; its
 * credentials stay in the store, so the user reconnects without authorizing
 * again (unless authorization was still pending, which then restarts).
 */
export class McpUserConnections implements McpConnections {
  private readonly servers: Record<string, McpServerConfig>;
  private readonly options: McpToolRegistryOptions;
  private readonly store: McpOAuthStore | undefined;
  private readonly idleTimeoutMs: number;
  private readonly users = new Map<string, { registry: McpToolRegistry; lastUsed: number }>();

  constructor(servers: Record<string, McpServerConfig>, options: McpUserConnectionsOptions = {}) {
    const { idleTimeoutMs, ...registryOptions } = options;
    this.servers = servers;
    this.options = registryOptions;
    // Shared by every user's registry (and outliving evicted ones), so a
    // memory store doesn't forget tokens when a registry is dropped.
    this.store = options.oauth ? (options.oauth.store ?? new MemoryMcpOAuthStore()) : undefined;
    this.idleTimeoutMs = idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  /** The user's registry, created on first use. */
  forUser(userId: string = SHARED_USER): McpToolRegistry {
    const now = Date.now();
    this.evictIdle(now, userId);

    let entry = this.users.get(userId);
    if (!entry) {
      const { oauth } = this.options;
      const registry = new McpToolRegistry(this.servers, {
        ...this.options,
        oauth:
          oauth && this.store ? { ...oauth, store: scopedStore(this.store, userId) } : undefined,
      });
      entry = { registry, lastUsed: now };
      this.users.set(userId, entry);
    }
    entry.lastUsed = now;
    return entry.registry;
  }

  connect(userId?: string): Promise<void> {
    return this.forUser(userId).connect();
  }

  status(userId?: string): McpServerInfo[] {
    return this.forUser(userId).status();
  }

  async finishAuth(state: string, code: string): Promise<McpServerInfo> {
    for (const entry of this.users.values()) {
      if (entry.registry.hasPendingAuthorization(state)) {
        entry.lastUsed = Date.now();
        return entry.registry.finishAuth(state, code);
      }
    }
    throw new Error("Unknown or expired OAuth state");
  }

  async close(): Promise<void> {
    const registries = [...this.users.values()].map((entry) => entry.registry);
    this.users.clear();
    await Promise.allSettled(registries.map((registry) => registry.close()));
  }

  private evictIdle(now: number, keep: string): void {
    for (const [userId, entry] of this.users) {
      if (userId !== keep && now - entry.lastUsed > this.idleTimeoutMs) {
        this.users.delete(userId);
        void entry.registry.close();
      }
    }
  }
}

export function createMcpConnections(
  config: McpConfig | undefined,
  options: Omit<McpUserConnectionsOptions, "oauth" | "idleTimeoutMs"> = {},
): McpUserConnections | undefined {
  const servers = config?.servers;
  if (!servers || Object.keys(servers).length === 0) {
    return undefined;
  }
  return new McpUserConnections(servers, {
    ...options,
    oauth: config.oauth,
    idleTimeoutMs: config.idleTimeoutMs,
  });
}

/**
 * Prefixes a user's store keys. The shared scope keeps the bare keys, so
 * credentials stored before per-user scoping existed still load.
 */
function scopedStore(store: McpOAuthStore, userId: string): McpOAuthStore {
  if (userId === SHARED_USER) {
    return store;
  }
  const scoped = (key: string) => `user:${userId} ${key}`;
  return {
    load: (key) => store.load(scoped(key)),
    save: (key, credentials: McpOAuthCredentials | undefined) =>
      store.save(scoped(key), credentials),
  };
}
