import { z } from "zod";

import type { FrontendTool, ModelFunctionTool, ToolArgsValidation } from "./types.ts";

/**
 * Human-in-the-Loop (HITL) tools for the native agent loop.
 *
 * These are the agent's two ways to hand control back to the person it is
 * working for: {@link HITL_ASK_USER_TOOL_NAME} to collect an answer it cannot
 * derive on its own, and {@link HITL_REQUEST_APPROVAL_TOOL_NAME} to get explicit
 * sign-off before doing something consequential.
 *
 * Like the A2UI render tool, they are declared to the model but never
 * registered as server tools: the loop suspends a run whenever a client tool is
 * called, so the run finishes with the `TOOL_CALL_*` events already on the wire
 * and the client owns fulfillment — render the prompt, capture the user's
 * response, then resume with a fresh run whose history carries a `tool` message
 * for that `toolCallId`. Because the answer comes back as a real tool *result*
 * (rather than the free-form user message the A2UI path uses), the model sees a
 * normal, well-formed tool round-trip and can be resumed mid-thought.
 *
 * Malformed calls never reach the client: {@link FrontendTool.validate} bounces
 * them back to the model as a tool result so it self-corrects (see `loop.ts`).
 */
export const HITL_ASK_USER_TOOL_NAME = "ask_user";
export const HITL_REQUEST_APPROVAL_TOOL_NAME = "request_user_approval";

/** The client-fulfilled HITL tools, ready for the loop's frontend-tool registry. */
export function hitlFrontendTools(): FrontendTool[] {
  return [
    {
      def: askUserToolDef(),
      validate: (rawArgs) => validate(HITL_ASK_USER_TOOL_NAME, askUserSchema, rawArgs),
    },
    {
      def: requestApprovalToolDef(),
      validate: (rawArgs) =>
        validate(HITL_REQUEST_APPROVAL_TOOL_NAME, requestApprovalSchema, rawArgs),
    },
  ];
}

/** The HITL usage guide appended to the agent's system prompt. */
export function hitlSystemPromptSection(): string {
  return HITL_SYSTEM_PROMPT;
}

const optionSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
  description: z.string().optional(),
});

const askUserSchema = z
  .object({
    question: z.string().min(1),
    details: z.string().optional(),
    options: z.array(optionSchema).min(1).optional(),
    allowMultiple: z.boolean().optional(),
    allowOther: z.boolean().optional(),
    placeholder: z.string().optional(),
  })
  .refine((value) => !value.allowMultiple || value.options !== undefined, {
    message: "`allowMultiple` only applies when `options` are provided",
    path: ["allowMultiple"],
  });

const requestApprovalSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  details: z.array(z.object({ label: z.string().min(1), value: z.string() })).optional(),
  risk: z.enum(["low", "medium", "high"]).optional(),
  confirmLabel: z.string().optional(),
  rejectLabel: z.string().optional(),
  allowComment: z.boolean().optional(),
});

function askUserToolDef(): ModelFunctionTool {
  return {
    type: "function",
    name: HITL_ASK_USER_TOOL_NAME,
    description:
      "Ask the user a question and wait for their answer. Use it when you are blocked on " +
      "information only the user has (a missing value, a preference, which of several paths to " +
      "take). The run pauses and resumes with the answer as this tool's result: " +
      '{"answer": "..."} — an array of values when `allowMultiple` is set, or ' +
      '{"cancelled": true} if the user answered in chat instead.',
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question, as one short sentence.",
        },
        details: {
          type: "string",
          description:
            "Optional markdown shown under the question: context, trade-offs, or why you need this.",
        },
        options: {
          type: "array",
          description:
            "Predefined answers, when the answer is a choice from a known set. Omit for free text.",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Shown to the user." },
              value: { type: "string", description: "Returned to you when picked." },
              description: { type: "string", description: "Optional one-line hint." },
            },
            required: ["label", "value"],
            additionalProperties: false,
          },
        },
        allowMultiple: {
          type: "boolean",
          description: "Let the user pick more than one option. Requires `options`.",
        },
        allowOther: {
          type: "boolean",
          description: "Offer a free-text field next to the options for an answer you didn't list.",
        },
        placeholder: {
          type: "string",
          description: "Placeholder for the free-text field.",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
  };
}

function requestApprovalToolDef(): ModelFunctionTool {
  return {
    type: "function",
    name: HITL_REQUEST_APPROVAL_TOOL_NAME,
    description:
      "Ask the user to approve or reject an action before you take it. Use it for anything " +
      "consequential or hard to undo: writing or deleting data, spending money, sending a " +
      "message on the user's behalf, running a destructive command. The run pauses and resumes " +
      'with the decision as this tool\'s result: {"decision": "approved" | "rejected", ' +
      '"comment"?: "..."}. Honor a rejection — do not retry or route around it.',
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: 'Short label for the action, e.g. "Delete 3 files".',
        },
        summary: {
          type: "string",
          description:
            "Markdown describing exactly what will happen if approved, and anything irreversible about it.",
        },
        details: {
          type: "array",
          description: "Key facts the user should check before deciding.",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              value: { type: "string" },
            },
            required: ["label", "value"],
            additionalProperties: false,
          },
        },
        risk: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "How consequential the action is. Defaults to medium.",
        },
        confirmLabel: {
          type: "string",
          description: 'Label for the approve button. Defaults to "Approve".',
        },
        rejectLabel: {
          type: "string",
          description: 'Label for the reject button. Defaults to "Reject".',
        },
        allowComment: {
          type: "boolean",
          description: "Let the user attach a note to their decision.",
        },
      },
      required: ["title", "summary"],
      additionalProperties: false,
    },
  };
}

/**
 * Parses and validates raw tool arguments, turning a failure into a message the
 * model can act on. The loop feeds that message back as the call's tool result,
 * so an invalid prompt is corrected in-run instead of reaching the user.
 */
function validate(toolName: string, schema: z.ZodType, rawArgs: string): ToolArgsValidation {
  let parsed: unknown;
  try {
    parsed = rawArgs ? JSON.parse(rawArgs) : undefined;
  } catch {
    return fail(toolName, "they are not valid JSON.");
  }

  const result = schema.safeParse(parsed);
  if (result.success) {
    return { ok: true };
  }

  const detail = result.error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return fail(toolName, `they do not match the tool's schema (${detail}).`);
}

function fail(toolName: string, reason: string): ToolArgsValidation {
  return {
    ok: false,
    error: `Invalid \`${toolName}\` arguments: ${reason} Fix them and call the tool again.`,
  };
}

const HITL_SYSTEM_PROMPT = `# Asking the user (Human-in-the-Loop)

Two tools hand control back to the user and pause you until they respond: \`${HITL_ASK_USER_TOOL_NAME}\` and \`${HITL_REQUEST_APPROVAL_TOOL_NAME}\`. Call one on its own — never alongside another tool call, and don't keep writing afterwards. You are resumed with the user's response as that call's tool result.

## \`${HITL_ASK_USER_TOOL_NAME}\`
Use it when you are genuinely blocked on something only the user can tell you. Supply \`options\` when the answer is a choice from a known set (add \`allowMultiple\` for several, \`allowOther\` to also accept something you didn't list); omit them for free text.

Result: \`{"answer": "<value>"}\`, or \`{"answer": ["<value>", …]}\` for a multi-select. If the user replied in chat instead of using the prompt you get \`{"cancelled": true}\` — read their message and carry on rather than re-opening the same question.

## \`${HITL_REQUEST_APPROVAL_TOOL_NAME}\`
Use it *before* anything consequential or hard to undo: writing or deleting data, spending money, sending a message as the user, running a destructive command. Spell out in \`summary\` what will happen, and put the facts worth checking in \`details\`.

Result: \`{"decision": "approved" | "rejected", "comment"?: "<note>"}\`. On \`approved\`, do exactly what you described — nothing more. On \`rejected\`, stop, acknowledge it, and don't retry or work around it; ask what to do differently instead.

## When not to use them
Don't interrupt for rhetorical questions, for something the user already told you, or for a detail you can reasonably infer or safely default. If a question isn't blocking, just ask it in plain text and keep going. For a single question or a yes/no decision prefer these tools over \`render_a2ui\`; reach for \`render_a2ui\` when the interaction needs a richer layout or several fields at once.`;
