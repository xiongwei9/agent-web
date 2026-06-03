/**
 * Static catalog of agents the server knows about. The selected agent id is
 * forwarded to the server via the `x-agent-id` header (see useChat). These
 * mirror the markdown definitions in `@ai-chat/agents`
 * (packages/agents/src/agents/definitions).
 */
export interface AgentOption {
  id: string;
  name: string;
}

export const AGENT_OPTIONS: AgentOption[] = [
  { id: "default", name: "Default Assistant" },
  { id: "OnboardingAgent", name: "Onboarding Agent" },
];

/** Endpoint the browser POSTs AG-UI runs to. Defaults to the Vite dev proxy. */
export const AGUI_URL = import.meta.env.VITE_AGUI_URL ?? "/agui";
