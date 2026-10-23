import { useEffect, useState } from "react";

/** Mirrors `SkillInfo` from `@ai-chat/agents` (served by `GET /skills`). */
export interface SkillInfo {
  name: string;
  description: string;
}

const AGUI_URL = import.meta.env.VITE_AGUI_URL ?? "/agui";
// Resolved against the AG-UI endpoint, so a path prefix or remote origin carries over.
const SKILLS_URL = new URL("skills", new URL(AGUI_URL, window.location.href)).href;

/**
 * The agent's installed skills, for `/skill-name` suggestions in the composer.
 * Fetched once: skills load when the server starts.
 */
export function useSkills(): SkillInfo[] {
  const [skills, setSkills] = useState<SkillInfo[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(SKILLS_URL, { signal: controller.signal, credentials: "include" })
      .then(async (response) => {
        if (response.ok) {
          setSkills(((await response.json()) as { skills: SkillInfo[] }).skills);
        }
      })
      .catch(() => {
        // Server not up yet, or the request was aborted: no suggestions.
      });
    return () => controller.abort();
  }, []);

  return skills;
}
