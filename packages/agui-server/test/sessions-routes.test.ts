import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import type { ConversationDetail, ConversationSummary } from "../src/conversations/store.ts";
import { Browser, startApp, type App } from "./helpers.ts";

/** Runs one turn. The model endpoint is a closed local port, so it fails fast, offline. */
function chat(app: App, browser: Browser, threadId: string, text: string) {
  return browser.request(app, {
    method: "POST",
    url: "/agui",
    headers: { accept: "text/event-stream" },
    payload: {
      threadId,
      runId: "r1",
      state: {},
      messages: [{ id: "m1", role: "user", content: text }],
      tools: [],
      context: [],
      forwardedProps: {},
    },
  });
}

/** The recording finishes just after the response; wait for it. */
async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}

describe("sessions routes", () => {
  let dir: string;
  let app: App;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "sessions-routes-"));
    app = await startApp(undefined, {
      env: {
        MODEL_PROVIDER: "openai-compatible",
        MODEL_BASE_URL: "http://127.0.0.1:9/v1",
        SESSIONS_DIR: dir,
      },
    });
  });

  after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("records a run and serves it back to the same user only", async () => {
    const alice = new Browser();
    const stream = await chat(app, alice, "thread-1", "hello there");
    // Recorded below, but AGENT_DEBUG_EVENTS is off: none reach the client.
    assert.doesNotMatch(stream.body, /agent\.debug\.model_request/);

    const detail = await eventually(async () => {
      const response = await alice.get(app, "/sessions/thread-1");
      const session = response.statusCode === 200 ? response.json<ConversationDetail>() : undefined;
      return session && session.modelCalls.length > 0 ? session : undefined;
    });
    assert.equal(detail.title, "hello there");
    assert.equal(detail.messages[0]?.content, "hello there");

    const list = await alice.get(app, "/sessions");
    assert.deepEqual(list.json<{ enabled: boolean; sessions: ConversationSummary[] }>(), {
      enabled: true,
      sessions: [
        {
          id: "thread-1",
          title: "hello there",
          createdAt: detail.createdAt,
          updatedAt: detail.updatedAt,
        },
      ],
    });

    const bob = new Browser();
    assert.deepEqual(
      (await bob.get(app, "/sessions")).json<{ sessions: unknown[] }>().sessions,
      [],
    );
    assert.equal((await bob.get(app, "/sessions/thread-1")).statusCode, 404);
  });

  test("deletes a session for its own user only", async () => {
    const alice = new Browser();
    await chat(app, alice, "thread-2", "to be deleted");
    await eventually(async () => {
      const response = await alice.get(app, "/sessions/thread-2");
      return response.statusCode === 200 ? true : undefined;
    });

    const bob = new Browser();
    const remove = (browser: Browser) =>
      browser.request(app, { method: "DELETE", url: "/sessions/thread-2" });
    assert.equal((await remove(bob)).statusCode, 404);
    assert.equal((await remove(alice)).statusCode, 204);
    assert.equal((await alice.get(app, "/sessions/thread-2")).statusCode, 404);
    assert.equal((await remove(alice)).statusCode, 404);
  });

  test("sends the model call events on with AGENT_DEBUG_EVENTS", async (t) => {
    const debug = await startApp(undefined, {
      env: {
        MODEL_PROVIDER: "openai-compatible",
        MODEL_BASE_URL: "http://127.0.0.1:9/v1",
        AGENT_DEBUG_EVENTS: "on",
      },
    });
    t.after(() => debug.close());
    const stream = await chat(debug, new Browser(), "thread-1", "hello");
    assert.match(stream.body, /agent\.debug\.model_request/);
  });

  test("reports recording off", async (t) => {
    const off = await startApp();
    t.after(() => off.close());
    const response = await off.inject({ method: "GET", url: "/sessions" });
    assert.deepEqual(response.json(), { enabled: false, sessions: [] });
  });
});
