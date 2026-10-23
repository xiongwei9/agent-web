import type { SkillInfo } from "@ai-chat/agents";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

interface SkillsRoutesOptions {
  skills: SkillInfo[];
}

const skillInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
});

export const skillsRoutes: FastifyPluginAsyncZod<SkillsRoutesOptions> = async (app, { skills }) => {
  app.get(
    "/skills",
    {
      schema: {
        tags: ["skills"],
        summary: "Installed Agent Skills",
        description:
          "The skills the agent can use. A user message that starts with `/<name>` " +
          "activates one for that request.",
        response: {
          200: z.object({ skills: z.array(skillInfoSchema) }),
        },
      },
    },
    async () => ({ skills }),
  );
};
