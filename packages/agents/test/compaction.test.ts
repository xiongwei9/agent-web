import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CompactionCache,
  compactPromptIfNeeded,
  estimateTokens,
  resolveCompactionOptions,
  type CompactionOptions,
} from "../src/loop/compaction.ts";
import type { ModelMessage } from "../src/model/types.ts";
import { scriptedModel, textTurn } from "./helpers.ts";

const SYSTEM: ModelMessage = { role: "system", content: "You are helpful." };

/** A user/assistant exchange of roughly `words` tokens each. */
function exchange(index: number, words = 200): ModelMessage[] {
  const filler = ` word${index}`.repeat(words);
  return [
    { role: "user", content: [{ type: "text", text: `question ${index}${filler}` }] },
    { role: "assistant", content: [{ type: "text", text: `answer ${index}${filler}` }] },
  ];
}

function history(count: number, words?: number): ModelMessage[] {
  return Array.from({ length: count }, (_, index) => exchange(index, words)).flat();
}

const signal = new AbortController().signal;

function options(maxTokens: number): CompactionOptions {
  return { enabled: true, maxTokens, keepRecentMessages: 2 };
}

function isSummary(message: ModelMessage | undefined): boolean {
  return (
    message?.role === "user" &&
    message.content[0]!.text.startsWith("[Earlier conversation summary]")
  );
}

describe("resolveCompactionOptions", () => {
  test("defaults the threshold to 80% of the context window", () => {
    assert.deepEqual(resolveCompactionOptions(undefined, 200_000), {
      enabled: true,
      maxTokens: 160_000,
      keepRecentMessages: 8,
    });
  });

  test("keeps explicit settings", () => {
    assert.deepEqual(
      resolveCompactionOptions({ maxTokens: 1_000, keepRecentMessages: 3 }, 200_000),
      { enabled: true, maxTokens: 1_000, keepRecentMessages: 3 },
    );
  });

  test("ignores fields that are present but undefined", () => {
    assert.equal(resolveCompactionOptions({ maxTokens: undefined }, 100_000).maxTokens, 80_000);
  });
});

describe("compactPromptIfNeeded", () => {
  test("leaves a prompt under the threshold alone", async () => {
    const { model, calls } = scriptedModel([]);
    const prompt = [SYSTEM, ...history(2)];
    assert.equal(await compactPromptIfNeeded(prompt, model, options(1_000_000), signal), prompt);
    assert.equal(calls.length, 0);
  });

  test("summarizes the older messages and keeps the recent ones", async () => {
    const { model, calls } = scriptedModel([textTurn("summary A")]);
    const prompt = [SYSTEM, ...history(4)];
    const compacted = await compactPromptIfNeeded(prompt, model, options(500), signal);

    assert.equal(calls.length, 1);
    assert.deepEqual(compacted[0], SYSTEM);
    assert.ok(isSummary(compacted[1]));
    assert.deepEqual(compacted.slice(2), prompt.slice(-2));
  });
});

describe("compactPromptIfNeeded across runs", () => {
  test("reuses a thread's summary instead of summarizing again", async () => {
    const cache = new CompactionCache();
    const memory = { cache, threadId: "t1" };
    const { model, calls } = scriptedModel([textTurn("summary A")]);

    // Run 1: over the threshold, summarized once.
    const first = [SYSTEM, ...history(4)];
    const compacted = await compactPromptIfNeeded(first, model, options(1_000), signal, memory);
    assert.equal(calls.length, 1);
    const budget = estimateTokens(compacted) + 300;

    // Run 2: the client resends the full history plus a new message. The
    // summary is reapplied; nothing new to summarize under this budget.
    const second: ModelMessage[] = [
      ...first,
      { role: "user", content: [{ type: "text", text: "and one more thing" }] },
    ];
    const reused = await compactPromptIfNeeded(second, model, options(budget), signal, memory);

    assert.equal(calls.length, 1, "no second summarization call");
    assert.ok(isSummary(reused[1]));
    assert.equal(reused.at(-1), second.at(-1));
    assert.ok(reused.length < second.length);
  });

  test("extends the summary incrementally when the history keeps growing", async () => {
    const cache = new CompactionCache();
    const memory = { cache, threadId: "t1" };
    const { model, calls } = scriptedModel([textTurn("summary A"), textTurn("summary B")]);

    const first = [SYSTEM, ...history(4)];
    await compactPromptIfNeeded(first, model, options(1_000), signal, memory);

    const second = [SYSTEM, ...history(8)];
    const compacted = await compactPromptIfNeeded(second, model, options(1_000), signal, memory);

    assert.equal(calls.length, 2);
    // The second summarization starts from the first summary, not from scratch.
    const input = calls[1]!.prompt[1]!;
    assert.ok(input.role === "user" && input.content[0]!.text.includes("summary A"));
    assert.ok(input.role === "user" && !input.content[0]!.text.includes("question 0 "));
    assert.ok(isSummary(compacted[1]));
    assert.ok(
      compacted[1]!.role === "user" && compacted[1]!.content[0]!.text.includes("summary B"),
    );

    // And the cache now covers the longer prefix: a third run reuses summary B.
    const third = [SYSTEM, ...history(8)];
    const reused = await compactPromptIfNeeded(third, model, options(100_000), signal, memory);
    assert.equal(calls.length, 2);
    assert.ok(reused[1]!.role === "user" && reused[1]!.content[0]!.text.includes("summary B"));
  });

  test("doesn't reuse a summary when the history was edited", async () => {
    const cache = new CompactionCache();
    const memory = { cache, threadId: "t1" };
    const { model, calls } = scriptedModel([textTurn("summary A"), textTurn("summary B")]);

    await compactPromptIfNeeded([SYSTEM, ...history(4)], model, options(1_000), signal, memory);
    const edited = [SYSTEM, ...history(4)];
    edited[1] = { role: "user", content: [{ type: "text", text: "a different first question" }] };
    const result = await compactPromptIfNeeded(edited, model, options(100_000), signal, memory);

    assert.equal(result, edited, "under the threshold and nothing to reuse");
    assert.equal(calls.length, 1);
  });

  test("keeps threads apart", async () => {
    const cache = new CompactionCache();
    const { model, calls } = scriptedModel([textTurn("summary A")]);
    await compactPromptIfNeeded([SYSTEM, ...history(4)], model, options(1_000), signal, {
      cache,
      threadId: "t1",
    });

    const prompt = [SYSTEM, ...history(4)];
    const other = await compactPromptIfNeeded(prompt, model, options(100_000), signal, {
      cache,
      threadId: "t2",
    });
    assert.equal(other, prompt);
    assert.equal(calls.length, 1);
  });
});

describe("CompactionCache", () => {
  test("evicts the least recently used thread", () => {
    const cache = new CompactionCache(2);
    const entry = { covered: 1, hash: "h", summary: "s" };
    cache.set("a", entry);
    cache.set("b", entry);
    cache.get("a");
    cache.set("c", entry);

    assert.ok(cache.get("a"));
    assert.equal(cache.get("b"), undefined);
    assert.ok(cache.get("c"));
  });
});
