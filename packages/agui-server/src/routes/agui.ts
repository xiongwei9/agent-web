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
  type AgentRunnerOptions,
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

const RESOURCE_ID_HEADER = "x-resource-id";

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

  const runnerOptions = buildRunnerOptions(request);
  const events$ = runAgent(input, runnerOptions);

  await new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const subscription = events$.subscribe({
      next: (event) => {
        if (reply.raw.destroyed) {
          subscription.unsubscribe();
          settle();
          return;
        }
        reply.raw.write(encoder.encodeBinary(event as AGUIEvent));
      },
      error: (error: unknown) => {
        if (!reply.raw.destroyed) {
          reply.raw.write(
            encoder.encodeBinary(
              aguiEvent({
                type: EventType.RUN_ERROR,
                message:
                  error instanceof Error ? error.message : "Agent run failed",
                code: "AGENT_RUN_FAILED",
              }),
            ),
          );
        }
        settle();
      },
      complete: () => {
        settle();
      },
    });

    // Stop the agent stream when the client disconnects.
    reply.raw.on("close", () => {
      subscription.unsubscribe();
      settle();
    });
  });

  if (!reply.raw.destroyed) {
    reply.raw.end();
  }
}

function buildRunnerOptions(
  request: FastifyRequest<{ Body: RunAgentInput }>,
): AgentRunnerOptions {
  const headerValue = request.headers[RESOURCE_ID_HEADER];
  const headerResourceId = Array.isArray(headerValue)
    ? headerValue[0]
    : headerValue;

  const forwardedProps = request.body.forwardedProps;
  const forwardedResourceId =
    typeof forwardedProps === "object" &&
    forwardedProps !== null &&
    "resourceId" in forwardedProps &&
    typeof (forwardedProps as { resourceId?: unknown }).resourceId === "string"
      ? (forwardedProps as { resourceId: string }).resourceId
      : undefined;

  return {
    resourceId: headerResourceId ?? forwardedResourceId,
    requestContext: {
      headers: request.headers,
      forwardedProps,
    },
  };
}
