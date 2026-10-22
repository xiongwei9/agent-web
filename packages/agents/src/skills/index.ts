/**
 * Agent Skills document store.
 *
 * This module owns *only* the skill content — the `SKILL.md` files (plus their
 * `references/` / `scripts/` / `assets/`) sitting in sibling folders here,
 * following the Agent Skills spec (https://github.com/anthropics/skills). Each
 * skill is a sub-folder of this directory whose `SKILL.md` has YAML frontmatter
 * (`name`, `description`) and a markdown body of instructions.
 *
 * It exposes discovery and progressive-disclosure helpers; the runtime's
 * `SkillsToolset` turns them into the `Skill` / `read_skill_file` /
 * `run_skill_script` tools. Maintain skills by editing the skill folders here;
 * no runtime or agent code changes are needed.
 *
 * Build note: the compiled package must mirror these skill folders next to the
 * built `index.js` so it can read the same files. The package build script
 * handles the recursive copy.
 */

export {
  loadSkills,
  readSkillBody,
  listSkillFiles,
  resolveWithinSkill,
  type SkillSpec,
} from "./loader.ts";
