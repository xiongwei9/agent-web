import { EventSchemas, type AGUIEvent } from "@ag-ui/core";

export function aguiEvent(event: AGUIEvent): AGUIEvent {
  return EventSchemas.parse({
    timestamp: Date.now(),
    ...event,
  });
}
