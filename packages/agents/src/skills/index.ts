import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Agent Skills document store.
 *
 * This module owns *only* the skill content — the `SKILL.md` files (plus their
 * `references/` / `scripts/` / `assets/`) sitting in sibling folders here,
 * following the Agent Skills spec (https://github.com/anthropics/skills). Each
 * skill is a sub-folder of this directory whose `SKILL.md` has YAML frontmatter
 * (`name`, `description`) and a markdown body of instructions.
 *
 * It is deliberately decoupled from agents and providers: it exposes *where*
 * the skills live, not *how* they are loaded. Each provider wires these skills
 * up using its own mechanism — the Mastra provider feeds `SKILLS_BASE_PATH` +
 * `SKILL_DEFINITION_PATHS` to a Mastra `Workspace` / `LocalSkillSource`, while
 * the native provider uses {@link loadSkills} and the progressive-disclosure
 * helpers below to drive a hand-written skill toolset. Maintain skills by
 * editing the skill folders here; no provider or agent code changes are needed.
 *
 * Build note: the compiled package must mirror these skill folders next to the
 * built `index.js` so it can read the same files. The package build script
 * handles the recursive copy.
 */

/** Absolute path to this skills directory — the base the skill paths resolve against. */
export const SKILLS_BASE_PATH: string = dirname(fileURLToPath(import.meta.url));

/**
 * Skill source paths relative to {@link SKILLS_BASE_PATH}, suitable for a
 * framework skill resolver that scans for `SKILL.md` folders. `"."` means the
 * skills directory itself holds one folder per skill (no nesting level).
 */
export const SKILL_DEFINITION_PATHS: readonly string[] = ["."];

export {
  loadSkills,
  readSkillBody,
  listSkillFiles,
  resolveWithinSkill,
  type SkillSpec,
} from "./loader.ts";
