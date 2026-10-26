import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import type { ConversationStore } from "../conversations/store.ts";
import { sessionUserId } from "../session.ts";

interface SessionsRoutesOptions {
  /** Undefined when nothing is recorded (`SESSIONS_DIR=off`). */
  conversations: ConversationStore | undefined;
}

const sessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const sessionDetailSchema = sessionSummarySchema.extend({
  messages: z.array(z.unknown()).describe("The conversation as AG-UI messages."),
  modelCalls: z
    .array(z.unknown())
    .describe("Every model call, as the agent.debug.model_request/response CUSTOM events."),
});

export const sessionsRoutes: FastifyPluginAsyncZod<SessionsRoutesOptions> = async (
  app,
  { conversations },
) => {
  app.get(
    "/sessions",
    {
      schema: {
        tags: ["sessions"],
        summary: "Recorded sessions",
        description:
          "The session user's recorded conversations, the most recently updated first. " +
          "`enabled` is false when the server records none (`SESSIONS_DIR=off`).",
        response: {
          200: z.object({ enabled: z.boolean(), sessions: z.array(sessionSummarySchema) }),
        },
      },
    },
    async (request, reply) => {
      if (!conversations) {
        return { enabled: false, sessions: [] };
      }
      return { enabled: true, sessions: await conversations.list(sessionUserId(request, reply)) };
    },
  );

  app.get(
    "/sessions/:id",
    {
      schema: {
        tags: ["sessions"],
        summary: "One recorded session",
        description:
          "A conversation to reopen: its AG-UI messages and every model call it made. " +
          "Another user's session is not found.",
        params: z.object({ id: z.string() }),
        response: {
          200: sessionDetailSchema,
          404: z.object({ message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const session = await conversations?.get(request.params.id, sessionUserId(request, reply));
      if (!session) {
        return reply.status(404).send({ message: "Session not found" });
      }
      return session;
    },
  );

  app.delete(
    "/sessions/:id",
    {
      schema: {
        tags: ["sessions"],
        summary: "Delete a recorded session",
        description:
          "Deletes the session's folder: its messages and model calls. Another user's " +
          "session is not found.",
        params: z.object({ id: z.string() }),
        response: {
          204: z.null().describe("Deleted"),
          404: z.object({ message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const deleted = await conversations?.delete(request.params.id, sessionUserId(request, reply));
      if (!deleted) {
        return reply.status(404).send({ message: "Session not found" });
      }
      return reply.status(204).send(null);
    },
  );
};
