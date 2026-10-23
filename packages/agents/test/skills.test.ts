import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import { EventType, type BaseEvent } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";

import { compactPromptIfNeeded } from "../src/loop/compaction.ts";
import { runAgentLoop } from "../src/loop/loop.ts";
import type { ModelMessage } from "../src/model/types.ts";
import { loadSkills } from "../src/skills/loader.ts";
import { SkillsToolset } from "../src/skills/toolset.ts";
import { resolveRunTools } from "../src/tools/toolset.ts";
import type { AgentLogger } from "../src/types.ts";
import { scriptedModel, textTurn, toolCallTurn } from "./helpers.ts";

type AnyEvent = BaseEvent & Record<string, unknown>;

/** The repo's skills (`packages/skills/`). */
const REPO_SKILLS = fileURLToPath(new URL("../../skills", import.meta.url));

/** Writes `files` (path → content) under a fresh temp directory. */
function skillStore(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), "skills-test-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content, { mode: 0o755 });
  }
  return root;
}

function skillFile(
  name: string | undefined,
  description: string | undefined,
  body = "Body.",
): string {
  const lines = ["---"];
  if (name !== undefined) {
    lines.push(`name: ${name}`);
  }
  if (description !== undefined) {
    lines.push(`description: ${description}`);
  }
  lines.push("---", "", body);
  return lines.join("\n");
}

function warnings(): AgentLogger & { lines: string[] } {
  const lines: string[] = [];
  const ignore = () => {};
  return { lines, debug: ignore, info: ignore, error: ignore, warn: (line) => lines.push(line) };
}

describe("loadSkills", () => {
  let store: string;
  const warned: string[] = [];

  before(() => {
    store = skillStore({
      "good/SKILL.md": skillFile("good", "Does good things. Use when asked."),
      "colon/SKILL.md": skillFile("colon", "Use when: the user asks about colons"),
      "mismatch/SKILL.md": skillFile("other-name", "Name differs from the folder."),
      "unnamed/SKILL.md": skillFile(undefined, "Has no name."),
      "Bad--Name/SKILL.md": skillFile("Bad--Name", "Breaks the name rules."),
      "no-description/SKILL.md": skillFile("no-description", undefined),
      "broken/SKILL.md": "---\nname: [unclosed\n---\nBody",
      "no-frontmatter/SKILL.md": "# Just markdown",
      "zz-duplicate/SKILL.md": skillFile("good", "Same name as another skill."),
      "not-a-skill/README.md": "nothing here",
    });
  });

  after(() => rmSync(store, { recursive: true, force: true }));

  test("loads what it can and warns about the rest instead of throwing", () => {
    const skills = loadSkills(store, (line) => warned.push(line));

    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["Bad--Name", "colon", "good", "other-name", "unnamed"],
    );
    const about = (folder: string) => warned.filter((line) => line.startsWith(`${folder}/`));
    const warns = (folder: string, pattern: RegExp) =>
      assert.ok(
        about(folder).some((line) => pattern.test(line)),
        `${folder}: ${about(folder).join(" | ")}`,
      );
    warns("no-description", /skipped.*description/);
    warns("broken", /skipped.*invalid YAML/);
    warns("no-frontmatter", /skipped.*frontmatter/);
    warns("zz-duplicate", /skipped.*already used by good\/SKILL\.md/);
    warns("mismatch", /doesn't match its folder/);
    warns("unnamed", /using the folder name/);
    warns("Bad--Name", /lowercase letters, digits, and single hyphens/);
    assert.deepEqual(about("good"), []);
    assert.deepEqual(about("not-a-skill"), []);
  });

  test("reads an unquoted value containing a colon", () => {
    const colon = loadSkills(store).find((skill) => skill.name === "colon");
    assert.equal(colon?.description, "Use when: the user asks about colons");
  });
});

describe("SkillsToolset", () => {
  let store: string;

  before(() => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    store = skillStore({
      "demo/SKILL.md": skillFile("demo", "A demo skill.", "# Demo\n\nDo the demo."),
      "demo/references/guide.md": "the guide",
      "demo/assets/logo.png": binary,
      "demo/.DS_Store": "junk",
      // Prints ~200 KB: more than the model is shown, less than the kill limit.
      "demo/scripts/loud.sh": 'head -c 200000 /dev/zero | tr "\\0" x\n',
      "other/SKILL.md": skillFile("other", "Another skill."),
    });
  });

  after(() => rmSync(store, { recursive: true, force: true }));

  function tools() {
    return new Map(
      new SkillsToolset({ dirs: [store] }).serverTools().map((tool) => [tool.name, tool]),
    );
  }

  test("wraps the instructions and lists the bundled files", async () => {
    const result = await tools().get("Skill")!.execute({ name: "demo" });
    assert.equal(
      result,
      [
        '<skill_content name="demo">',
        "# Demo",
        "",
        "Do the demo.",
        "",
        "Paths in this skill are relative to its directory: read its files with `read_skill_file` and run its scripts with `run_skill_script`.",
        "",
        "<skill_resources>",
        "  <file>assets/logo.png</file>",
        "  <file>references/guide.md</file>",
        "  <file>scripts/loud.sh</file>",
        "</skill_resources>",
        "</skill_content>",
      ].join("\n"),
    );
  });

  test("limits skill names to the installed skills", () => {
    for (const tool of tools().values()) {
      const properties = tool.parameters.properties as Record<string, { enum?: string[] }>;
      const parameter = properties.name ?? properties.skill;
      assert.deepEqual(parameter?.enum, ["demo", "other"], tool.name);
    }
  });

  test("streams the tools like any other, and keeps them out of code mode", () => {
    for (const tool of tools().values()) {
      assert.equal(tool.hidden, undefined, tool.name);
      assert.equal(tool.direct, true, tool.name);
    }
  });

  test("describes a binary file instead of decoding it", async () => {
    const result = await tools().get("read_skill_file")!.execute({
      skill: "demo",
      path: "assets/logo.png",
    });
    assert.equal(result, "Binary file (7 bytes); it can't be shown as text.");
  });

  test("truncates a script's long output instead of killing it", async () => {
    const result = await tools().get("run_skill_script")!.execute({
      skill: "demo",
      script: "scripts/loud.sh",
    });
    assert.match(result, /^exit code: 0\n/);
    assert.match(result, /…\[truncated\]$/);
  });

  test("reports skipped skills through the logger", () => {
    const broken = skillStore({ "broken/SKILL.md": "no frontmatter" });
    try {
      const logger = warnings();
      assert.equal(new SkillsToolset({ dirs: [broken], logger }).size, 0);
      assert.match(logger.lines[0] ?? "", /^\[skills\] broken\/SKILL\.md: skipped/);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});

describe("skills across runs", () => {
  test("a loaded skill reaches the client, so the next run still has it", async () => {
    const tools = await resolveRunTools([new SkillsToolset({ dirs: [REPO_SKILLS] })]);
    const { model } = scriptedModel([
      toolCallTurn("Skill", { name: "release-notes" }),
      textTurn("Here are your notes."),
    ]);
    const events = (await lastValueFrom(
      runAgentLoop({
        threadId: "t",
        runId: "r",
        messages: [{ id: "m1", role: "user", content: "write release notes" }],
        clientTools: [],
        context: [],
        persona: tools.systemPrompt,
        model,
        serverTools: tools.serverTools,
      }).pipe(toArray()),
    )) as AnyEvent[];

    const start = events.find((event) => event.type === EventType.TOOL_CALL_START);
    assert.equal(start?.toolCallName, "Skill");
    const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
    assert.match(result?.content as string, /^<skill_content name="release-notes">/);
  });
});

describe("compaction and skills", () => {
  const SKILL = '<skill_content name="demo">\nAlways answer in haiku.\n</skill_content>';
  const filler = " word".repeat(300);
  const signal = new AbortController().signal;

  function prompt(): ModelMessage[] {
    return [
      { role: "system", content: "You are helpful." },
      { role: "user", content: [{ type: "text", text: `use the demo skill${filler}` }] },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "Skill", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "Skill",
            output: { type: "text", value: SKILL },
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: `first answer${filler}` }] },
      { role: "user", content: [{ type: "text", text: "next question" }] },
      { role: "assistant", content: [{ type: "text", text: "next answer" }] },
    ];
  }

  test("keeps a loaded skill's instructions verbatim after the summary", async () => {
    const { model, calls } = scriptedModel([textTurn("summary A"), textTurn("summary B")]);
    const options = { enabled: true, maxTokens: 200, keepRecentMessages: 2 };
    const compacted = await compactPromptIfNeeded(prompt(), model, options, signal);

    const summary = compacted[1]!;
    assert.equal(summary.role, "user");
    const text = summary.role === "user" ? summary.content[0]!.text : "";
    assert.match(text, /summary A/);
    assert.ok(text.includes(SKILL), "the instructions survive word for word");

    // The summarizer only sees the skill's name.
    const asked = JSON.stringify(calls[0]!.prompt);
    assert.ok(!asked.includes("Always answer in haiku"));
    assert.ok(asked.includes('[instructions of skill \\"demo\\"]'));

    // Compacting again (the summary itself gets folded in) still keeps them.
    const longer = [
      ...compacted,
      { role: "user", content: [{ type: "text", text: `more${filler}` }] },
      { role: "assistant", content: [{ type: "text", text: `more answer${filler}` }] },
      { role: "user", content: [{ type: "text", text: "last" }] },
      { role: "assistant", content: [{ type: "text", text: "last answer" }] },
    ] satisfies ModelMessage[];
    const again = await compactPromptIfNeeded(longer, model, options, signal);
    const againText = again[1]!.role === "user" ? again[1]!.content[0]!.text : "";
    assert.match(againText, /summary B/);
    assert.equal(againText.split(SKILL).length - 1, 1, "kept once, not duplicated");
  });
});

describe("skill directories", () => {
  test("an earlier directory wins a name clash, and a missing one only warns", () => {
    const first = skillStore({ "shared/SKILL.md": skillFile("shared", "From the first.") });
    const second = skillStore({
      "shared/SKILL.md": skillFile("shared", "From the second."),
      "extra/SKILL.md": skillFile("extra", "Only in the second."),
    });
    try {
      const logger = warnings();
      const skills = new SkillsToolset({
        dirs: [first, join(first, "missing"), second],
        logger,
      });

      assert.deepEqual(skills.list(), [
        { name: "extra", description: "Only in the second." },
        { name: "shared", description: "From the first." },
      ]);
      assert.ok(
        logger.lines.some((line) => /can't read the skills directory .*missing/.test(line)),
      );
      assert.ok(
        logger.lines.some((line) => /skipped, the name "shared" is already used/.test(line)),
      );
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  test("no directories means no skills and no skill tools", () => {
    const skills = new SkillsToolset();
    assert.equal(skills.size, 0);
    assert.deepEqual(skills.serverTools(), []);
    assert.equal(skills.systemPrompt(), undefined);
  });
});

describe("/skill-name commands", () => {
  let store: string;
  let skills: SkillsToolset;

  before(() => {
    store = skillStore({ "demo/SKILL.md": skillFile("demo", "A demo skill.", "Do the demo.") });
    skills = new SkillsToolset({ dirs: [store] });
  });

  after(() => rmSync(store, { recursive: true, force: true }));

  test("puts the skill's instructions in front of the request", () => {
    assert.equal(
      skills.userText("/demo  make it short"),
      [
        '<skill_content name="demo">\nDo the demo.\n</skill_content>',
        'The user activated the "demo" skill with /demo. Follow its instructions for this request:',
        "make it short",
      ].join("\n\n"),
    );
  });

  test("works without a request", () => {
    assert.match(skills.userText("/demo") ?? "", /without a request/);
  });

  test("leaves other text alone", () => {
    assert.equal(skills.userText("/unknown do it"), undefined);
    assert.equal(skills.userText("please /demo"), undefined);
    assert.equal(skills.userText("/demonstrate"), undefined);
  });

  test("the model gets the expanded message on every run", async () => {
    const tools = await resolveRunTools([new SkillsToolset({ dirs: [REPO_SKILLS] })]);
    const { model, calls } = scriptedModel([textTurn("ok")]);
    await lastValueFrom(
      runAgentLoop({
        threadId: "t",
        runId: "r",
        messages: [
          { id: "m1", role: "user", content: "/release-notes v1.2: fixed login" },
          { id: "m2", role: "assistant", content: "Here are the notes." },
          { id: "m3", role: "user", content: "shorter please" },
        ],
        clientTools: [],
        context: [],
        persona: tools.systemPrompt,
        model,
        serverTools: tools.serverTools,
        expandUserText: tools.expandUserText,
      }).pipe(toArray()),
    );

    const users = calls[0]!.prompt.flatMap((message) =>
      message.role === "user" ? [message.content[0]!.text] : [],
    );
    assert.match(users[0]!, /^<skill_content name="release-notes">/);
    assert.match(users[0]!, /v1\.2: fixed login$/);
    assert.equal(users[1], "shorter please");
  });
});
