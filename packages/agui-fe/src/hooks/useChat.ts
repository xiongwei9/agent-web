import { HttpAgent } from "@ag-ui/client";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { formatA2uiUserMessage, type A2uiActionPayload } from "../lib/a2ui";
import { AGUI_URL } from "../lib/api";
import {
  findPendingHitlCalls,
  formatCancellation,
  parseHitlRequest,
  type HitlRequest,
} from "../lib/hitl";
import { uid } from "../lib/ids";

/**
 * Sends the session cookie with every run, also to a server on another origin:
 * it identifies the user, whose MCP connections and authorizations the run uses.
 */
class SessionHttpAgent extends HttpAgent {
  protected requestInit(input: RunAgentInput): RequestInit {
    return { ...super.requestInit(input), credentials: "include" };
  }
}

export type ChatStatus = "idle" | "running";

/** A Human-in-the-Loop prompt the suspended run is waiting on. */
export interface PendingPrompt {
  toolCallId: string;
  request: HitlRequest;
}

export interface UseChat {
  messages: Message[];
  status: ChatStatus;
  error: string | null;
  /**
   * The HITL prompt to answer before the conversation can go on, once the run
   * that asked it has suspended. Answer it with {@link UseChat.respondToToolCall}.
   */
  pendingPrompt: PendingPrompt | undefined;
  /** Append a user message and start a run. */
  send: (text: string) => void;
  /** Append the user's A2UI interaction as a user message and resume the run. */
  submitA2uiAction: (payload: A2uiActionPayload) => void;
  /**
   * Answer a suspended Human-in-the-Loop tool call: append the response as that
   * call's `tool` result and resume the run.
   */
  respondToToolCall: (toolCallId: string, content: string) => void;
  /** Abort the in-flight run, if any. */
  stop: () => void;
  /** Clear the conversation and start a fresh thread. */
  reset: () => void;
}

/**
 * Drives a single conversation against the AG-UI server. The heavy lifting —
 * SSE parsing and reducing the event stream into a `Message[]` — is handled by
 * `HttpAgent`; this hook mirrors that state into React and exposes
 * send/stop/reset controls.
 */
export function useChat(): UseChat {
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  // Bumped by reset() to force a brand-new thread + agent instance.
  const [threadGeneration, newThread] = useReducer((n: number) => n + 1, 0);

  const agentRef = useRef<HttpAgent | null>(null);
  // Latest messages, readable from callbacks without making them depend on state.
  const messagesRef = useRef<Message[]>([]);

  useEffect(() => {
    const agent = new SessionHttpAgent({
      url: AGUI_URL,
      threadId: uid("thread"),
    });
    agentRef.current = agent;
    messagesRef.current = [];
    setMessages([]);
    setStatus("idle");
    setError(null);

    const subscription = agent.subscribe({
      onMessagesChanged: ({ messages: next }) => {
        const snapshot = [...next];
        messagesRef.current = snapshot;
        setMessages(snapshot);
      },
      onRunErrorEvent: ({ event }) => {
        setError(event.message ?? "Agent run failed");
      },
      onRunFailed: ({ error: runError }) => {
        setError(runError.message);
        setStatus("idle");
      },
      onRunFinalized: () => {
        setStatus("idle");
      },
    });

    return () => {
      subscription.unsubscribe();
      agent.abortRun();
      agentRef.current = null;
    };
  }, [threadGeneration]);

  const pendingPrompt = useMemo(() => {
    if (status === "running") {
      return undefined;
    }
    for (const call of findPendingHitlCalls(messages)) {
      const request = parseHitlRequest(call.toolName, call.arguments);
      if (request) {
        return { toolCallId: call.toolCallId, request };
      }
    }
    return undefined;
  }, [messages, status]);

  /** Appends `newMessages` and starts a run, unless one is already in flight. */
  const run = useCallback((...newMessages: Message[]) => {
    const agent = agentRef.current;
    if (!agent || agent.isRunning) {
      return;
    }

    setError(null);
    setStatus("running");
    agent.addMessages(newMessages);

    // The server's RunAgentInput schema requires `tools`/`context` arrays; pass
    // them explicitly since this client registers no frontend tools. The HITL
    // and A2UI tools are declared server-side and fulfilled here.
    void agent.runAgent({ tools: [], context: [] }).catch((runError: unknown) => {
      setError(runError instanceof Error ? runError.message : "Agent run failed");
      setStatus("idle");
    });
  }, []);

  const send = useCallback(
    (text: string) => {
      const content = text.trim();
      if (!content) {
        return;
      }
      // The user typed instead of answering an open HITL prompt. Close those
      // calls out first: the model can't take another turn while one of its tool
      // calls has no result, and this tells it the prompt was skipped.
      const cancellations = findPendingHitlCalls(messagesRef.current).map(
        (pending): Message => ({
          id: uid("msg"),
          role: "tool",
          toolCallId: pending.toolCallId,
          content: formatCancellation(),
        }),
      );
      run(...cancellations, { id: uid("msg"), role: "user", content });
    },
    [run],
  );

  // The A2UI surface captures a direct user interaction. Resume the run with
  // that interaction as a normal user message rather than a tool result.
  const submitA2uiAction = useCallback(
    (payload: A2uiActionPayload) => {
      run({ id: uid("msg"), role: "user", content: formatA2uiUserMessage(payload) });
    },
    [run],
  );

  // The suspended run left this tool call open; answering it as a `tool`
  // message lets the model pick up exactly where it stopped.
  const respondToToolCall = useCallback(
    (toolCallId: string, content: string) => {
      run({ id: uid("msg"), role: "tool", toolCallId, content });
    },
    [run],
  );

  const stop = useCallback(() => {
    agentRef.current?.abortRun();
    setStatus("idle");
  }, []);

  const reset = useCallback(() => {
    agentRef.current?.abortRun();
    newThread();
  }, []);

  return {
    messages,
    status,
    error,
    pendingPrompt,
    send,
    submitA2uiAction,
    respondToToolCall,
    stop,
    reset,
  };
}
