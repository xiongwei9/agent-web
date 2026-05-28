import "dotenv/config";

import { loadConfig } from "./config.ts";
import { buildApp } from "./server.ts";

const config = loadConfig();

const app = await buildApp({
  config,
  fastifyOptions: {
    logger: {
      level: config.logLevel,
    },
  },
});

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info({ host: config.host, port: config.port }, "agui server listening");
} catch (error) {
  app.log.error(error, "failed to start agui server");
  process.exit(1);
}
