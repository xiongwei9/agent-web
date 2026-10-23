import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { createAgent } from "@ai-chat/agents";
import fastify, { type FastifyServerOptions } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";

import { aguiRoutes } from "./routes/agui.ts";
import type { AppConfig } from "./config.ts";
import { healthRoutes } from "./routes/health.ts";
import { mcpRoutes } from "./routes/mcp.ts";
import { skillsRoutes } from "./routes/skills.ts";
import { loadSessionSecret } from "./session.ts";

export interface BuildAppOptions {
  config: AppConfig;
  fastifyOptions?: FastifyServerOptions;
}

export async function buildApp({ config, fastifyOptions = {} }: BuildAppOptions) {
  const app = fastify(fastifyOptions).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.status(400).send({
        error: "Bad Request",
        message: "Request validation failed",
        statusCode: 400,
        details: error.validation,
      });
    }

    if (isResponseSerializationError(error)) {
      request.log.error(error, "response serialization failed");
      return reply.status(500).send({
        error: "Internal Server Error",
        message: "Response serialization failed",
        statusCode: 500,
      });
    }

    const fallbackError = error instanceof Error ? error : new Error("Unexpected server error");
    const maybeStatusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : undefined;
    const statusCode = typeof maybeStatusCode === "number" ? maybeStatusCode : 500;

    if (statusCode >= 500) {
      request.log.error(fallbackError);
    }

    return reply.status(statusCode).send({
      error: fallbackError.name,
      message: fallbackError.message,
      statusCode,
    });
  });

  await app.register(cors, {
    origin: true,
    // The session cookie identifies the user (see session.ts); a frontend on
    // another origin must send it with `credentials: "include"`.
    credentials: true,
  });
  await app.register(cookie, {
    secret: loadSessionSecret(config.session.secret, config.session.secretPath),
  });

  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "AG-UI Server API",
        description: "Fastify service exposing an AG-UI-compatible event stream.",
        version: "0.1.0",
      },
      tags: [
        { name: "system", description: "Service diagnostics" },
        { name: "ag-ui", description: "AG-UI protocol endpoints" },
        { name: "mcp", description: "MCP server status and OAuth" },
        { name: "skills", description: "Agent Skills" },
      ],
    },
    transform: jsonSchemaTransform,
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      deepLinking: true,
      docExpansion: "list",
    },
  });

  // `debug` includes full prompts and tool results; it's on only at LOG_LEVEL=debug.
  const agent = createAgent({ ...config.agent, logger: app.log });

  await app.register(healthRoutes);
  await app.register(aguiRoutes, { runAgent: agent.run });
  await app.register(mcpRoutes, { mcp: agent.mcp });
  await app.register(skillsRoutes, { skills: agent.skills });

  // MCP connections are per user and open on a user's first request (the
  // frontend polls `GET /mcp/servers` on load), so there is nothing to warm up.
  app.addHook("onClose", async () => {
    await agent.mcp?.close();
  });

  return app;
}
