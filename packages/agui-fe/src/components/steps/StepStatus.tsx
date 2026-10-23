import { Check, LoaderCircle } from "lucide-react";

interface StepStatusProps {
  /** The step's result has arrived. */
  done: boolean;
  /** A run is in flight, so a step without a result is still working. */
  isRunning: boolean;
}

/**
 * The status mark in front of a step: a check once it has a result, a spinner
 * while it runs, and a plain dot when the run ended without one (stopped).
 */
export function StepStatus({ done, isRunning }: StepStatusProps) {
  if (done) {
    return <Check className="size-3.5 shrink-0 text-success" />;
  }
  if (isRunning) {
    return <LoaderCircle className="size-3.5 shrink-0 animate-spin text-accent" />;
  }
  return (
    <span className="grid size-3.5 shrink-0 place-items-center" aria-hidden="true">
      <span className="size-1.5 rounded-full bg-muted" />
    </span>
  );
}
