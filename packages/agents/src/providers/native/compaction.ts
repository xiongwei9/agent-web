import { get_encoding, type Tiktoken } from "tiktoken";

import type {
  ModelCallOptions,
  ModelMessage,
  ModelStreamPart,
  NativeLanguageModel,
} from "./types.ts";

/**
 * Context compaction ("prompt optimization"): when the prompt grows too large —
 * either from a long conversation history or from many tool-call rounds within
 * a single run — the older portion is summarized by the model and replaced with
 * a compact summary message, while the system prompt and the most recent
 * messages are kept verbatim.
 *
 * This keeps multi-turn, tool-heavy runs inside the model's context window
 * without losing the thread of what happened earlier.
 */
export interface CompactionOptions {
  /** Master switch. When false, the prompt is never compacted. */
  enabled: boolean;
  /**
   * Compact once the estimated prompt token count exceeds this. Set it
   * comfortably below the model's hard context limit so there is room for the
   * model's response (and the next turn's growth) before the window fills.
   */
  maxTokens: number;
  /**
   * Always keep at least this many of the most recent messages verbatim. The
   * actual boundary may include a few more to avoid orphaning a tool result
   * from its tool call.
   */
  keepRecentMessages: number;
}

export const DEFAULT_COMPACTION: CompactionOptions = {
  enabled: true,
  // Tuned for a 1M-token context window: trigger at ~80% to leave headroom for
  // the model's response and the next turn before the hard limit. Override via
  // AgentExecutionConfig.contextCompaction.maxTokens for smaller windows.
  maxTokens: 800_000,
  keepRecentMessages: 8,
};

/** Merges a partial config from agent execution settings onto the defaults. */
export function resolveCompactionOptions(
  partial: Partial<CompactionOptions> | undefined,
): CompactionOptions {
  return { ...DEFAULT_COMPACTION, ...partial };
}

/**
 * Per-message framing overhead in the chat format (role marker + delimiters).
 * OpenAI documents ~3–4 tokens per message on top of the content; we fold that
 * in so the estimate tracks the real request size rather than just content.
 */
const TOKENS_PER_MESSAGE = 4;

/**
 * Estimates the prompt's token count with a real BPE tokenizer (`tiktoken`,
 * the `o200k_base` encoding used by GPT-4o/4.1/o-series) rather than a
 * char-count heuristic. Counts are exact for modern OpenAI models and a close
 * approximation for Anthropic/Google — accurate enough to decide whether the
 * (far more expensive) summarization call is worth making.
 *
 * If the WASM encoder fails to load or tokenization throws on unexpected input,
 * it falls back to the cheap ~4-chars/token heuristic so the loop never breaks
 * on a counting error.
 */
export function estimateTokens(prompt: ModelMessage[]): number {
  let tokens = 0;
  for (const message of prompt) {
    tokens += countTextTokens(messageText(message)) + TOKENS_PER_MESSAGE;
  }
  return tokens;
}

/**
 * The WASM encoder is created once and shared for the process lifetime. It must
 * never be `free()`d — doing so frees the underlying WASM memory and breaks all
 * later calls. `null` records a load failure so we stop retrying and fall back.
 */
let sharedEncoder: Tiktoken | null | undefined;

function getEncoder(): Tiktoken | null {
  if (sharedEncoder === undefined) {
    try {
      sharedEncoder = get_encoding("o200k_base");
    } catch {
      sharedEncoder = null;
    }
  }
  return sharedEncoder;
}

function countTextTokens(text: string): number {
  if (!text) {
    return 0;
  }
  const encoder = getEncoder();
  if (!encoder) {
    return Math.ceil(text.length / 4);
  }
  try {
    // Empty special-token sets => treat the entire string as plain text, so a
    // literal "<|endoftext|>" in conversation content can't raise.
    return encoder.encode(text, [], []).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

/**
 * Returns a possibly-compacted copy of `prompt`. When the estimate is under the
 * threshold (or compaction is disabled, or no safe split exists) the original
 * array is returned unchanged.
 *
 * The split is chosen so the most recent `keepRecentMessages` messages stay
 * verbatim and the boundary never starts on a `tool` message — that guarantees
 * we never separate a `tool` result from the assistant `tool-call` that
 * produced it, which the model providers reject.
 */
export async function compactPromptIfNeeded(
  prompt: ModelMessage[],
  model: NativeLanguageModel,
  options: CompactionOptions,
  abortSignal: AbortSignal,
): Promise<ModelMessage[]> {
  if (!options.enabled || estimateTokens(prompt) <= options.maxTokens) {
    return prompt;
  }

  // Leading system messages (persona + request context) are never summarized.
  let systemEnd = 0;
  while (systemEnd < prompt.length && prompt[systemEnd].role === "system") {
    systemEnd += 1;
  }
  const system = prompt.slice(0, systemEnd);
  const body = prompt.slice(systemEnd);

  const splitAt = chooseSplitIndex(body, options.keepRecentMessages);
  if (splitAt <= 0) {
    return prompt;
  }

  const older = body.slice(0, splitAt);
  const recent = body.slice(splitAt);

  const summary = await summarize(older, model, abortSignal);
  if (!summary) {
    return prompt;
  }

  const summaryMessage: ModelMessage = {
    role: "user",
    content: [{ type: "text", text: `[Earlier conversation summary]\n\n${summary}` }],
  };

  return [...system, summaryMessage, ...recent];
}

/**
 * Picks the index in `body` where the verbatim tail begins. Targets
 * `body.length - keepRecent`, then advances past any `tool` messages so the
 * tail never opens with an orphaned tool result. Returns 0 when no safe,
 * non-empty split exists.
 */
function chooseSplitIndex(body: ModelMessage[], keepRecent: number): number {
  let index = Math.max(0, body.length - keepRecent);
  while (index < body.length && body[index].role === "tool") {
    index += 1;
  }
  // If advancing consumed everything (the whole tail was tool results) there is
  // nothing left to keep — fall back to no compaction.
  return index >= body.length ? 0 : index;
}

const SUMMARY_SYSTEM =
  "You compress conversation history. Summarize the conversation segment below " +
  "into a concise but information-dense brief that lets an assistant continue " +
  "seamlessly. Preserve: the user's goals and constraints, key decisions and " +
  "their rationale, facts and data discovered, tool calls made and their " +
  "outcomes, and any unfinished tasks. Omit pleasantries and redundancy. Use " +
  "compact bullet points. Output only the summary.";

/** Runs a single non-tool model call and returns the accumulated text. */
async function summarize(
  messages: ModelMessage[],
  model: NativeLanguageModel,
  abortSignal: AbortSignal,
): Promise<string | undefined> {
  const callOptions: ModelCallOptions = {
    prompt: [
      { role: "system", content: SUMMARY_SYSTEM },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Summarize this conversation segment:\n\n${serialize(messages)}`,
          },
        ],
      },
    ],
    temperature: 0,
    abortSignal,
  };

  try {
    const { stream } = await model.doStream(callOptions);
    const text = await collectText(stream);
    return text.trim() || undefined;
  } catch {
    // A failed summarization must not abort the run — fall back to the
    // uncompacted prompt by signalling "no summary".
    return undefined;
  }
}

async function collectText(stream: ReadableStream<ModelStreamPart>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value.type === "text-delta") {
        text += value.delta;
      } else if (value.type === "error") {
        throw value.error instanceof Error ? value.error : new Error(String(value.error));
      }
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

/** Renders messages as plain text for the summarizer to read. */
function serialize(messages: ModelMessage[]): string {
  return messages.map((message) => `## ${message.role}\n${messageText(message)}`).join("\n\n");
}

/** Extracts a flat text view of a message for estimation and serialization. */
function messageText(message: ModelMessage): string {
  if (message.role === "system") {
    return message.content;
  }
  if (message.role === "user") {
    return message.content.map((part) => part.text).join("\n");
  }
  if (message.role === "assistant") {
    return message.content
      .map((part) =>
        part.type === "text" ? part.text : `[tool-call ${part.toolName} ${safeJson(part.input)}]`,
      )
      .join("\n");
  }
  // tool
  return message.content
    .map((part) => `[tool-result ${part.toolName}] ${part.output.value}`)
    .join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
