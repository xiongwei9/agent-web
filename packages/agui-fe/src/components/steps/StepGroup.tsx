import type { ToolCall as ToolCallData } from "@ag-ui/core";
import { ChevronRight } from "lucide-react";
import { useState } from "react";

import { SKILL_TOOL_NAME, SkillCall, skillName } from "./SkillCall";
import { StepStatus } from "./StepStatus";
import { ToolCall } from "./ToolCall";

interface StepGroupProps {
  /** Consecutive tool calls / skill activations, in call order. */
  calls: ToolCallData[];
  toolResults: Map<string, string>;
  isRunning: boolean;
}

/**
 * A run of tool calls and skill activations between pieces of the reply. They
 * are the agent's working rather than its answer, so several of them fold into
 * one line — the step count plus each step's label — that expands into the
 * list, where each step can be opened for its arguments and result.
 */
export function StepGroup({ calls, toolResults, isRunning }: StepGroupProps) {
  const [open, setOpen] = useState(false);

  const steps = calls.map((call) =>
    call.function.name === SKILL_TOOL_NAME ? (
      <SkillCall
        key={call.id}
        args={call.function.arguments}
        result={toolResults.get(call.id)}
        isRunning={isRunning}
      />
    ) : (
      <ToolCall
        key={call.id}
        name={call.function.name}
        args={call.function.arguments}
        result={toolResults.get(call.id)}
        isRunning={isRunning}
      />
    ),
  );

  // A lone step is already one line; a group around it would only add a click.
  if (calls.length === 1) {
    return steps[0];
  }

  return (
    <div>
      <button
        type="button"
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left text-[13px] text-muted transition-colors hover:text-ink"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <StepStatus done={calls.every((call) => toolResults.has(call.id))} isRunning={isRunning} />
        <span className="shrink-0">{calls.length} steps</span>
        <span className="min-w-0 flex-1 truncate opacity-75">
          {calls.map(stepLabel).join(" · ")}
        </span>
        <ChevronRight
          className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open ? (
        <div className="mt-2 ml-1.5 flex flex-col gap-2 border-l border-border pl-3.5">{steps}</div>
      ) : null}
    </div>
  );
}

function stepLabel(call: ToolCallData): string {
  if (call.function.name === SKILL_TOOL_NAME) {
    const name = skillName(call.function.arguments);
    return name ? `Skill: ${name}` : "Skill";
  }
  return call.function.name;
}
