import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

import {
  listSkillFiles,
  loadSkills,
  readSkillBody,
  resolveWithinSkill,
  type SkillSpec,
} from "./index.ts";
import type { AgentCapability } from "../capability.ts";
import type { ServerTool } from "../tools/types.ts";
import type { AgentLogger, SkillInfo } from "../types.ts";
import { wrapSkillContent } from "./content.ts";

const SCRIPT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 100_000;
/** What a script may print before it's killed; the model still gets only `MAX_OUTPUT_CHARS`. */
const MAX_SCRIPT_OUTPUT_BYTES = 10 * 1024 * 1024;
/** How many bundled files the `Skill` tool lists. */
const MAX_LISTED_FILES = 100;
/** How much of a file is checked for NUL bytes to tell binary from text. */
const BINARY_SNIFF_BYTES = 8_000;
/** A user message that starts with `/<skill-name>`, then the request. */
const COMMAND_RE = /^\s*\/(\S+)(?:\s+([\s\S]*))?$/;

export interface SkillsToolsetOptions {
  /** Directories holding skill folders; an earlier one wins a name clash. */
  dirs?: string[];
  /** Receives the skills that were skipped or break the spec. */
  logger?: AgentLogger;
}

/**
 * Brings Agent Skills to the framework-free loop with Claude Code / Codex–style
 * progressive disclosure: the model spends almost no context on skills until it
 * needs one.
 *
 *  - Level 1 — {@link systemPrompt} lists each skill's name + description
 *    in the system prompt. That's all that's always in context.
 *  - Level 2 — the `Skill` tool loads a skill's full `SKILL.md` body plus a
 *    manifest of its bundled files, on demand, in a `<skill_content>` envelope
 *    (see `content.ts`).
 *  - Level 3 — `read_skill_file` reads a bundled resource and `run_skill_script`
 *    executes a bundled script, both sandboxed to the skill's own directory.
 *
 * The user can also activate a skill: a message that starts with
 * `/<skill-name>` reaches the model with the skill's instructions in front of
 * the request ({@link userText}), so the model needn't load it itself.
 *
 * The calls are ordinary tool calls on the AG-UI stream, so the client keeps
 * them in its history: a loaded skill stays in the model's context on later
 * runs (a follow-up message, a resumed HITL prompt), and compaction keeps its
 * instructions verbatim. The tools are `direct`, so code mode never wraps them.
 */
export class SkillsToolset implements AgentCapability {
  private readonly skills: Map<string, SkillSpec>;

  constructor(options: SkillsToolsetOptions = {}) {
    const warn = (message: string) => options.logger?.warn(`[skills] ${message}`);
    this.skills = new Map();
    for (const dir of options.dirs ?? []) {
      for (const skill of loadSkills(dir, warn)) {
        const taken = this.skills.get(skill.name);
        if (taken) {
          warn(
            `${skill.skillFile}: skipped, the name "${skill.name}" is already used by ${taken.skillFile}.`,
          );
          continue;
        }
        this.skills.set(skill.name, skill);
      }
    }
  }

  get size(): number {
    return this.skills.size;
  }

  /** The installed skills, by name. */
  list(): SkillInfo[] {
    return [...this.skills.values()]
      .map(({ name, description }) => ({ name, description }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * Expands a `/<skill-name>` command: the skill's instructions, then the rest
   * of the message as the request. Text that doesn't start with an installed
   * skill's command is left alone.
   */
  userText(text: string): string | undefined {
    const match = COMMAND_RE.exec(text);
    const skill = match ? this.skills.get(match[1]!) : undefined;
    if (!skill) {
      return undefined;
    }
    let content: string;
    try {
      content = this.skillContent(skill);
    } catch {
      return undefined; // its files went away since startup: leave the command as typed
    }
    const request = match![2]?.trim();
    return [
      content,
      request
        ? `The user activated the "${skill.name}" skill with /${skill.name}. Follow its instructions for this request:`
        : `The user activated the "${skill.name}" skill with /${skill.name}, without a request. Follow its instructions, asking for whatever you need.`,
      ...(request ? [request] : []),
    ].join("\n\n");
  }

  /** Level 1: the always-present skill catalog, or undefined when there are none. */
  systemPrompt(): string | undefined {
    if (this.skills.size === 0) {
      return undefined;
    }

    const lines = [...this.skills.values()].map(
      (skill) => `- **${skill.name}**: ${skill.description}`,
    );

    return [
      "# Available Skills",
      "",
      "You have access to skills — reusable procedures for specific tasks. When a",
      "user request matches a skill's description, call the `Skill` tool with its",
      "name to load the full instructions, then follow them. Read bundled files",
      "with `read_skill_file` and run bundled scripts with `run_skill_script` only",
      "as the loaded instructions direct. A skill you already loaded in this",
      "conversation stays in effect: don't load it again.",
      "",
      ...lines,
    ].join("\n");
  }

  /** The skill tools, or an empty list when no skills are installed. */
  serverTools(): ServerTool[] {
    if (this.skills.size === 0) {
      return [];
    }
    return [this.skillTool(), this.readFileTool(), this.runScriptTool()].map((tool) => ({
      ...tool,
      direct: true,
    }));
  }

  /** A `name` parameter limited to the installed skills, so the model can't invent one. */
  private skillNameParameter(description: string): Record<string, unknown> {
    return { type: "string", enum: [...this.skills.keys()], description };
  }

  private skillTool(): ServerTool {
    return {
      name: "Skill",
      description:
        "Load a skill's full instructions (SKILL.md) and the list of files it bundles. " +
        "Call this when a task matches a skill listed in the system prompt.",
      parameters: {
        type: "object",
        properties: {
          name: this.skillNameParameter("The skill name to load."),
        },
        required: ["name"],
        additionalProperties: false,
      },
      execute: (args) => this.skillContent(this.requireSkill(args.name)),
    };
  }

  /** The skill's instructions and bundled files, in a `<skill_content>` envelope. */
  private skillContent(skill: SkillSpec): string {
    const files = listSkillFiles(skill.dir);
    const listed =
      files.length > MAX_LISTED_FILES
        ? [
            ...files.slice(0, MAX_LISTED_FILES),
            `(${files.length - MAX_LISTED_FILES} more files not listed)`,
          ]
        : files;
    return wrapSkillContent(skill.name, readSkillBody(skill.skillFile), listed);
  }

  private readFileTool(): ServerTool {
    return {
      name: "read_skill_file",
      description:
        "Read a file bundled with a skill (e.g. a template or reference). Paths are " +
        "relative to the skill's directory.",
      parameters: {
        type: "object",
        properties: {
          skill: this.skillNameParameter("The skill name."),
          path: {
            type: "string",
            description: "File path relative to the skill directory, e.g. references/template.md.",
          },
        },
        required: ["skill", "path"],
        additionalProperties: false,
      },
      execute: (args) => {
        const skill = this.requireSkill(args.skill);
        const target = resolveWithinSkill(skill.dir, asString(args.path, "path"));
        return readTextFile(target);
      },
    };
  }

  private runScriptTool(): ServerTool {
    return {
      name: "run_skill_script",
      description:
        "Execute a script bundled with a skill (.py, .sh, .js, or an executable). Runs " +
        "in the skill's directory and returns combined stdout/stderr and the exit code.",
      parameters: {
        type: "object",
        properties: {
          skill: this.skillNameParameter("The skill name."),
          script: {
            type: "string",
            description: "Script path relative to the skill directory, e.g. scripts/build.py.",
          },
          args: {
            type: "array",
            items: { type: "string" },
            description: "Optional command-line arguments passed to the script.",
          },
        },
        required: ["skill", "script"],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const skill = this.requireSkill(args.skill);
        const target = resolveWithinSkill(skill.dir, asString(args.script, "script"));
        const scriptArgs = Array.isArray(args.args) ? args.args.map((arg) => String(arg)) : [];
        return runScript(target, scriptArgs, skill.dir, context?.signal);
      },
    };
  }

  private requireSkill(name: unknown): SkillSpec {
    const skill = typeof name === "string" ? this.skills.get(name) : undefined;
    if (!skill) {
      const available = [...this.skills.keys()].join(", ") || "(none)";
      throw new Error(`Unknown skill "${String(name)}". Available skills: ${available}.`);
    }
    return skill;
  }
}

/** The file's text, or a note in its place when it's binary (an image, an archive, …). */
function readTextFile(path: string): string {
  const content = readFileSync(path);
  if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return `Binary file (${content.length} bytes); it can't be shown as text.`;
  }
  return truncate(content.toString("utf8"));
}

/** Dispatches a script to an interpreter by extension, or runs it directly. */
function commandFor(scriptPath: string, scriptArgs: string[]): { command: string; args: string[] } {
  switch (extname(scriptPath).toLowerCase()) {
    case ".py":
      return { command: "python3", args: [scriptPath, ...scriptArgs] };
    case ".sh":
      return { command: "bash", args: [scriptPath, ...scriptArgs] };
    case ".js":
    case ".mjs":
    case ".cjs":
      return { command: "node", args: [scriptPath, ...scriptArgs] };
    default:
      return { command: scriptPath, args: scriptArgs };
  }
}

function runScript(
  scriptPath: string,
  scriptArgs: string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const { command, args } = commandFor(scriptPath, scriptArgs);

  return new Promise((resolve) => {
    execFile(
      command,
      args,
      // `signal` kills the script when the run is aborted.
      {
        cwd,
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: MAX_SCRIPT_OUTPUT_BYTES,
        encoding: "utf8",
        signal,
      },
      (error, stdout, stderr) => {
        const exitCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        const sections = [`exit code: ${exitCode}`];
        if (stdout) {
          sections.push(`stdout:\n${stdout}`);
        }
        if (stderr) {
          sections.push(`stderr:\n${stderr}`);
        }
        if (error && error.code === undefined) {
          sections.push(`error: ${error.message}`);
        }
        resolve(truncate(sections.join("\n\n")));
      },
    );
  });
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`"${field}" must be a non-empty string.`);
  }
  return value;
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated]` : text;
}
