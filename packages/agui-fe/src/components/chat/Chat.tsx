import { Bug, Diamond, PanelLeftOpen, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useChat } from "../../hooks/useChat";
import { useSessions } from "../../hooks/useSessions";
import { useSkills } from "../../hooks/useSkills";
import { DebugPanel } from "../debug/DebugPanel";
import { HitlDock } from "../hitl/HitlDock";
import { Button } from "../ui/Button";
import { Composer } from "./Composer";
import { McpStatusBanner } from "./McpStatusBanner";
import { MessageList } from "../messages/MessageList";
import { SessionList } from "../sessions/SessionList";

/** How close to the bottom (px) still counts as "following" the stream. */
const STICK_THRESHOLD = 48;

/** Remembers whether the debug panel is open across reloads. */
const DEBUG_OPEN_KEY = "agui-fe:debug-open";

/** Remembers whether the sessions sidebar is collapsed across reloads. */
const SESSIONS_COLLAPSED_KEY = "agui-fe:sessions-collapsed";

export function Chat() {
  const {
    threadId,
    messages,
    status,
    error,
    pendingPrompt,
    modelCalls,
    send,
    submitA2uiAction,
    respondToToolCall,
    stop,
    reset,
    openThread,
  } = useChat();
  const skills = useSkills();
  const sessions = useSessions();
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [debugOpen, setDebugOpen] = useState(readDebugOpen);
  const [sessionsCollapsed, setSessionsCollapsed] = useState(readSessionsCollapsed);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether to keep the latest message in view as the stream grows. Scrolling
  // up to read releases it; scrolling back down (or sending) re-engages it.
  const stickRef = useRef(true);

  const isRunning = status === "running";

  useEffect(() => {
    if (isRunning) {
      stickRef.current = true;
    }
  }, [isRunning]);

  // A run that just ended has been recorded; list it (and the first time, all).
  const { refresh: refreshSessions, load: loadSession, remove: removeSession } = sessions;
  useEffect(() => {
    if (!isRunning) {
      refreshSessions();
    }
  }, [isRunning, refreshSessions]);

  const openSession = useCallback(
    (id: string) => {
      if (id === threadId) {
        return;
      }
      setSessionError(null);
      loadSession(id).then(openThread, (loadError: unknown) => {
        setSessionError(loadError instanceof Error ? loadError.message : String(loadError));
      });
    },
    [threadId, loadSession, openThread],
  );

  const deleteSession = useCallback(
    (id: string) => {
      setSessionError(null);
      // The open conversation goes too: stop its run and start afresh first, so
      // nothing more of it is recorded.
      if (id === threadId) {
        reset();
      }
      removeSession(id).catch((deleteError: unknown) => {
        setSessionError(deleteError instanceof Error ? deleteError.message : String(deleteError));
      });
    },
    [threadId, reset, removeSession],
  );

  useEffect(() => {
    const node = scrollRef.current;
    if (node && stickRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages, status]);

  const handleScroll = () => {
    const node = scrollRef.current;
    if (node) {
      stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= STICK_THRESHOLD;
    }
  };

  const toggleDebug = (open: boolean) => {
    setDebugOpen(open);
    try {
      localStorage.setItem(DEBUG_OPEN_KEY, open ? "1" : "0");
    } catch {
      // Storage unavailable; the panel just won't stay open across reloads.
    }
  };

  const toggleSessions = (collapsed: boolean) => {
    setSessionsCollapsed(collapsed);
    try {
      localStorage.setItem(SESSIONS_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // Storage unavailable; the sidebar just won't stay collapsed across reloads.
    }
  };

  return (
    <div className="flex h-full">
      {sessions.enabled ? (
        // Stays mounted while collapsed so the width can slide; inert keeps the
        // hidden list out of the tab order.
        <div
          className={`hidden shrink-0 overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none md:block ${
            sessionsCollapsed ? "w-0" : "w-64"
          }`}
          inert={sessionsCollapsed}
        >
          <SessionList
            sessions={sessions.sessions}
            activeId={threadId}
            onOpen={openSession}
            onDelete={deleteSession}
            error={sessionError}
            onCollapse={() => toggleSessions(true)}
          />
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
          {sessions.enabled && sessionsCollapsed ? (
            <button
              type="button"
              className="-ml-1 hidden cursor-pointer rounded-md border-0 bg-transparent p-1 text-muted transition-opacity duration-200 hover:text-ink starting:opacity-0 md:inline-flex"
              onClick={() => toggleSessions(false)}
              aria-label="Expand sessions"
              title="Expand sessions"
            >
              <PanelLeftOpen className="size-4" />
            </button>
          ) : null}
          <Diamond className="size-4 fill-current text-accent" aria-hidden="true" />
          <h1 className="m-0 text-base font-semibold">AG-UI Chat</h1>
          <span
            className={`inline-flex items-center gap-1.5 text-xs ${
              isRunning ? "text-accent" : "text-muted"
            }`}
          >
            <span
              className={`size-1.75 rounded-full ${
                isRunning ? "animate-pulse-soft bg-accent" : "bg-success"
              }`}
              aria-hidden="true"
            />
            {isRunning ? "Streaming…" : "Ready"}
          </span>
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto inline-flex items-center gap-1.5"
            onClick={() => toggleDebug(!debugOpen)}
            aria-pressed={debugOpen}
          >
            <Bug className="size-3.5" aria-hidden="true" />
            Debug
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={reset}
            disabled={messages.length === 0 && !isRunning}
          >
            New chat
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto" ref={scrollRef} onScroll={handleScroll}>
          <div className="mx-auto flex max-w-205 flex-col gap-4 px-5 pb-8 pt-5">
            <McpStatusBanner />
            <MessageList
              messages={messages}
              isRunning={isRunning}
              onA2uiAction={submitA2uiAction}
            />
            {error ? (
              <div className="flex items-start gap-2 rounded-xl border border-danger bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
                <TriangleAlert className="mt-0.75 size-4 shrink-0" />
                <span className="min-w-0 wrap-break-word">{error}</span>
              </div>
            ) : null}
          </div>
        </div>

        <div className="mx-auto w-full max-w-205">
          {pendingPrompt ? (
            <HitlDock
              key={pendingPrompt.toolCallId}
              request={pendingPrompt.request}
              onRespond={(content) => respondToToolCall(pendingPrompt.toolCallId, content)}
            />
          ) : null}
          {/* The agent is waiting on the prompt above, so it takes the composer's
            place until answered. Hidden, not unmounted, to keep any draft. */}
          <div hidden={pendingPrompt !== undefined}>
            <Composer onSend={send} onStop={stop} isRunning={isRunning} skills={skills} />
          </div>
        </div>
      </div>
      {debugOpen ? (
        <DebugPanel
          modelCalls={modelCalls}
          messages={messages}
          isRunning={isRunning}
          onClose={() => toggleDebug(false)}
        />
      ) : null}
    </div>
  );
}

function readDebugOpen(): boolean {
  try {
    return localStorage.getItem(DEBUG_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function readSessionsCollapsed(): boolean {
  try {
    return localStorage.getItem(SESSIONS_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}
