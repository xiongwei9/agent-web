import {
  EventType,
  RunAgentInputSchema,
  type AGUIEvent,
  type RunAgentInput,
} from "@ag-ui/core";
import {
  aguiEvent,
  createAgentRunner,
  type AgentConfig,
  type AgentRunner,
} from "@ai-chat/agents";
import { EventEncoder } from "@ag-ui/encoder";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

interface AguiRoutesOptions {
  agentConfig: AgentConfig;
}

const streamResponseSchema = z.string().describe(
  "AG-UI event stream. Each SSE data frame contains one AG-UI BaseEvent JSON payload.",
);

export const aguiRoutes: FastifyPluginAsyncZod<AguiRoutesOptions> = async (
  app,
  { agentConfig },
) => {
  const runAgent = createAgentRunner({ config: agentConfig });
  const aguiRunOptions = {
    schema: {
      tags: ["ag-ui"],
      summary: "Run AG-UI agent",
      description:
        "Accepts an AG-UI RunAgentInput payload and streams AG-UI BaseEvent objects.",
      consumes: ["application/json"],
      produces: ["text/event-stream"],
      body: RunAgentInputSchema,
      response: {
        200: streamResponseSchema,
      },
    },
  };

  app.post<{ Body: RunAgentInput }>("/agui", aguiRunOptions, (request, reply) =>
    handleAguiRun(request, reply, runAgent),
  );
};

async function handleAguiRun(
  request: FastifyRequest<{ Body: RunAgentInput }>,
  reply: FastifyReply,
  runAgent: AgentRunner,
) {
  reply.hijack();

  const input = request.body;
  const encoder = new EventEncoder({
    accept: request.headers.accept,
  });

  reply.raw.writeHead(200, {
    "content-type": encoder.getContentType(),
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  try {
    await writeAguiEventStream(reply, encoder, runAgent(input));
  } catch (error) {
    if (!reply.raw.destroyed) {
      reply.raw.write(
        encoder.encodeBinary(
          aguiEvent({
            type: EventType.RUN_ERROR,
            message: error instanceof Error ? error.message : "Agent run failed",
            code: "AGENT_RUN_FAILED",
          }),
        ),
      );
    }
  } finally {
    if (!reply.raw.destroyed) {
      reply.raw.end();
    }
  }
}

async function writeAguiEventStream(
  reply: FastifyReply,
  encoder: EventEncoder,
  events: AsyncIterable<AGUIEvent>,
) {
  for await (const event of events) {
    if (reply.raw.destroyed) {
      return;
    }

    reply.raw.write(encoder.encodeBinary(event));
  }
}
