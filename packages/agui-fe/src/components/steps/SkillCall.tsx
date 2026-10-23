import { StepStatus } from "./StepStatus";

/** Tool the agent calls to load an Agent Skill's instructions. */
export const SKILL_TOOL_NAME = "Skill";

interface SkillCallProps {
  /** Raw JSON argument string, streamed incrementally by the server. */
  args: string;
  /** Present once the skill's instructions have loaded. */
  result?: string;
  isRunning: boolean;
}

/**
 * A one-line note that the agent loaded a skill. The instructions themselves
 * are for the model, so unlike a tool step there's nothing to expand.
 */
export function SkillCall({ args, result, isRunning }: SkillCallProps) {
  const name = skillName(args);
  const loaded = result !== undefined;

  return (
    <div className="flex items-center gap-2 text-[13px] text-muted">
      <StepStatus done={loaded} isRunning={isRunning} />
      <span className="min-w-0 truncate">
        {loaded ? "Using skill" : "Loading skill"}{" "}
        {name ? <span className="font-mono font-semibold text-ink">{name}</span> : null}
      </span>
    </div>
  );
}

/** The skill's name, once the arguments have streamed in. */
export function skillName(args: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(args);
    if (typeof parsed === "object" && parsed !== null && "name" in parsed) {
      return typeof parsed.name === "string" ? parsed.name : undefined;
    }
  } catch {
    // Incomplete JSON while streaming.
  }
  return undefined;
}
