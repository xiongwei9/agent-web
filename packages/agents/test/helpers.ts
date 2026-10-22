import assert from "node:assert/strict";

import { startDemoHttpServer } from "@ai-chat/mcp-server-demo";

import type { LanguageModel, ModelCallOptions, ModelStreamPart } from "../src/model/types.ts";

/**
 * Plays the user's part of an OAuth flow against the demo server: opens the
 * authorization URL, submits the consent form, and returns where the
 * authorization server redirects the browser (the client's callback URL, with
 * `code` + `state`, or `error`).
 */
export async function submitConsent(
  authorizationUrl: string,
  decision: "approve" | "deny" = "approve",
): Promise<URL> {
  const page = await fetch(authorizationUrl, { redirect: "manual" });
  assert.equal(page.status, 200, "the authorization URL renders the consent page");
  const requestId = /name="request_id" value="([^"]+)"/.exec(await page.text())?.[1];
  assert.ok(requestId, "the consent page carries a request id");

  const response = await fetch(new URL("/consent", authorizationUrl), {
    method: "POST",
    body: new URLSearchParams({ request_id: requestId, decision }),
    redirect: "manual",
  });
  assert.equal(response.status, 302);
  return new URL(response.headers.get("location")!);
}

/**
 * A Streamable HTTP URL with nothing listening behind it: reserves a free port,
 * then frees it. Returns the port too, so a test can start a server there later.
 */
export async function unreachableMcpUrl(): Promise<{ url: string; port: number }> {
  const probe = await startDemoHttpServer();
  await probe.close();
  return { url: probe.url, port: probe.port };
}

export interface ScriptedModel {
  model: LanguageModel;
  /** The options of every `doStream` call, in order. */
  calls: ModelCallOptions[];
}

/**
 * A fake model that replays one scripted stream per turn, so agent-loop tests
 * can drive tool calls deterministically without a real provider.
 */
export function scriptedModel(turns: ModelStreamPart[][]): ScriptedModel {
  const calls: ModelCallOptions[] = [];
  const model: LanguageModel = {
    doStream: async (options) => {
      const parts = turns[calls.length];
      calls.push(options);
      if (!parts) {
        throw new Error(`scriptedModel: no turn scripted for call #${calls.length}`);
      }
      return {
        stream: new ReadableStream<ModelStreamPart>({
          start(controller) {
            for (const part of parts) {
              controller.enqueue(part);
            }
            controller.close();
          },
        }),
      };
    },
  };
  return { model, calls };
}

export function toolCallTurn(
  toolName: string,
  args: unknown,
  toolCallId = "c1",
): ModelStreamPart[] {
  return [{ type: "tool-call", toolCallId, toolName, input: JSON.stringify(args) }];
}

export function textTurn(text: string): ModelStreamPart[] {
  return [
    { type: "text-start", id: "0" },
    { type: "text-delta", id: "0", delta: text },
    { type: "text-end", id: "0" },
  ];
}
