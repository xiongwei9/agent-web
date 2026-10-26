import { AbstractAgent } from "@ag-ui/client";
import type { BaseEvent, Message, RunAgentInput } from "@ag-ui/core";
import { from, type Observable } from "rxjs";

/**
 * The conversation after a run: `input.messages` with the run's events
 * applied. The reduction is `@ag-ui/client`'s own — the code the browser runs
 * — so a reopened session shows exactly what the user saw.
 */
export async function messagesAfterRun(
  input: RunAgentInput,
  events: BaseEvent[],
): Promise<Message[]> {
  const agent = new ReplayAgent(input, events);
  try {
    await agent.runAgent({ runId: input.runId, tools: input.tools, context: input.context });
  } catch {
    // The stream of a failed or aborted run is cut short; what was applied stays.
  }
  return agent.messages;
}

/** Plays back a run's recorded events instead of running anything. */
class ReplayAgent extends AbstractAgent {
  private readonly events: BaseEvent[];

  constructor(input: RunAgentInput, events: BaseEvent[]) {
    super({ threadId: input.threadId, initialMessages: input.messages });
    this.events = events;
  }

  run(): Observable<BaseEvent> {
    return from(this.events);
  }
}
