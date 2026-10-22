import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, mock, test } from "node:test";

import { startDemoHttpServer, type DemoHttpServer } from "@ai-chat/mcp-server-demo";

import { createFileMcpOAuthStore } from "../src/mcp/oauth/store.ts";
import { McpUserConnections, type McpUserConnectionsOptions } from "../src/mcp/users.ts";
import type { McpServerInfo } from "../src/types.ts";
import { submitConsent } from "./helpers.ts";

const OAUTH = { redirectUrl: "http://127.0.0.1:9/callback" };

function open(
  t: { after: (fn: () => Promise<void>) => void },
  url: string,
  options: McpUserConnectionsOptions = {},
): McpUserConnections {
  const connections = new McpUserConnections(
    { demo: { url } },
    { oauth: OAUTH, retryDelayMs: 0, ...options },
  );
  t.after(() => connections.close());
  return connections;
}

/** Runs one user's OAuth flow end to end. */
async function authorize(connections: McpUserConnections, userId?: string): Promise<McpServerInfo> {
  await connections.connect(userId);
  const [info] = connections.status(userId);
  const callback = await submitConsent(info!.authorizationUrl!);
  return connections.finishAuth(
    callback.searchParams.get("state")!,
    callback.searchParams.get("code")!,
  );
}

describe("McpUserConnections", () => {
  let server: DemoHttpServer;
  let dir: string;

  before(async () => {
    server = await startDemoHttpServer({ oauth: true });
    dir = await mkdtemp(join(tmpdir(), "mcp-users-"));
    mock.method(console, "warn", () => {});
  });

  after(async () => {
    mock.restoreAll();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("keeps each user's authorization to themselves", async (t) => {
    const connections = open(t, server.url);

    await authorize(connections, "alice");
    await connections.connect("bob");

    assert.equal(connections.status("alice")[0]?.status, "connected");
    assert.equal(connections.status("bob")[0]?.status, "needs_auth");
    assert.ok((await connections.forUser("alice").getToolNames()).has("demo__echo"));
    assert.equal((await connections.forUser("bob").getToolNames()).size, 0);
  });

  test("gives each user their own OAuth client and token", async (t) => {
    const connections = open(t, server.url);
    await authorize(connections, "alice");
    await authorize(connections, "bob");

    const whoami = async (userId: string) =>
      JSON.parse(
        await (await connections.forUser(userId).getTools()).get("demo__whoami")!.execute({}),
      );
    const [alice, bob] = await Promise.all([whoami("alice"), whoami("bob")]);
    assert.notEqual(alice.auth.clientId, bob.auth.clientId);
    assert.notEqual(alice.headers.authorization, bob.headers.authorization);
  });

  test("routes a callback to the user whose authorization it completes", async (t) => {
    const connections = open(t, server.url);
    await connections.connect("alice");
    await connections.connect("bob");

    const bobUrl = connections.status("bob")[0]!.authorizationUrl!;
    const callback = await submitConsent(bobUrl);
    await connections.finishAuth(
      callback.searchParams.get("state")!,
      callback.searchParams.get("code")!,
    );

    assert.equal(connections.status("bob")[0]?.status, "connected");
    assert.equal(connections.status("alice")[0]?.status, "needs_auth");
  });

  test("rejects a state no user started", async (t) => {
    const connections = open(t, server.url);
    await connections.connect("alice");
    await assert.rejects(connections.finishAuth("forged", "code"), /Unknown or expired/);
  });

  test("stores each user's tokens under their own key; the shared scope keeps bare keys", async (t) => {
    const path = join(dir, "keys.json");
    const connections = open(t, server.url, {
      oauth: { ...OAUTH, store: createFileMcpOAuthStore(path) },
    });
    await authorize(connections, "alice");
    await authorize(connections); // shared scope

    const keys = Object.keys(JSON.parse(await readFile(path, "utf8"))).sort();
    assert.deepEqual(keys, [`demo ${server.url}`, `user:alice demo ${server.url}`]);
  });

  test("closes idle users' connections but keeps their tokens", async (t) => {
    const connections = open(t, server.url, { idleTimeoutMs: 20 });
    await authorize(connections, "alice");
    const aliceRegistry = connections.forUser("alice");

    await new Promise((resolve) => setTimeout(resolve, 40));
    connections.forUser("bob"); // any access sweeps idle users

    const fresh = connections.forUser("alice");
    assert.notEqual(fresh, aliceRegistry, "alice's idle registry was dropped");
    await fresh.connect();
    assert.equal(fresh.status()[0]?.status, "connected", "reconnected without authorizing");
  });
});
