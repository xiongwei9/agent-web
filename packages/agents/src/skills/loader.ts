import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYAML } from "yaml";

const SKILLS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Framework-neutral description of an Agent Skill — identity, instructions, and
 * the directory holding its bundled resources (`references/`, `scripts/`, …).
 *
 * This is the discovery half of progressive disclosure: callers get the cheap
 * `name` + `description` up front (Level 1) and read `skillFile` / walk `dir`
 * only when a skill is actually invoked (Levels 2–3). Nothing here knows how a
 * given provider surfaces skills to a model.
 */
export interface SkillSpec {
  /** Skill identifier from frontmatter `name`. Unique across the store. */
  name: string;
  /** One-line `description` from frontmatter — the trigger hint shown to the model. */
  description: string;
  /** Absolute path to the skill's directory. */
  dir: string;
  /** Absolute path to the skill's `SKILL.md`. */
  skillFile: string;
}

/**
 * Discovers every skill in the store: each immediate sub-directory that
 * contains a `SKILL.md` with valid `name` / `description` frontmatter. Folders
 * without a `SKILL.md` are ignored, so non-skill assets can coexist here.
 */
export function loadSkills(): SkillSpec[] {
  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
  const skills: SkillSpec[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = join(SKILLS_DIR, entry.name);
    const skillFile = join(dir, "SKILL.md");

    let raw: string;
    try {
      raw = readFileSync(skillFile, "utf8");
    } catch {
      continue; // not a skill folder
    }

    const meta = parseSkillFrontmatter(entry.name, raw);
    skills.push({ name: meta.name, description: meta.description, dir, skillFile });
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

/** Returns the markdown body of a `SKILL.md` (everything after the frontmatter). */
export function readSkillBody(skillFile: string): string {
  return splitFrontmatter(readFileSync(skillFile, "utf8")).body.trim();
}

/**
 * Lists the skill's bundled files as paths relative to its directory, excluding
 * `SKILL.md` itself. Used to show the model what resources a skill ships with.
 */
export function listSkillFiles(dir: string): string[] {
  const files: string[] = [];

  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile() && !(current === dir && entry.name === "SKILL.md")) {
        files.push(relative(dir, absolute));
      }
    }
  };

  walk(dir);
  return files.sort();
}

/**
 * Resolves a path relative to a skill's directory, rejecting anything that
 * escapes it (absolute paths, `..` traversal). Guards the file-read and
 * script-run tools so a skill can only touch its own bundle.
 */
export function resolveWithinSkill(dir: string, relativePath: string): string {
  const base = resolve(dir);
  const target = resolve(base, relativePath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`Path "${relativePath}" escapes the skill directory.`);
  }
  return target;
}

interface SkillFrontmatter {
  name: string;
  description: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function splitFrontmatter(raw: string): { head: string; body: string } {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return { head: "", body: raw };
  }
  return { head: match[1] ?? "", body: match[2] ?? "" };
}

function parseSkillFrontmatter(folder: string, raw: string): SkillFrontmatter {
  const { head } = splitFrontmatter(raw);
  if (!head) {
    throw new Error(`${folder}/SKILL.md: missing YAML frontmatter delimited by '---' lines.`);
  }

  let parsed: unknown;
  try {
    parsed = parseYAML(head);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${folder}/SKILL.md: invalid YAML frontmatter — ${detail}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${folder}/SKILL.md: frontmatter must be a YAML mapping.`);
  }

  const meta = parsed as Record<string, unknown>;
  const name = typeof meta.name === "string" ? meta.name.trim() : "";
  const description = typeof meta.description === "string" ? meta.description.trim() : "";
  if (!name) {
    throw new Error(`${folder}/SKILL.md: frontmatter is missing required \`name\`.`);
  }
  if (!description) {
    throw new Error(`${folder}/SKILL.md: frontmatter is missing required \`description\`.`);
  }

  return { name, description };
}
