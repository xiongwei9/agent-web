import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { parse as parseYAML } from "yaml";

const MAX_NAME_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 1024;
/** The spec's `name`: lowercase alphanumeric words joined by single hyphens. */
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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
 * Discovers every skill in `dir`: each immediate sub-directory that contains a
 * `SKILL.md`. Folders without one are ignored, so non-skill assets can coexist
 * there.
 *
 * Validation is lenient, as the Agent Skills client guide recommends, so one
 * bad skill never takes the agent down: a skill whose frontmatter can't be
 * parsed or lacks a `description` is skipped, and breaking the spec's other
 * rules (the `name` format, `name` matching the folder, length limits) only
 * warns. A `name` that is already taken is skipped, and a `dir` that can't be
 * read has no skills. Each problem is reported through `warn`.
 */
export function loadSkills(dir: string, warn: (message: string) => void = () => {}): SkillSpec[] {
  let listing: Dirent[];
  try {
    listing = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    warn(
      `can't read the skills directory ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
  const entries = listing
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const skills = new Map<string, SkillSpec>();

  for (const entry of entries) {
    const skillDir = join(dir, entry.name);
    const skillFile = join(skillDir, "SKILL.md");

    let raw: string;
    try {
      raw = readFileSync(skillFile, "utf8");
    } catch {
      continue; // not a skill folder
    }

    const meta = parseSkillFrontmatter(entry.name, raw, warn);
    if (!meta) {
      continue;
    }
    const taken = skills.get(meta.name);
    if (taken) {
      warn(
        `${entry.name}/SKILL.md: skipped, the name "${meta.name}" is already used by ${relative(dir, taken.skillFile)}.`,
      );
      continue;
    }
    skills.set(meta.name, { ...meta, dir: skillDir, skillFile });
  }

  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** Returns the markdown body of a `SKILL.md` (everything after the frontmatter). */
export function readSkillBody(skillFile: string): string {
  return splitFrontmatter(readFileSync(skillFile, "utf8")).body.trim();
}

/**
 * Lists the skill's bundled files as paths relative to its directory, excluding
 * `SKILL.md` itself and dotfiles. Used to show the model what resources a skill
 * ships with.
 */
export function listSkillFiles(dir: string): string[] {
  const files: string[] = [];

  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) {
        continue;
      }
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

const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

function splitFrontmatter(raw: string): { head: string; body: string } {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return { head: "", body: raw };
  }
  return { head: match[1] ?? "", body: match[2] ?? "" };
}

/** The skill's `name` and `description`, or undefined (after warning) when it can't be loaded. */
function parseSkillFrontmatter(
  folder: string,
  raw: string,
  warn: (message: string) => void,
): SkillFrontmatter | undefined {
  const where = `${folder}/SKILL.md`;
  const { head } = splitFrontmatter(raw);
  if (!head) {
    warn(`${where}: skipped, no YAML frontmatter delimited by '---' lines.`);
    return undefined;
  }

  const meta = parseYAMLMapping(head);
  if (!meta.ok) {
    warn(`${where}: skipped, invalid YAML frontmatter — ${meta.error}`);
    return undefined;
  }

  const description = asTrimmedString(meta.value.description);
  if (!description) {
    warn(`${where}: skipped, frontmatter is missing the required \`description\`.`);
    return undefined;
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    warn(`${where}: \`description\` is longer than ${MAX_DESCRIPTION_CHARS} characters.`);
  }

  let name = asTrimmedString(meta.value.name);
  if (!name) {
    warn(`${where}: frontmatter is missing the required \`name\`; using the folder name.`);
    name = folder;
  } else if (name !== folder) {
    warn(`${where}: \`name\` "${name}" doesn't match its folder "${folder}".`);
  }
  if (name.length > MAX_NAME_CHARS || !NAME_RE.test(name)) {
    warn(
      `${where}: \`name\` "${name}" should be at most ${MAX_NAME_CHARS} lowercase letters, digits, and single hyphens, not starting or ending with a hyphen.`,
    );
  }

  return { name, description };
}

type YAMLMapping = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/**
 * Parses the frontmatter as a YAML mapping. Skills written for other clients
 * often have unquoted values containing ": " (`description: Use when: …`),
 * which strict YAML rejects; such values are quoted and the parse retried.
 */
function parseYAMLMapping(head: string): YAMLMapping {
  let parsed: unknown;
  try {
    parsed = parseYAML(head);
  } catch (error) {
    const quoted = quoteColonValues(head);
    try {
      if (quoted === head) {
        throw error;
      }
      parsed = parseYAML(quoted);
    } catch {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "it must be a YAML mapping." };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** Double-quotes top-level `key: value` lines whose plain value contains ": ". */
function quoteColonValues(head: string): string {
  return head
    .split(/\r?\n/)
    .map((line) => {
      const match = /^([A-Za-z][\w-]*):[ \t]+(.+)$/.exec(line);
      const value = match?.[2]?.trim();
      if (!match || !value || !value.includes(": ") || /^["'|>[{&*!#]/.test(value)) {
        return line;
      }
      return `${match[1]}: ${JSON.stringify(value)}`;
    })
    .join("\n");
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
