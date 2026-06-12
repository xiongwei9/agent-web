import { HttpAgent } from "@ag-ui/client";
import type { Message } from "@ag-ui/core";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { formatA2uiUserMessage, type A2uiActionPayload } from "../lib/a2ui";
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
  /** Append the user's A2UI interaction as a user message and resume the run. */
  submitA2uiAction: (payload: A2uiActionPayload) => void;
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

  const submitA2uiAction = useCallback((payload: A2uiActionPayload) => {
    const agent = agentRef.current;
    if (!agent || agent.isRunning) {
      return;
    }

    setError(null);
    setStatus("running");
    // The A2UI surface captures a direct user interaction. Resume the run with
    // that interaction as a normal user message rather than a tool result.
    agent.addMessage({
      id: uid("msg"),
      role: "user",
      content: formatA2uiUserMessage(payload),
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
