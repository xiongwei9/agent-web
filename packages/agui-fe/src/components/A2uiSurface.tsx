import { useEffect, useRef, useState } from "react";

// Side-effect import: pulling `basicCatalog` from @a2ui/lit registers the
// `<a2ui-surface>` custom element and every basic-catalog component element
// (Text, Button, Card, …) and wires their Lit implementations.
import { basicCatalog } from "@a2ui/lit/v0_9";
import { MessageProcessor, type A2uiMessage, type SurfaceModel } from "@a2ui/web_core/v0_9";

import type { A2uiActionPayload } from "../lib/a2ui";

interface A2uiSurfaceProps {
  /** Ordered A2UI v0.9 messages produced by the agent (the `render_a2ui` args). */
  messages: A2uiMessage[];
  onAction: (payload: A2uiActionPayload) => void;
}

// React typing for the Lit custom element rendered below.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace React.JSX {
    interface IntrinsicElements {
      "a2ui-surface": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}

type SurfaceElement = HTMLElement & { surface?: SurfaceModel };

/**
 * Renders an agent-authored A2UI surface with the official `@a2ui/lit` renderer
 * and bubbles user actions back up (the caller resumes the run with them).
 *
 * The renderer is driven by a `MessageProcessor` from `@a2ui/web_core`: it turns
 * the message list into a `SurfaceModel` we hand to `<a2ui-surface>`, and invokes
 * our action handler when the user triggers a server action.
 */
export function A2uiSurface({ messages, onAction }: A2uiSurfaceProps) {
  const elementRef = useRef<SurfaceElement>(null);
  // Keep the latest callback without re-running the processing effect.
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  const [error, setError] = useState<string | null>(null);

  // Re-process whenever the message list changes. A *fresh* MessageProcessor per
  // pass avoids "surface already exists" when streaming deltas re-render us, and
  // means the last (complete) message list wins.
  const messagesKey = JSON.stringify(messages);
  useEffect(() => {
    const element = elementRef.current;
    if (!element) {
      return;
    }

    const processor = new MessageProcessor([basicCatalog], (action) => {
      onActionRef.current({ action, dataModel: processor.getClientDataModel() });
    });

    const subscription = processor.onSurfaceCreated((surface) => {
      element.surface = surface;
    });

    try {
      processor.processMessages(normalizeMessages(messages));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }

    return () => {
      subscription.unsubscribe();
      element.surface = undefined;
    };
    // Re-run only when the message content changes; `messages` is re-derived from
    // `messagesKey` and `onAction` is read through a ref, so neither belongs here.
  }, [messagesKey]);

  return (
    <div className="mt-2.5 overflow-hidden rounded-[10px] border border-border bg-canvas p-3">
      {error ? <p className="m-0 text-[13px] text-danger">A2UI render error: {error}</p> : null}
      <a2ui-surface ref={elementRef as React.Ref<HTMLElement>} />
    </div>
  );
}

/**
 * Coerces agent-authored messages to what the local renderer expects: every
 * `createSurface` is pinned to the installed `basicCatalog.id`, so a surface
 * still renders if the model emitted a slightly different catalog URL.
 */
function normalizeMessages(messages: A2uiMessage[]): A2uiMessage[] {
  return messages.map((message) => {
    if ("createSurface" in message && message.createSurface) {
      return {
        ...message,
        createSurface: { ...message.createSurface, catalogId: basicCatalog.id },
      } as A2uiMessage;
    }
    return message;
  });
}
