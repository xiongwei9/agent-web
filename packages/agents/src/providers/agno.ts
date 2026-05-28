import { HttpAgent } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/client";
import type { Observable } from "rxjs";

import type {
  AgentConfig,
  AgentProvider,
  AgentRunner,
  AgnoProviderConfig,
} from "../types.js";

const DEFAULT_PATH = "/agui";

export const agnoAgentProvider: AgentProvider = {
  id: "agno",
  label: "Agno Agent",
  description: "Proxies AG-UI runs to a Python agno service.",
  configurationHint:
    "Set AGNO_BASE_URL to the agno service's base URL (e.g. http://127.0.0.1:8001).",
  create: ({ config }) => createAgnoRunnerFromConfig(config),
};

function createAgnoRunnerFromConfig(
  config: AgentConfig,
): AgentRunner | undefined {
  const agno = config.agno;
  const baseURL = agno?.baseURL;
  if (!baseURL) {
    return undefined;
  }

  return createAgnoRunner({
    baseURL,
    path: agno?.path,
    headers: agno?.headers,
  });
}

function createAgnoRunner(options: Required<Pick<AgnoProviderConfig, "baseURL">> &
  Pick<AgnoProviderConfig, "path" | "headers">): AgentRunner {
  const url = joinUrl(options.baseURL, options.path ?? DEFAULT_PATH);

  return (input, runnerOptions): Observable<BaseEvent> => {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (runnerOptions?.resourceId) {
      headers["x-resource-id"] = runnerOptions.resourceId;
    }

    // HttpAgent owns its AbortController, so a fresh instance per request
    // keeps cancellation scoped to that request.
    const agent = new HttpAgent({ url, headers });
    return agent.run(input);
  };
}

function joinUrl(baseURL: string, path: string): string {
  const trimmedBase = baseURL.replace(/\/+$/, "");
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}
