import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import type { SkillInfo } from "@ai-chat/agents";

import { startApp } from "./helpers.ts";

async function listSkills(env: Record<string, string>): Promise<SkillInfo[]> {
  const app = await startApp(undefined, { env });
  try {
    const response = await app.inject({ method: "GET", url: "/skills" });
    assert.equal(response.statusCode, 200);
    return response.json<{ skills: SkillInfo[] }>().skills;
  } finally {
    await app.close();
  }
}

describe("GET /skills", () => {
  test("lists the repo's skills by default", async () => {
    const skills = await listSkills({});
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["release-notes"],
    );
  });

  test("reads the directories SKILLS_DIRS names", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-route-"));
    try {
      mkdirSync(join(dir, "greet"));
      writeFileSync(
        join(dir, "greet", "SKILL.md"),
        "---\nname: greet\ndescription: Greets the user.\n---\nSay hi.",
      );
      assert.deepEqual(await listSkills({ SKILLS_DIRS: dir }), [
        { name: "greet", description: "Greets the user." },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("has none when SKILLS_DIRS is off", async () => {
    assert.deepEqual(await listSkills({ SKILLS_DIRS: "off" }), []);
  });
});
