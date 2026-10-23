/**
 * Agent Skills (https://agentskills.io/specification): discovery and
 * progressive-disclosure helpers over directories of skill folders, each with
 * a `SKILL.md` (YAML frontmatter `name` / `description` plus a markdown body
 * of instructions) and optional `references/` / `scripts/` / `assets/`.
 *
 * The skills themselves live outside this package, in the directories
 * `AgentConfig.skills.dirs` names (the server's default is `packages/skills/`).
 * The runtime's `SkillsToolset` turns them into the `Skill` /
 * `read_skill_file` / `run_skill_script` tools and the `/skill-name` commands.
 */

export {
  loadSkills,
  readSkillBody,
  listSkillFiles,
  resolveWithinSkill,
  type SkillSpec,
} from "./loader.ts";
