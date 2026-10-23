/**
 * The `<skill_content>` envelope an activated skill reaches the model in (see
 * the Agent Skills client guide). Besides telling the model where a skill's
 * instructions start and end, it lets context compaction find skill
 * instructions and keep them verbatim instead of summarizing them away.
 */

const SKILL_CONTENT_RE = /<skill_content name="([^"]*)">[\s\S]*?<\/skill_content>/g;

/** Wraps a skill's instructions and, when given, the list of its bundled files. */
export function wrapSkillContent(name: string, body: string, resources: string[]): string {
  const lines = [`<skill_content name="${escapeAttribute(name)}">`, body];
  if (resources.length > 0) {
    lines.push(
      "",
      "Paths in this skill are relative to its directory: read its files with `read_skill_file` and run its scripts with `run_skill_script`.",
      "",
      "<skill_resources>",
      ...resources.map((file) => `  <file>${file}</file>`),
      "</skill_resources>",
    );
  }
  lines.push("</skill_content>");
  return lines.join("\n");
}

/** Every `<skill_content>` block in `texts`, by skill name; a later block wins. */
export function findSkillContents(texts: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const text of texts) {
    for (const match of text.matchAll(SKILL_CONTENT_RE)) {
      found.delete(match[1]!);
      found.set(match[1]!, match[0]);
    }
  }
  return found;
}

/** `text` with each `<skill_content>` block replaced by a short placeholder. */
export function elideSkillContents(text: string): string {
  return text.replace(
    SKILL_CONTENT_RE,
    (_block, name: string) => `[instructions of skill "${name}"]`,
  );
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
