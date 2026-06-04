import { HttpAgent } from "@ag-ui/client";
import type { Message } from "@ag-ui/core";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { AGUI_URL } from "../lib/agents";
import { uid } from "../lib/ids";

export type ChatStatus = "idle" | "running";

export interface UseChatOptions {
  /** Agent id forwarded to the server via the `x-agent-id` header. */
  agentId: string;
}

export interface UseChat {
  messages: Message[];
  status: ChatStatus;
  error: string | null;
  /** Append a user message and start a run. */
  send: (text: string) => void;
  /**
   * Fulfill a pending `render_a2ui` tool call with the user's A2UI interaction
   * and resume the run, so the agent sees the action and continues.
   */
  submitA2uiAction: (toolCallId: string, payload: unknown) => void;
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
export function useChat({ agentId }: UseChatOptions): UseChat {
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  // Bumped by reset() to force a brand-new thread + agent instance.
  const [threadGeneration, newThread] = useReducer((n: number) => n + 1, 0);

  const agentRef = useRef<HttpAgent | null>(null);

  useEffect(() => {
    const agent = new HttpAgent({
      url: AGUI_URL,
      agentId,
      threadId: uid("thread"),
      headers: { "x-agent-id": agentId },
    });
    agentRef.current = agent;
    setMessages([]);
    setStatus("idle");
    setError(null);

    const subscription = agent.subscribe({
      onMessagesChanged: ({ messages: next }) => {
        setMessages([...next]);
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
  }, [agentId, threadGeneration]);

  const send = useCallback((text: string) => {
    const agent = agentRef.current;
    const content = text.trim();
    if (!agent || !content || agent.isRunning) {
      return;
    }

    setError(null);
    setStatus("running");
    agent.addMessage({ id: uid("msg"), role: "user", content });

    // The server's RunAgentInput schema requires `tools`/`context` arrays; pass
    // them explicitly since this client registers no frontend tools.
    void agent.runAgent({ tools: [], context: [] }).catch((runError: unknown) => {
      setError(runError instanceof Error ? runError.message : "Agent run failed");
      setStatus("idle");
    });
  }, []);

  const submitA2uiAction = useCallback((toolCallId: string, payload: unknown) => {
    const agent = agentRef.current;
    if (!agent || agent.isRunning) {
      return;
    }

    setError(null);
    setStatus("running");
    // The A2UI surface was a client-fulfilled tool call; resume the run by
    // replaying its result (the user's action + data model) — the server folds
    // it back into the prompt as a tool result. See native prompt.ts.
    agent.addMessage({
      id: uid("msg"),
      role: "tool",
      toolCallId,
      content: JSON.stringify(payload),
    });

    void agent.runAgent({ tools: [], context: [] }).catch((runError: unknown) => {
      setError(runError instanceof Error ? runError.message : "Agent run failed");
      setStatus("idle");
    });
  }, []);

  const stop = useCallback(() => {
    agentRef.current?.abortRun();
    setStatus("idle");
  }, []);

  const reset = useCallback(() => {
    agentRef.current?.abortRun();
    newThread();
  }, []);

  return { messages, status, error, send, submitA2uiAction, stop, reset };
}
