import { useEffect, useState } from "react";

import { apiUrl } from "../lib/api";

/** Mirrors `SkillInfo` from `@ai-chat/agents` (served by `GET /skills`). */
export interface SkillInfo {
  name: string;
  description: string;
}

const SKILLS_URL = apiUrl("skills");

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
