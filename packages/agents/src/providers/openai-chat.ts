import {
  EventType,
  type AGUIEvent,
  type Context,
  type Message,
  type RunAgentInput,
  type Tool,
} from "@ag-ui/core";
import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionFunctionTool,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";

import { aguiEvent } from "../events.js";
import type {
  AgentConfig,
  AgentProvider,
  AgentRunner,
  LanguageModelConfig,
} from "../types.js";

const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";
const DEFAULT_MAX_TOOL_ITERATIONS = 4;

interface StreamModelTurnParams {
  client: OpenAI;
  input: RunAgentInput;
  messages: ChatCompletionMessageParam[];
  model: string;
  tools: ChatCompletionTool[];
  turnIndex: number;
}

interface StreamModelTurnResult {
  content: string;
  messageId: string;
  toolCalls: CompletedToolCall[];
}

interface CompletedToolCall {
  arguments: string;
  id: string;
  index: number;
  name: string;
}

interface ToolCallState extends CompletedToolCall {
  ended: boolean;
  started: boolean;
}

interface LocalTool {
  definition: ChatCompletionFunctionTool;
  execute: (args: unknown) => Promise<string> | string;
}

type ToolCallDelta = NonNullable<
  ChatCompletionChunk.Choice.Delta["tool_calls"]
>[number];

type ModelBackedAgentOptions = LanguageModelConfig & {
  apiKey: string;
  maxToolIterations?: number;
};

export const openAIChatAgentProvider: AgentProvider = {
  id: "openai-chat",
  label: "OpenAI Chat Agent",
  description: "OpenAI Chat Completions streaming agent with AG-UI event mapping.",
  configurationHint: "Set OPENAI_API_KEY to enable it.",
  create: ({ config }) => createOpenAIChatAgentFromConfig(config),
};

function createOpenAIChatAgent(
  options: ModelBackedAgentOptions,
): AgentRunner {
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
  });
  const model = options.model ?? DEFAULT_OPENAI_MODEL;
  const maxToolIterations = options.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;

  return async function* runOpenAIChatAgent(
    input: RunAgentInput,
  ): AsyncGenerator<AGUIEvent> {
    const messages = toOpenAIMessages(input);
    const tools = toOpenAITools(input.tools);
    let finalMessageId: string | undefined;

    yield aguiEvent({
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
      parentRunId: input.parentRunId,
    });

    for (let turnIndex = 0; turnIndex <= maxToolIterations; turnIndex += 1) {
      yield aguiEvent({
        type: EventType.STEP_STARTED,
        stepName: `openai-chat-${turnIndex + 1}`,
      });

      const turn = yield* streamModelTurn({
        client,
        input,
        messages,
        model,
        tools,
        turnIndex,
      });

      finalMessageId = turn.messageId;

      const toolMessages =
        turn.toolCalls.length > 0
          ? await executeLocalToolCalls(turn)
          : {
              events: [],
              hasExternalToolCall: false,
              messages: [],
            };

      for (const event of toolMessages.events) {
        yield event;
      }

      yield aguiEvent({
        type: EventType.STEP_FINISHED,
        stepName: `openai-chat-${turnIndex + 1}`,
      });

      if (turn.toolCalls.length === 0) {
        break;
      }

      messages.push(toAssistantMessage(turn));

      if (toolMessages.messages.length === 0 || toolMessages.hasExternalToolCall) {
        break;
      }

      messages.push(...toolMessages.messages);
    }

    yield aguiEvent({
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
      result: finalMessageId ? { messageId: finalMessageId } : undefined,
      outcome: {
        type: "success",
      },
    });
  };
}

function createOpenAIChatAgentFromConfig(
  config: AgentConfig,
): AgentRunner | undefined {
  const languageModel = config.languageModel;
  if (!languageModel?.apiKey) {
    return undefined;
  }

  return createOpenAIChatAgent({
    apiKey: languageModel.apiKey,
    baseURL: languageModel.baseURL,
    model: languageModel.model,
    maxToolIterations: config.execution?.maxToolIterations,
  });
}

async function* streamModelTurn({
  client,
  input,
  messages,
  model,
  tools,
  turnIndex,
}: StreamModelTurnParams): AsyncGenerator<AGUIEvent, StreamModelTurnResult> {
  const messageId = `msg_${input.runId}_${turnIndex + 1}`;
  const toolCalls = new Map<number, ToolCallState>();
  let content = "";

  yield aguiEvent({
    type: EventType.TEXT_MESSAGE_START,
    messageId,
    role: "assistant",
  });

  const stream = await client.chat.completions.create({
    model,
    messages,
    stream: true,
    stream_options: {
      include_obfuscation: false,
    },
    ...(tools.length > 0
      ? {
          tool_choice: "auto" as const,
          tools,
        }
      : {}),
  });

  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    if (!choice) {
      continue;
    }

    const textDelta = choice.delta.content;
    if (textDelta) {
      content += textDelta;
      yield aguiEvent({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: textDelta,
      });
    }

    for (const toolCallDelta of choice.delta.tool_calls ?? []) {
      const toolCall = updateToolCallState(
        toolCalls,
        input.runId,
        turnIndex,
        toolCallDelta,
      );

      if (!toolCall.started) {
        toolCall.started = true;
        yield aguiEvent({
          type: EventType.TOOL_CALL_START,
          toolCallId: toolCall.id,
          toolCallName: toolCall.name,
          parentMessageId: messageId,
        });
      }

      const argsDelta = toolCallDelta.function?.arguments;
      if (argsDelta) {
        toolCall.arguments += argsDelta;
        yield aguiEvent({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: toolCall.id,
          delta: argsDelta,
        });
      }
    }
  }

  for (const toolCall of toolCalls.values()) {
    if (toolCall.started && !toolCall.ended) {
      toolCall.ended = true;
      yield aguiEvent({
        type: EventType.TOOL_CALL_END,
        toolCallId: toolCall.id,
      });
    }
  }

  yield aguiEvent({
    type: EventType.TEXT_MESSAGE_END,
    messageId,
  });

  return {
    content,
    messageId,
    toolCalls: [...toolCalls.values()].map(({ ended, started, ...toolCall }) => toolCall),
  };
}

function updateToolCallState(
  toolCalls: Map<number, ToolCallState>,
  runId: string,
  turnIndex: number,
  delta: ToolCallDelta,
): ToolCallState {
  const state =
    toolCalls.get(delta.index) ??
    ({
      arguments: "",
      ended: false,
      id: delta.id ?? `call_${runId}_${turnIndex + 1}_${delta.index}`,
      index: delta.index,
      name: delta.function?.name ?? "unknown_tool",
      started: false,
    } satisfies ToolCallState);

  if (!state.started) {
    state.id = delta.id ?? state.id;
    state.name = delta.function?.name ?? state.name;
  }

  toolCalls.set(delta.index, state);
  return state;
}

function toOpenAIMessages(input: RunAgentInput): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];

  const contextMessage = toContextMessage(input.context);
  if (contextMessage) {
    messages.push(contextMessage);
  }

  for (const message of input.messages) {
    messages.push(toOpenAIMessage(message));
  }

  return messages;
}

function toContextMessage(context: Context[]): ChatCompletionMessageParam | undefined {
  if (context.length === 0) {
    return undefined;
  }

  return {
    role: "developer",
    content: context
      .map((item) => `${item.description}: ${item.value}`)
      .join("\n"),
  };
}

function toOpenAIMessage(message: Message): ChatCompletionMessageParam {
  switch (message.role) {
    case "developer":
    case "system":
      return {
        role: message.role,
        content: message.content,
        name: message.name,
      };
    case "user":
      return {
        role: "user",
        content: toOpenAIUserContent(message),
        name: message.name,
      };
    case "assistant":
      return toOpenAIAssistantMessage(message);
    case "tool":
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId,
      };
    case "activity":
      return {
        role: "developer",
        content: `Activity ${message.activityType}: ${JSON.stringify(message.content)}`,
      };
    case "reasoning":
      return {
        role: "developer",
        content: `Previous reasoning: ${message.content}`,
      };
  }
}

function toOpenAIUserContent(message: Extract<Message, { role: "user" }>): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }

      return `[${part.type} input omitted by text-only OpenAI chat adapter]`;
    })
    .join("\n");
}

function toOpenAIAssistantMessage(
  message: Extract<Message, { role: "assistant" }>,
): ChatCompletionAssistantMessageParam {
  const openAIMessage: ChatCompletionAssistantMessageParam = {
    role: "assistant",
    content: message.content ?? null,
    name: message.name,
  };

  if (message.toolCalls && message.toolCalls.length > 0) {
    openAIMessage.tool_calls = message.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      },
    }));
  }

  return openAIMessage;
}

function toAssistantMessage(turn: StreamModelTurnResult): ChatCompletionAssistantMessageParam {
  const message: ChatCompletionAssistantMessageParam = {
    role: "assistant",
    content: turn.content || null,
  };

  if (turn.toolCalls.length > 0) {
    message.tool_calls = turn.toolCalls.map(toOpenAIToolCall);
  }

  return message;
}

function toOpenAIToolCall(toolCall: CompletedToolCall): ChatCompletionMessageToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: toolCall.arguments,
    },
  };
}

function toOpenAITools(inputTools: Tool[]): ChatCompletionTool[] {
  const tools = new Map<string, ChatCompletionTool>();

  for (const localTool of localTools.values()) {
    const name = localTool.definition.function.name;
    tools.set(name, localTool.definition);
  }

  for (const tool of inputTools) {
    if (tools.has(tool.name)) {
      continue;
    }

    tools.set(tool.name, {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: isRecord(tool.parameters)
          ? tool.parameters
          : {
              type: "object",
              properties: {},
            },
      },
    });
  }

  return [...tools.values()];
}

async function executeLocalToolCalls(
  turn: StreamModelTurnResult,
): Promise<{
  events: AGUIEvent[];
  hasExternalToolCall: boolean;
  messages: ChatCompletionToolMessageParam[];
}> {
  const events: AGUIEvent[] = [];
  const toolMessages: ChatCompletionToolMessageParam[] = [];
  let hasExternalToolCall = false;

  for (const toolCall of turn.toolCalls) {
    const localTool = localTools.get(toolCall.name);
    if (!localTool) {
      hasExternalToolCall = true;
      continue;
    }

    const content = await localTool.execute(parseToolArguments(toolCall.arguments));
    const messageId = `tool_result_${toolCall.id}`;

    events.push(
      aguiEvent({
        type: EventType.TOOL_CALL_RESULT,
        messageId,
        toolCallId: toolCall.id,
        content,
        role: "tool",
      }),
    );

    toolMessages.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content,
    });
  }

  return {
    events,
    hasExternalToolCall,
    messages: toolMessages,
  };
}

const localTools = new Map<string, LocalTool>([
  [
    "get_server_time",
    {
      definition: {
        type: "function",
        function: {
          name: "get_server_time",
          description: "Get the server's current date and time.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      },
      execute: () =>
        JSON.stringify({
          iso: new Date().toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
    },
  ],
]);

function parseToolArguments(value: string): unknown {
  if (!value.trim()) {
    return {};
  }

  try {
    return JSON.parse(value);
  } catch {
    return {
      raw: value,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
