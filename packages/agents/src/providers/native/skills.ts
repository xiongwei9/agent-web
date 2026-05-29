import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

import {
  listSkillFiles,
  loadSkills,
  readSkillBody,
  resolveWithinSkill,
  type SkillSpec,
} from "../../skills/index.ts";
import type { NativeTool } from "./types.ts";

const SCRIPT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 100_000;

/**
 * Brings Agent Skills to the framework-free loop with Claude Code / Codex–style
 * progressive disclosure: the model spends almost no context on skills until it
 * needs one.
 *
 *  - Level 1 — {@link systemPromptSection} lists each skill's name + description
 *    in the system prompt. That's all that's always in context.
 *  - Level 2 — the `Skill` tool loads a skill's full `SKILL.md` body plus a
 *    manifest of its bundled files, on demand.
 *  - Level 3 — `read_skill_file` reads a bundled resource and `run_skill_script`
 *    executes a bundled script, both sandboxed to the skill's own directory.
 */
export class SkillsToolset {
  private readonly skills: Map<string, SkillSpec>;

  constructor() {
    this.skills = new Map(loadSkills().map((skill) => [skill.name, skill]));
  }

  get size(): number {
    return this.skills.size;
  }

  /** Level 1: the always-present skill catalog, or undefined when there are none. */
  systemPromptSection(): string | undefined {
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
      "as the loaded instructions direct.",
      "",
      ...lines,
    ].join("\n");
  }

  /**
   * The skill tools, or an empty list when no skills are installed. All are
   * marked `hidden`: skill loading / file reads / script runs are internal
   * plumbing, so the loop executes them but emits no AG-UI tool-call events.
   */
  tools(): NativeTool[] {
    if (this.skills.size === 0) {
      return [];
    }
    return [this.skillTool(), this.readFileTool(), this.runScriptTool()].map((tool) => ({
      ...tool,
      hidden: true,
    }));
  }

  private skillTool(): NativeTool {
    return {
      name: "Skill",
      description:
        "Load a skill's full instructions (SKILL.md) and the list of files it bundles. " +
        "Call this when a task matches a skill listed in the system prompt.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The skill name to load." },
        },
        required: ["name"],
        additionalProperties: false,
      },
      execute: (args) => {
        const skill = this.requireSkill(args.name);
        const body = readSkillBody(skill.skillFile);
        const files = listSkillFiles(skill.dir);
        const manifest =
          files.length > 0
            ? `\n\n---\nBundled files (read with read_skill_file, run with run_skill_script):\n${files
                .map((file) => `- ${file}`)
                .join("\n")}`
            : "";
        return `${body}${manifest}`;
      },
    };
  }

  private readFileTool(): NativeTool {
    return {
      name: "read_skill_file",
      description:
        "Read a file bundled with a skill (e.g. a template or reference). Paths are " +
        "relative to the skill's directory.",
      parameters: {
        type: "object",
        properties: {
          skill: { type: "string", description: "The skill name." },
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
        return truncate(readFileSync(target, "utf8"));
      },
    };
  }

  private runScriptTool(): NativeTool {
    return {
      name: "run_skill_script",
      description:
        "Execute a script bundled with a skill (.py, .sh, .js, or an executable). Runs " +
        "in the skill's directory and returns combined stdout/stderr and the exit code.",
      parameters: {
        type: "object",
        properties: {
          skill: { type: "string", description: "The skill name." },
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
      execute: async (args) => {
        const skill = this.requireSkill(args.skill);
        const target = resolveWithinSkill(skill.dir, asString(args.script, "script"));
        const scriptArgs = Array.isArray(args.args) ? args.args.map((arg) => String(arg)) : [];
        return runScript(target, scriptArgs, skill.dir);
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

function runScript(scriptPath: string, scriptArgs: string[], cwd: string): Promise<string> {
  const { command, args } = commandFor(scriptPath, scriptArgs);

  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, timeout: SCRIPT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_CHARS, encoding: "utf8" },
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
