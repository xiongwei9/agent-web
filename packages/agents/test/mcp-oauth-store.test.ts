import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { createFileMcpOAuthStore, MemoryMcpOAuthStore } from "../src/mcp/oauth/store.ts";
import type { McpOAuthCredentials } from "../src/types.ts";

const CREDENTIALS: McpOAuthCredentials = {
  clientInformation: { client_id: "client-1" },
  tokens: { access_token: "access", token_type: "Bearer", refresh_token: "refresh" },
};

describe("MemoryMcpOAuthStore", () => {
  test("saves, loads, and deletes", async () => {
    const store = new MemoryMcpOAuthStore();
    assert.equal(await store.load("demo"), undefined);

    await store.save("demo", CREDENTIALS);
    assert.deepEqual(await store.load("demo"), CREDENTIALS);

    await store.save("demo", undefined);
    assert.equal(await store.load("demo"), undefined);
  });
});

describe("createFileMcpOAuthStore", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-oauth-store-"));
  });

  after(() => rm(dir, { recursive: true, force: true }));

  test("persists across store instances", async () => {
    const path = join(dir, "persist.json");
    await createFileMcpOAuthStore(path).save("demo http://x/mcp", CREDENTIALS);

    assert.deepEqual(await createFileMcpOAuthStore(path).load("demo http://x/mcp"), CREDENTIALS);
  });

  test("writes the file owner-only and creates missing directories", async () => {
    const path = join(dir, "nested", "deeper", "store.json");
    await createFileMcpOAuthStore(path).save("demo", CREDENTIALS);

    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  test("deletes an entry and keeps the others", async () => {
    const path = join(dir, "delete.json");
    const store = createFileMcpOAuthStore(path);
    await store.save("a", CREDENTIALS);
    await store.save("b", CREDENTIALS);
    await store.save("a", undefined);

    assert.deepEqual(Object.keys(JSON.parse(await readFile(path, "utf8"))), ["b"]);
  });

  test("keeps every entry when saves overlap", async () => {
    const path = join(dir, "concurrent.json");
    const store = createFileMcpOAuthStore(path);
    await Promise.all(["a", "b", "c", "d"].map((key) => store.save(key, CREDENTIALS)));

    const reloaded = createFileMcpOAuthStore(path);
    for (const key of ["a", "b", "c", "d"]) {
      assert.deepEqual(await reloaded.load(key), CREDENTIALS);
    }
  });

  test("treats a malformed file as empty and overwrites it", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const path = join(dir, "malformed.json");
    await writeFile(path, "{ not json");
    const store = createFileMcpOAuthStore(path);

    assert.equal(await store.load("demo"), undefined);
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /malformed OAuth store/);
    await store.save("demo", CREDENTIALS);
    assert.deepEqual(await createFileMcpOAuthStore(path).load("demo"), CREDENTIALS);
  });

  test("records when each entry was last used", async () => {
    const path = join(dir, "used.json");
    const before = Date.now();
    await createFileMcpOAuthStore(path).save("demo", CREDENTIALS);

    const file = JSON.parse(await readFile(path, "utf8"));
    assert.ok(Date.parse(file.demo.lastUsedAt) >= before);
    assert.deepEqual(await createFileMcpOAuthStore(path).load("demo"), CREDENTIALS);
  });

  test("drops entries unused for longer than maxIdleMs", async (t) => {
    const info = t.mock.method(console, "info", () => {});
    const path = join(dir, "idle.json");
    await writeFile(
      path,
      JSON.stringify({
        stale: { ...CREDENTIALS, lastUsedAt: daysAgo(91) },
        recent: { ...CREDENTIALS, lastUsedAt: daysAgo(89) },
        // Written before lastUsedAt existed: kept, its idle clock starts now.
        legacy: CREDENTIALS,
      }),
    );
    const store = createFileMcpOAuthStore(path);

    assert.equal(await store.load("stale"), undefined);
    assert.deepEqual(await store.load("recent"), CREDENTIALS);
    assert.deepEqual(await store.load("legacy"), CREDENTIALS);
    assert.match(String(info.mock.calls[0]?.arguments[0]), /dropped 1 OAuth store entries/);
    await store.save("new", CREDENTIALS);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path, "utf8"))).sort(), [
      "legacy",
      "new",
      "recent",
    ]);
  });

  test("takes maxIdleMs from the options", async () => {
    const path = join(dir, "short.json");
    await writeFile(path, JSON.stringify({ demo: { ...CREDENTIALS, lastUsedAt: daysAgo(2) } }));

    assert.equal(
      await createFileMcpOAuthStore(path, { maxIdleMs: DAY_MS }).load("demo"),
      undefined,
    );
  });

  test("writes a read back as a use at most daily", async () => {
    const path = join(dir, "touch.json");
    const lastUsedAt = new Date(Date.now() - 60_000).toISOString();
    const original = JSON.stringify({
      fresh: { ...CREDENTIALS, lastUsedAt },
      old: { ...CREDENTIALS, lastUsedAt: daysAgo(2) },
    });
    await writeFile(path, original);
    const store = createFileMcpOAuthStore(path);

    const freshRead = Date.now();
    await store.load("fresh");
    assert.equal(await readFile(path, "utf8"), original, "a recent use isn't written back");
    const before = Date.now();
    await store.load("old");
    const file = JSON.parse(await readFile(path, "utf8"));
    assert.ok(Date.parse(file.old.lastUsedAt) >= before);
    assert.ok(Date.parse(file.fresh.lastUsedAt) >= freshRead, "a shared write includes every use");
    const checkpoint = await readFile(path, "utf8");
    await store.load("old");
    assert.equal(await readFile(path, "utf8"), checkpoint, "a recent checkpoint isn't rewritten");
  });

  test("keeps a recently read entry when a short idle timeout sweeps other writes", async (t) => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const path = join(dir, "active-short.json");
    const store = createFileMcpOAuthStore(path, { maxIdleMs: 60 * 60_000 });
    await store.save("active", CREDENTIALS);
    const original = await readFile(path, "utf8");

    now += 25 * 60_000;
    assert.deepEqual(await store.load("active"), CREDENTIALS);
    assert.equal(await readFile(path, "utf8"), original, "the read only updates memory");

    now += 36 * 60_000;
    await store.save("other", CREDENTIALS);
    assert.deepEqual(await store.load("active"), CREDENTIALS);
    assert.deepEqual(
      await createFileMcpOAuthStore(path, { maxIdleMs: 60 * 60_000 }).load("active"),
      CREDENTIALS,
    );
  });

  test("checkpoints frequent reads before a short retention period elapses", async (t) => {
    const start = Date.now();
    let now = start;
    t.mock.method(Date, "now", () => now);
    const path = join(dir, "frequent-short.json");
    const store = createFileMcpOAuthStore(path, { maxIdleMs: 60 * 60_000 });
    await store.save("active", CREDENTIALS);

    for (let minute = 10; minute <= 30; minute += 10) {
      now = start + minute * 60_000;
      assert.deepEqual(await store.load("active"), CREDENTIALS);
    }
    const file = JSON.parse(await readFile(path, "utf8"));
    assert.equal(Date.parse(file.active.lastUsedAt), now);

    now = start + 61 * 60_000;
    assert.deepEqual(
      await createFileMcpOAuthStore(path, { maxIdleMs: 60 * 60_000 }).load("active"),
      CREDENTIALS,
    );
  });

  test("does not revive expired entries in a running store", async (t) => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const path = join(dir, "expired-running.json");
    const store = createFileMcpOAuthStore(path);
    await store.save("expired", CREDENTIALS);

    now += 91 * DAY_MS;
    assert.equal(await store.load("expired"), undefined);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {});
    assert.equal(await createFileMcpOAuthStore(path).load("expired"), undefined);
  });

  test("retries a failed usage checkpoint without failing the read", async (t) => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const warn = t.mock.method(console, "warn", () => {});
    const parent = join(dir, "retry-checkpoint");
    const path = join(parent, "store.json");
    const store = createFileMcpOAuthStore(path);
    await store.save("active", CREDENTIALS);

    await rm(parent, { recursive: true });
    await writeFile(parent, "blocks directory creation");
    now += 2 * DAY_MS;
    assert.deepEqual(await store.load("active"), CREDENTIALS);
    assert.equal(warn.mock.calls.length, 1);

    await rm(parent);
    assert.deepEqual(await store.load("active"), CREDENTIALS);
    assert.equal(Date.parse(JSON.parse(await readFile(path, "utf8")).active.lastUsedAt), now);
  });

  test("rejects invalid idle timeouts", () => {
    for (const maxIdleMs of [0, -1, NaN, Infinity]) {
      assert.throws(
        () => createFileMcpOAuthStore(join(dir, "invalid.json"), { maxIdleMs }),
        /maxIdleMs must be a positive finite number/,
      );
    }
  });
});

const DAY_MS = 24 * 60 * 60_000;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}
