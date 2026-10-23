import { Check } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The marks in front of an option, shared by the open prompt and its record so
 * an answer reads the way it was given: a number key for single choice, a
 * checkbox for multi-select.
 */
export function KeyHint({ active = false, children }: { active?: boolean; children: ReactNode }) {
  return (
    <span
      className={`mt-px grid size-5 shrink-0 place-items-center rounded-md border font-mono text-[11px] ${
        active
          ? "border-accent-strong bg-accent-strong text-white"
          : "border-border bg-canvas text-muted"
      }`}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}

export function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span
      className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded border transition-colors ${
        checked ? "border-accent-strong bg-accent-strong text-white" : "border-border bg-canvas"
      }`}
      aria-hidden="true"
    >
      {checked ? <Check className="size-3" strokeWidth={3} /> : null}
    </span>
  );
}
