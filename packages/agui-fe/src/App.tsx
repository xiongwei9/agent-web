import { useState } from "react";

import { Chat } from "./components/Chat";
import { AGENT_OPTIONS } from "./lib/agents";

export function App() {
  const [agentId, setAgentId] = useState(AGENT_OPTIONS[0]?.id ?? "default");

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-elevated px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="text-xl text-accent" aria-hidden="true">
            ◆
          </span>
          <h1 className="m-0 text-[17px] font-semibold">AG-UI Chat</h1>
        </div>
        <label className="flex items-center gap-2 text-[13px] text-muted">
          <span>Agent</span>
          <select
            className="cursor-pointer rounded-lg border border-border bg-input px-2.5 py-1.5 text-sm text-ink"
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
          >
            {AGENT_OPTIONS.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
      </header>
      {/* Remount the conversation when the agent changes so each agent gets a
          fresh thread. */}
      <Chat key={agentId} agentId={agentId} />
    </div>
  );
}
