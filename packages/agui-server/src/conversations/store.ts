import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BaseEvent, Message, RunAgentInput } from "@ag-ui/core";
import { isModelCallEvent, type AgentLogger } from "@ai-chat/agents";
import { Observable } from "rxjs";

import { messagesAfterRun } from "./replay.ts";

const CONVERSATION_FILE = "session.json";
const MODEL_CALLS_FILE = "model-calls.jsonl";
/** A thread id names a directory, so only plain ones are recorded. */
const THREAD_ID_PATTERN = /^[\w-]{1,128}$/;
const TITLE_MAX_LENGTH = 80;

/** A recorded conversation — one thread — as a list shows it. */
export interface ConversationSummary {
  /** The thread id. */
  id: string;
  /** The first user message, shortened. */
  title: string;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDetail extends ConversationSummary {
  /** The conversation as the client held it after the latest run. */
  messages: Message[];
  /** Every model call, as the agent's model call events (`isModelCallEvent`). */
  modelCalls: BaseEvent[];
}

interface ConversationFile extends ConversationSummary {
  /** Whose runs recorded it; absent for the shared scope. */
  userId?: string;
  messages: Message[];
}

/**
 * Records each thread to `<dir>/<threadId>/`: `session.json` holds the
 * conversation (rewritten when a run starts and when it ends), and
 * `model-calls.jsonl` gets every model call's request and response appended as
 * they happen, one model call event per line.
 *
 * These are the "sessions" of `SESSIONS_DIR` and `/sessions`; the code calls
 * them conversations to keep them apart from the cookie session (session.ts).
 * Each belongs to the user (`userId`, from that cookie) whose runs recorded it;
 * to anyone else it reads as missing.
 */
export class ConversationStore {
  private readonly dir: string;
  private readonly logger: AgentLogger;
  /** Each conversation's pending writes and deletes, chained so they land in order. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(dir: string, logger: AgentLogger) {
    this.dir = dir;
    this.logger = logger;
  }

  /** The user's conversations, the most recently updated first. */
  async list(userId?: string): Promise<ConversationSummary[]> {
    let ids: string[];
    try {
      ids = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const conversations = await Promise.all(ids.map((id) => this.readConversation(id)));
    return conversations
      .filter(
        (conversation): conversation is ConversationFile =>
          conversation !== undefined && conversation.userId === userId,
      )
      .map(summarize)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string, userId?: string): Promise<ConversationDetail | undefined> {
    const conversation = THREAD_ID_PATTERN.test(id) ? await this.readConversation(id) : undefined;
    if (!conversation || conversation.userId !== userId) {
      return undefined;
    }
    return {
      ...summarize(conversation),
      messages: conversation.messages,
      modelCalls: await this.readModelCalls(id),
    };
  }

  /**
   * Deletes the conversation's folder; false if the user has no such
   * conversation. A run still going on it records nothing more.
   */
  async delete(id: string, userId?: string): Promise<boolean> {
    if (!THREAD_ID_PATTERN.test(id)) {
      return false;
    }
    // Queued behind the conversation's pending writes, so none lands after it.
    return this.enqueue(id, async () => {
      const conversation = await this.readConversation(id);
      if (!conversation || conversation.userId !== userId) {
        return false;
      }
      await rm(join(this.dir, id), { recursive: true, force: true });
      return true;
    });
  }

  /**
   * Passes a run's events through, recording the run into its thread's
   * conversation. A thread recorded by another user is left alone.
   */
  record(
    input: RunAgentInput,
    userId: string | undefined,
    events$: Observable<BaseEvent>,
  ): Observable<BaseEvent> {
    const id = input.threadId;
    if (!THREAD_ID_PATTERN.test(id)) {
      this.logger.warn(`[sessions] not recording thread "${id}": not a usable directory name`);
      return events$;
    }

    return new Observable<BaseEvent>((subscriber) => {
      let conversation: ConversationFile | undefined;
      const write = (task: (conversation: ConversationFile) => Promise<void>) =>
        this.enqueueWrite(id, async () => {
          if (!conversation) {
            return;
          }
          try {
            await task(conversation);
          } catch (error) {
            // Deleted while the run went on: the rest of it isn't recorded.
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
          }
        });
      this.enqueueWrite(id, async () => {
        conversation = await this.begin(id, userId, input);
      });

      const events: BaseEvent[] = [];
      let finished = false;
      // Once, however the run ends: completed, failed, or the client left.
      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        write(async (current) => {
          const messages = await messagesAfterRun(input, events);
          await this.writeConversation({ ...current, updatedAt: now(), messages });
        });
      };

      const subscription = events$.subscribe({
        next: (event) => {
          events.push(event);
          if (isModelCallEvent(event)) {
            write(() =>
              appendFile(join(this.dir, id, MODEL_CALLS_FILE), `${JSON.stringify(event)}\n`),
            );
          }
          subscriber.next(event);
        },
        error: (error: unknown) => {
          finish();
          subscriber.error(error);
        },
        complete: () => {
          finish();
          subscriber.complete();
        },
      });

      return () => {
        subscription.unsubscribe();
        finish();
      };
    });
  }

  /** Saves the conversation as the run starts; undefined if the conversation isn't this user's. */
  private async begin(
    id: string,
    userId: string | undefined,
    input: RunAgentInput,
  ): Promise<ConversationFile | undefined> {
    const existing = await this.readConversation(id);
    if (existing && existing.userId !== userId) {
      this.logger.warn(`[sessions] not recording thread "${id}": it belongs to another user`);
      return undefined;
    }
    const timestamp = now();
    const conversation: ConversationFile = {
      id,
      userId,
      title: existing?.title || titleOf(input.messages),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      messages: input.messages,
    };
    await mkdir(join(this.dir, id), { recursive: true });
    await this.writeConversation(conversation);
    return conversation;
  }

  private async writeConversation(conversation: ConversationFile): Promise<void> {
    await writeFile(
      join(this.dir, conversation.id, CONVERSATION_FILE),
      `${JSON.stringify(conversation, null, 2)}\n`,
    );
  }

  private async readConversation(id: string): Promise<ConversationFile | undefined> {
    try {
      return JSON.parse(
        await readFile(join(this.dir, id, CONVERSATION_FILE), "utf8"),
      ) as ConversationFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn(`[sessions] skipping "${id}": ${errorMessage(error)}`);
      }
      return undefined;
    }
  }

  private async readModelCalls(id: string): Promise<BaseEvent[]> {
    let text: string;
    try {
      text = await readFile(join(this.dir, id, MODEL_CALLS_FILE), "utf8");
    } catch {
      return [];
    }
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BaseEvent);
  }

  /** Runs `task` after the conversation's queued work; a failure rejects only its own result. */
  private enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(id) ?? Promise.resolve()).then(task);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(id, settled);
    void settled.then(() => {
      if (this.queues.get(id) === settled) {
        this.queues.delete(id);
      }
    });
    return result;
  }

  /** A recording write: a failure is logged, never thrown at the run. */
  private enqueueWrite(id: string, task: () => Promise<void>): void {
    this.enqueue(id, task).catch((error: unknown) => {
      this.logger.error(`[sessions] failed to record "${id}": ${errorMessage(error)}`);
    });
  }

  /** Resolves once every write queued so far has landed (for tests). */
  async flush(): Promise<void> {
    await Promise.all(this.queues.values());
  }
}

function summarize({ id, title, createdAt, updatedAt }: ConversationFile): ConversationSummary {
  return { id, title, createdAt, updatedAt };
}

/** The first user message's text, on one line and shortened. */
function titleOf(messages: Message[]): string {
  const first = messages.find((message) => message.role === "user");
  const content = first?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (part.type === "text" ? part.text : "")).join(" ")
        : "";
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TITLE_MAX_LENGTH ? `${line.slice(0, TITLE_MAX_LENGTH - 1)}…` : line;
}

function now(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
