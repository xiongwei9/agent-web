import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { FastifyReply, FastifyRequest } from "fastify";

export const SESSION_COOKIE = "ai_chat_session";
const SESSION_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const MIN_SECRET_LENGTH = 32;

/**
 * The key that signs session cookies: `SESSION_SECRET` when set, otherwise one
 * generated on first start and kept in `path` (mode 0600), so sessions — and
 * the MCP authorizations tied to them — survive restarts.
 */
export function loadSessionSecret(configured: string | undefined, path: string): string {
  if (configured) {
    return configured;
  }
  try {
    const stored = readFileSync(path, "utf8").trim();
    if (stored.length >= MIN_SECRET_LENGTH) {
      return stored;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const secret = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${secret}\n`, { mode: 0o600 });
  return secret;
}

/**
 * Identifies the browser behind a request, standing in for a login this app
 * doesn't have: the random id in its signed session cookie, or a new one.
 *
 * The id is unguessable and HMAC-signed, so a client can't claim another
 * browser's session (and with it that user's MCP tokens). A new id is set on
 * the reply as a plain header rather than through `reply.setCookie`, which only
 * writes on `onSend` — a hook a hijacked (streaming) reply never runs; such a
 * route copies `reply.getHeader("set-cookie")` into its own `writeHead`.
 */
export function sessionUserId(request: FastifyRequest, reply: FastifyReply): string {
  const cookie = request.cookies[SESSION_COOKIE];
  if (cookie) {
    const { valid, value } = request.unsignCookie(cookie);
    if (valid && value) {
      return value;
    }
  }

  const userId = randomUUID();
  reply.header(
    "set-cookie",
    request.server.serializeCookie(SESSION_COOKIE, request.server.signCookie(userId), {
      httpOnly: true,
      sameSite: "lax",
      secure: request.protocol === "https",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    }),
  );
  return userId;
}
