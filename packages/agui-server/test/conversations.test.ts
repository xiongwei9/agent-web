import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { EventType, type BaseEvent, type Message, type RunAgentInput } from "@ag-ui/core";
import {
  aguiEvent,
  MODEL_REQUEST_EVENT,
  MODEL_RESPONSE_EVENT,
  type AgentLogger,
} from "@ai-chat/agents";
import { from, lastValueFrom, Subject, toArray } from "rxjs";

import { ConversationStore } from "../src/conversations/store.ts";

const silentLogger: AgentLogger = { debug() {}, info() {}, warn() {}, error() {} };

let dir: string;
let store: ConversationStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "conversations-"));
  store = new ConversationStore(dir, silentLogger);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runInput(threadId: string, messages: Message[]): RunAgentInput {
  return {
    threadId,
    runId: `run-${messages.length}`,
    messages,
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
}

/** The model call events of call `iteration`, around `events`. */
function modelCall(runId: string, iteration: number, events: BaseEvent[]): BaseEvent[] {
  const value = { runId, iteration };
  return [
    aguiEvent({ type: EventType.CUSTOM, name: MODEL_REQUEST_EVENT, value }),
    ...events,
    aguiEvent({ type: EventType.CUSTOM, name: MODEL_RESPONSE_EVENT, value }),
  ];
}

function reply(messageId: string, text: string): BaseEvent[] {
  return [
    aguiEvent({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" }),
    aguiEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text }),
    aguiEvent({ type: EventType.TEXT_MESSAGE_END, messageId }),
  ];
}

/** A run as the agent streams it: a tool call, its result, then `text`. */
function toolRun(input: RunAgentInput, text: string): BaseEvent[] {
  const { threadId, runId } = input;
  const toolCallId = `call-${runId}`;
  return [
    aguiEvent({ type: EventType.RUN_STARTED, threadId, runId }),
    ...modelCall(runId, 0, [
      aguiEvent({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName: "echo" }),
      aguiEvent({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: "{}" }),
      aguiEvent({ type: EventType.TOOL_CALL_END, toolCallId }),
    ]),
    aguiEvent({
      type: EventType.TOOL_CALL_RESULT,
      messageId: `${toolCallId}-result`,
      toolCallId,
      content: "echoed",
      role: "tool",
    }),
    ...modelCall(runId, 1, reply(`msg-${runId}`, text)),
    aguiEvent({ type: EventType.RUN_FINISHED, threadId, runId }),
  ];
}

/** A run that only replies `text`. */
function textRun(input: RunAgentInput, text: string): BaseEvent[] {
  const { threadId, runId } = input;
  return [
    aguiEvent({ type: EventType.RUN_STARTED, threadId, runId }),
    ...modelCall(runId, 0, reply(`msg-${threadId}-${runId}`, text)),
    aguiEvent({ type: EventType.RUN_FINISHED, threadId, runId }),
  ];
}

async function record(input: RunAgentInput, events: BaseEvent[], userId?: string) {
  await lastValueFrom(store.record(input, userId, from(events)).pipe(toArray()));
  await store.flush();
}

const firstMessage: Message = { id: "m1", role: "user", content: "please   echo\nsomething" };

describe("ConversationStore", () => {
  test("records the conversation and every model call of a run", async () => {
    const input = runInput("thread-a", [firstMessage]);
    await record(input, toolRun(input, "done"));

    assert.deepEqual(readdirSync(join(dir, "thread-a")).sort(), [
      "model-calls.jsonl",
      "session.json",
    ]);
    const lines = readFileSync(join(dir, "thread-a", "model-calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { name: string });
    assert.deepEqual(
      lines.map((event) => event.name),
      [MODEL_REQUEST_EVENT, MODEL_RESPONSE_EVENT, MODEL_REQUEST_EVENT, MODEL_RESPONSE_EVENT],
    );

    const conversation = await store.get("thread-a");
    assert.ok(conversation);
    assert.equal(conversation.title, "please echo something");
    // The run's events reduced onto the input, as the browser would.
    assert.deepEqual(
      conversation.messages.map((message) => message.role),
      ["user", "assistant", "tool", "assistant"],
    );
    assert.equal(conversation.messages.at(-1)?.content, "done");
    assert.equal(conversation.modelCalls.length, 4);
  });

  test("a later run updates the conversation and appends its model calls", async () => {
    const firstInput = runInput("thread-a", [firstMessage]);
    await record(firstInput, textRun(firstInput, "one"));
    const first = await store.get("thread-a");
    assert.ok(first);

    const followUp: Message = { id: "m2", role: "user", content: "again" };
    const secondInput = runInput("thread-a", [...first.messages, followUp]);
    await record(secondInput, textRun(secondInput, "two"));

    const second = await store.get("thread-a");
    assert.ok(second);
    assert.equal(second.title, first.title);
    assert.equal(second.createdAt, first.createdAt);
    assert.deepEqual(
      second.messages.map((message) => message.content),
      [firstMessage.content, "one", "again", "two"],
    );
    assert.equal(second.modelCalls.length, 4);
  });

  test("keeps each user's conversations to themselves", async () => {
    const input = runInput("thread-a", [firstMessage]);
    await record(input, textRun(input, "one"), "alice");
    // Bob reuses Alice's thread id: his run goes ahead, unrecorded.
    await record(input, textRun(input, "bob"), "bob");

    assert.deepEqual(
      (await store.list("alice")).map((conversation) => conversation.id),
      ["thread-a"],
    );
    assert.deepEqual(await store.list("bob"), []);
    assert.equal(await store.get("thread-a", "bob"), undefined);
    assert.equal((await store.get("thread-a", "alice"))?.messages.at(-1)?.content, "one");
  });

  test("lists the most recently updated first", async () => {
    const a = runInput("thread-a", [firstMessage]);
    await record(a, textRun(a, "a"));
    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct timestamps
    const b = runInput("thread-b", [firstMessage]);
    await record(b, textRun(b, "b"));
    assert.deepEqual(
      (await store.list()).map((conversation) => conversation.id),
      ["thread-b", "thread-a"],
    );
  });

  test("passes the events through unchanged", async () => {
    const input = runInput("thread-a", [firstMessage]);
    const events = textRun(input, "a");
    const passed = await lastValueFrom(
      store.record(input, undefined, from(events)).pipe(toArray()),
    );
    assert.deepEqual(passed, events);
  });

  test("doesn't record a thread id that isn't a plain directory name", async () => {
    const input = runInput("../escape", [firstMessage]);
    await record(input, textRun(input, "a"));
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(await store.get("../escape"), undefined);
  });

  test("has no conversations before the first run", async () => {
    rmSync(dir, { recursive: true });
    assert.deepEqual(await store.list(), []);
  });

  test("deletes a conversation, for its own user only", async () => {
    const input = runInput("thread-a", [firstMessage]);
    await record(input, textRun(input, "a"), "alice");

    assert.equal(await store.delete("thread-a", "bob"), false);
    assert.ok(await store.get("thread-a", "alice"));

    assert.equal(await store.delete("thread-a", "alice"), true);
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(await store.get("thread-a", "alice"), undefined);
    assert.equal(await store.delete("thread-a", "alice"), false);
  });

  test("a run still going on a deleted conversation doesn't bring it back", async () => {
    const input = runInput("thread-a", [firstMessage]);
    await record(input, textRun(input, "a"));

    const events$ = new Subject<BaseEvent>();
    const subscription = store.record(input, undefined, events$).subscribe();
    await store.flush();

    assert.equal(await store.delete("thread-a"), true);
    for (const event of textRun(input, "b")) {
      events$.next(event);
    }
    events$.complete();
    subscription.unsubscribe();
    await store.flush();

    assert.deepEqual(readdirSync(dir), []);
  });
});
