import { A2uiMessageListSchema } from "@a2ui/web_core/v0_9";

import type { ModelFunctionTool } from "./types.ts";

/**
 * A2UI (Agent-to-UI) support for the native agent loop.
 *
 * A2UI is Google's declarative, JSON-based protocol for agent-driven generative
 * UI (https://a2ui.org). We carry it over AG-UI as a single client-rendered tool
 * call: the model calls {@link A2UI_RENDER_TOOL_NAME} with a list of A2UI
 * messages as its arguments, and the frontend renders them with the official
 * `@a2ui/lit` renderer.
 *
 * The tool is intentionally NOT registered as a server tool. The native loop
 * stops a run whenever a non-server tool is called (see `loop.ts`), so calling
 * `render_a2ui` finishes the run and hands control to the client — exactly the
 * Human-in-the-Loop path. When the user interacts with the surface, the client
 * resumes the run with a `tool` result carrying the A2UI action, and the model
 * continues. Only the tool *definition* and the authoring guidance live
 * server-side; fulfillment (rendering + action capture) is the client's.
 */
export const A2UI_RENDER_TOOL_NAME = "render_a2ui";

/**
 * The function declaration advertised to the model. A2UI v0.9 is "prompt-first"
 * — the detailed component schemas live in the system prompt (see
 * {@link a2uiSystemPromptSection}), so the tool's JSON Schema stays permissive
 * and only pins the envelope: a list of A2UI message objects.
 */
export function a2uiRenderToolDef(): ModelFunctionTool {
  return {
    type: "function",
    name: A2UI_RENDER_TOOL_NAME,
    description:
      "Render a rich, interactive UI surface to the user using the A2UI protocol. " +
      "Pass `messages`: an ordered list of A2UI v0.9 messages (createSurface, then " +
      "updateComponents, then any updateDataModel). Prefer this over plain text when a " +
      "card, form, list, or any interactive layout communicates better. If the surface " +
      "has buttons or inputs, the user's action is returned to you as this tool's result.",
    inputSchema: {
      type: "object",
      properties: {
        messages: {
          type: "array",
          description: "Ordered list of A2UI v0.9 server-to-client messages describing the UI.",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["messages"],
      additionalProperties: false,
    },
  };
}

/** Outcome of validating a `render_a2ui` tool call's arguments. */
export type A2uiValidation = { ok: true } | { ok: false; error: string };

/**
 * Validates the raw `render_a2ui` arguments against the official A2UI v0.9
 * message schema from `@a2ui/web_core`, so the loop can hand the client a
 * well-formed surface — or bounce a clear error back to the model to self-correct
 * — instead of streaming broken UI. Catches envelope mistakes (missing version,
 * wrong message shape, components not a list, …); component-property errors that
 * are catalog-specific still surface in the renderer.
 */
export function validateA2uiMessages(rawArgs: string): A2uiValidation {
  let parsed: unknown;
  try {
    parsed = rawArgs ? JSON.parse(rawArgs) : undefined;
  } catch {
    return { ok: false, error: "are not valid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || !("messages" in parsed)) {
    return { ok: false, error: 'must be an object with a "messages" array.' };
  }
  const { messages } = parsed as { messages: unknown };
  if (!Array.isArray(messages)) {
    return { ok: false, error: '"messages" must be an array of A2UI messages.' };
  }

  const result = A2uiMessageListSchema.safeParse(messages);
  if (result.success) {
    return { ok: true };
  }
  const detail = result.error.issues
    .slice(0, 6)
    .map((issue) => {
      const path = issue.path.length > 0 ? `messages/${issue.path.join("/")}` : "messages";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  return { ok: false, error: `do not match the A2UI v0.9 schema (${detail}).` };
}

/**
 * The A2UI authoring guide appended to the agent's system prompt. Teaches the
 * model the v0.9 message envelope, the flat component model, data binding, and
 * the basic catalog so it can author valid surfaces via {@link a2uiRenderToolDef}.
 */
export function a2uiSystemPromptSection(): string {
  return A2UI_SYSTEM_PROMPT;
}

const A2UI_SYSTEM_PROMPT = `# Generative UI with A2UI

You can render rich, interactive UI to the user by calling the \`${A2UI_RENDER_TOOL_NAME}\` tool with a list of A2UI v0.9 messages. Use it whenever a card, form, list, profile, or any interactive layout communicates better than plain text. Otherwise just reply with text.

## Message envelope
Pass \`messages\`: an ordered array. Each message has \`"version": "v0.9"\` and exactly one of:
- \`createSurface\`: { surfaceId, catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json", sendDataModel?: boolean, theme? }. Always send this first. Use a unique \`surfaceId\` per call (e.g. "surface_<short-random>"). Set \`sendDataModel: true\` if the surface has inputs whose values you need back.
- \`updateComponents\`: { surfaceId, components: Component[] }. The components.
- \`updateDataModel\`: { surfaceId, path: "/json/pointer", value }. Optional; seeds input/bound values.
- \`deleteSurface\`: { surfaceId }.

## Component model (flat list)
Components are a FLAT array, not nested. Each has a unique \`id\` and a \`component\` type; containers reference children by id. Exactly one component must have \`id: "root"\`.

## Basic catalog components
- Layout: Row{children,justify?,align?}, Column{children,justify?,align?}, List{children,direction?}, Card{child}, Tabs{tabs:[{title,child}]}, Modal{trigger,content}, Divider{axis?}
- Content: Text{text,variant?(h1..h5|body|caption)}, Image{url,description?,fit?,variant?}, Icon{name}, Video{url}
- Input: Button{child,action,variant?}, TextField{label,value?,variant?,validationRegexp?}, CheckBox{label,value}, ChoicePicker{options:[{label,value}],value,variant?}, Slider{value,max,min?,label?}, DateTimeInput{value,enableDate?,enableTime?,label?}

\`children\` is an array of component ids (or a template { path, componentId } to repeat over an array in the data model). \`child\` is a single component id.

## Data binding & actions
- Bind a property to data with a JSON Pointer: \`"value": { "path": "/form/name" }\`. Literals are passed directly.
- A Button (or other input) triggers a server action via \`"action": { "event": { "name": "<actionName>", "context": { ... } } }\`. When the user triggers it, you receive a tool result like \`{ "action": { "name": "<actionName>", "surfaceId", "sourceComponentId", "context": {...} }, "dataModel": { "version": "v0.9", "surfaces": { "<surfaceId>": { ...inputs... } } } }\`. Read it and continue (render another surface, or reply).

## Example
\`\`\`json
{
  "messages": [
    { "version": "v0.9", "createSurface": { "surfaceId": "surface_signup1", "catalogId": "https://a2ui.org/specification/v0_9/basic_catalog.json", "sendDataModel": true } },
    { "version": "v0.9", "updateComponents": { "surfaceId": "surface_signup1", "components": [
      { "id": "root", "component": "Card", "child": "col" },
      { "id": "col", "component": "Column", "children": ["title", "name", "submit"] },
      { "id": "title", "component": "Text", "text": "Sign up", "variant": "h3" },
      { "id": "name", "component": "TextField", "label": "Your name", "value": { "path": "/name" } },
      { "id": "submit", "component": "Button", "child": "submitLabel", "variant": "primary", "action": { "event": { "name": "submit", "context": {} } } },
      { "id": "submitLabel", "component": "Text", "text": "Continue" }
    ] } }
  ]
}
\`\`\`

Keep surfaces focused. Emit only valid JSON in the tool arguments.`;
