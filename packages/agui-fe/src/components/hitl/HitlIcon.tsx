import { Flag, ListChecks, PencilLine } from "lucide-react";

import type { HitlRequest } from "../../lib/hitl";

/** Tells the prompt kinds apart: an approval, a choice, or a free-text question. */
export function HitlIcon({
  request,
  className = "",
}: {
  request: HitlRequest;
  className?: string;
}) {
  const Icon =
    request.kind === "approval" ? Flag : request.options.length > 0 ? ListChecks : PencilLine;
  return <Icon className={`size-3.5 shrink-0 text-accent ${className}`} aria-hidden="true" />;
}
