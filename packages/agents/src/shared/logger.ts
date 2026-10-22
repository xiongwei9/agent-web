import type { AgentLogger } from "../types.ts";

/**
 * The default {@link AgentLogger}: warnings and errors to the console, `debug`
 * off (it carries whole prompts). Resolves `console.*` at call time so tests
 * can mock them.
 */
export const consoleLogger: AgentLogger = {
  debug: () => {},
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};
