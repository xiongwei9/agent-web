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
});
