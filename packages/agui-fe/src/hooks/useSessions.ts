import type { CustomEvent, Message } from "@ag-ui/core";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiUrl } from "../lib/api";
import { applyDebugEvent, type ModelCall } from "../lib/debug";
import type { ChatThread } from "./useChat";

/** Mirrors `SessionSummary` from `@ai-chat/agents` (served by `GET /sessions`). */
export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface UseSessions {
  /** False when the server records no sessions (`SESSIONS_DIR=off`). */
  enabled: boolean;
  /** This browser's recorded sessions, the most recently updated first. */
  sessions: SessionSummary[];
  /** Fetch the list again, e.g. once a run has been recorded. */
  refresh: () => void;
  /** Fetch one session as a thread to open. */
  load: (id: string) => Promise<ChatThread>;
  /** Delete a session, then refresh the list. */
  remove: (id: string) => Promise<void>;
}

/** The recorded sessions the server keeps for this browser's session cookie. */
export function useSessions(): UseSessions {
  const [enabled, setEnabled] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  // Only the latest refresh may land, so a slow earlier one can't overwrite it.
  const latestRef = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    latestRef.current?.abort();
    const controller = new AbortController();
    latestRef.current = controller;
    fetch(apiUrl("sessions"), { signal: controller.signal, credentials: "include" })
      .then(async (response) => {
        if (response.ok) {
          const body = (await response.json()) as { enabled: boolean; sessions: SessionSummary[] };
          setEnabled(body.enabled);
          setSessions(body.sessions);
        }
      })
      .catch(() => {
        // Server not up yet, or superseded: keep the list as it is.
      });
  }, []);

  useEffect(() => () => latestRef.current?.abort(), []);

  const load = useCallback(async (id: string): Promise<ChatThread> => {
    const response = await fetch(apiUrl(`sessions/${encodeURIComponent(id)}`), {
      credentials: "include",
    });
    if (!response.ok) {
      throw new Error(`Couldn't open the session (HTTP ${response.status}).`);
    }
    const session = (await response.json()) as {
      id: string;
      messages: Message[];
      modelCalls: CustomEvent[];
    };
    return {
      id: session.id,
      messages: session.messages,
      modelCalls: session.modelCalls.reduce<ModelCall[]>(
        (calls, event) => applyDebugEvent(calls, event) ?? calls,
        [],
      ),
    };
  }, []);

  const remove = useCallback(
    async (id: string) => {
      const response = await fetch(apiUrl(`sessions/${encodeURIComponent(id)}`), {
        method: "DELETE",
        credentials: "include",
      });
      // Already gone (404) is what was asked for.
      if (!response.ok && response.status !== 404) {
        throw new Error(`Couldn't delete the session (HTTP ${response.status}).`);
      }
      setSessions((current) => current.filter((session) => session.id !== id));
      refresh();
    },
    [refresh],
  );

  return { enabled, sessions, refresh, load, remove };
}
