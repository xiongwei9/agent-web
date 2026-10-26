import { History, Trash2 } from "lucide-react";

import type { SessionSummary } from "../../hooks/useSessions";

interface SessionListProps {
  sessions: SessionSummary[];
  /** The open thread's id, highlighted once it's been recorded. */
  activeId: string;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  /** Why the last open or delete failed, if it did. */
  error: string | null;
}

/** The left sidebar: recorded sessions to switch between or delete. */
export function SessionList({ sessions, activeId, onOpen, onDelete, error }: SessionListProps) {
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-elevated md:flex">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3.5">
        <History className="size-4 text-muted" aria-hidden="true" />
        <h2 className="m-0 text-sm font-semibold">Sessions</h2>
      </header>
      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        {error ? <p className="m-0 px-2 py-1.5 text-xs text-danger">{error}</p> : null}
        {sessions.length === 0 ? (
          <p className="m-0 px-2 py-1.5 text-xs text-muted">
            Your conversations will show up here.
          </p>
        ) : null}
        {sessions.map((session) => {
          const active = session.id === activeId;
          const title = session.title || "Untitled";
          return (
            <div
              key={session.id}
              className={`group flex items-center rounded-lg transition-colors ${
                active ? "bg-user-bubble" : "hover:bg-border/60"
              }`}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 border-0 bg-transparent py-2 pr-1 pl-2.5 text-left"
                onClick={() => onOpen(session.id)}
                aria-current={active ? "true" : undefined}
                title={title}
              >
                <span
                  className={`truncate text-[13px] ${
                    active ? "font-medium text-accent-strong" : "text-ink"
                  }`}
                >
                  {title}
                </span>
                <span className="text-[11px] text-muted">{formatTime(session.updatedAt)}</span>
              </button>
              <button
                type="button"
                className="mr-1.5 inline-flex shrink-0 cursor-pointer rounded-md border-0 bg-transparent p-1 text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
                onClick={() => {
                  if (
                    window.confirm(`Delete "${title}"? Its messages and model calls are removed.`)
                  ) {
                    onDelete(session.id);
                  }
                }}
                aria-label={`Delete "${title}"`}
                title="Delete"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

/** Today: the time; otherwise the date and time. */
function formatTime(iso: string): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}
