import { randomUUID } from "node:crypto";
import path from "node:path";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessagePart {
  type: string;
  text?: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | ChatMessagePart[];
  name?: string;
}

export interface ChatCompletionRequestBody {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  user?: string;
}

export interface ResponseInputItem {
  type?: string;
  role?: string;
  content?: unknown;
  text?: string;
 }

export interface OpenAIModelObject {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function createCompletionId(): string {
  return `chatcmpl-${randomUUID()}`;
}

export function createResponseId(): string {
  return `resp_${randomUUID().replace(/-/g, "")}`;
}

export function createMessageId(): string {
  return `msg_${randomUUID().replace(/-/g, "")}`;
}

export function extractTextContent(content: string | ChatMessagePart[]): string {
  if (typeof content === "string") {
    return content;
  }

  const textParts = content.map((part) => {
    if (part.type !== "text" || typeof part.text !== "string") {
      throw new Error(`Unsupported content part type: ${part.type}`);
    }

    return part.text;
  });

  return textParts.join("\n");
}

export function normalizeResponsesInput(input: string | ResponseInputItem[]): ChatMessage[] {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }

  const messages: ChatMessage[] = [];

  for (const item of input) {
    if (typeof item !== "object" || item === null) {
      throw new Error("Unsupported responses input item.");
    }

    if (item.type === "input_text" && typeof item.text === "string") {
      messages.push({
        role: "user",
        content: item.text
      });
      continue;
    }

    if (typeof item.role === "string" && item.content !== undefined) {
      messages.push({
        role: normalizeResponseRole(item.role),
        content: normalizeResponseContent(item.content)
      });
      continue;
    }

    if (item.type === "message" && typeof item.role === "string") {
      messages.push({
        role: normalizeResponseRole(item.role),
        content: normalizeResponseContent(item.content)
      });
      continue;
    }

    throw new Error("Unsupported responses input item.");
  }

  return messages;
}

export function renderTranscript(messages: ChatMessage[]): string {
  const systemMessages = messages
    .filter((message) => message.role === "system")
    .map((message) => extractTextContent(message.content).trim())
    .filter(Boolean);

  const conversation = messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const label = message.name ? `${message.role}:${message.name}` : message.role;
      const content = extractTextContent(message.content).trim();
      return `${label.toUpperCase()}:\n${content}`;
    })
    .join("\n\n");

  return [
    "You are a helpful AI assistant.",
    "Continue the conversation naturally as the assistant.",
    "Return only the assistant's next message.",
    systemMessages.length > 0
      ? `\nSYSTEM INSTRUCTIONS:\n${systemMessages.join("\n\n")}`
      : "",
    conversation ? `\nCONVERSATION:\n${conversation}` : "",
    "\nASSISTANT:"
  ]
    .filter(Boolean)
    .join("\n");
}

export function prependInstructions(
  messages: ChatMessage[],
  instructions?: string
): ChatMessage[] {
  if (!instructions?.trim()) {
    return messages;
  }

  return [{ role: "system", content: instructions.trim() }, ...messages];
}

export function toModelAlias(input: string): string {
  return path.basename(input).toLowerCase();
}

export function formatChatCompletion(
  requestModel: string,
  text: string
): Record<string, unknown> {
  return {
    id: createCompletionId(),
    object: "chat.completion",
    created: nowSeconds(),
    model: requestModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text
        },
        finish_reason: "stop"
      }
    ]
  };
}

export function formatChatStreamChunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null
): Record<string, unknown> {
  return {
    id,
    object: "chat.completion.chunk",
    created: nowSeconds(),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason
      }
    ]
  };
}

export function formatResponseObject(
  requestModel: string,
  text: string,
  instructions?: string
): Record<string, unknown> {
  return buildResponseObject({
    id: createResponseId(),
    messageId: createMessageId(),
    requestModel,
    text,
    instructions,
    status: "completed"
  });
}

export function formatResponseCreated(
  id: string,
  requestModel: string,
  instructions?: string
): Record<string, unknown> {
  return buildResponseObject({
    id,
    messageId: createMessageId(),
    requestModel,
    text: "",
    instructions,
    status: "in_progress"
  });
}

export function formatResponseCompleted(
  id: string,
  messageId: string,
  requestModel: string,
  text: string,
  instructions?: string
): Record<string, unknown> {
  return buildResponseObject({
    id,
    messageId,
    requestModel,
    text,
    instructions,
    status: "completed"
  });
}

function buildResponseObject(input: {
  id: string;
  messageId: string;
  requestModel: string;
  text: string;
  instructions?: string;
  status: "in_progress" | "completed";
}): Record<string, unknown> {
  const output =
    input.status === "completed"
      ? [
          {
            id: input.messageId,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: input.text,
                annotations: []
              }
            ]
          }
        ]
      : [];

  return {
    id: input.id,
    object: "response",
    created_at: nowSeconds(),
    status: input.status,
    error: null,
    incomplete_details: null,
    instructions: input.instructions ?? null,
    model: input.requestModel,
    output,
    parallel_tool_calls: false,
    tool_choice: "none",
    tools: [],
    max_output_tokens: null,
    previous_response_id: null,
    reasoning: {
      effort: null,
      summary: null
    },
    store: false,
    temperature: null,
    text: {
      format: {
        type: "text"
      }
    },
    usage: null,
    metadata: {}
  };
}

function normalizeResponseRole(role: string): ChatRole {
  if (role === "developer") {
    return "system";
  }

  if (role === "system" || role === "user" || role === "assistant" || role === "tool") {
    return role;
  }

  throw new Error(`Unsupported responses role: ${role}`);
}

function normalizeResponseContent(content: unknown): string | ChatMessagePart[] {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    throw new Error("Unsupported responses content.");
  }

  return content.map((part) => {
    if (typeof part !== "object" || part === null) {
      throw new Error("Unsupported responses content part.");
    }

    const type = "type" in part ? part.type : undefined;
    const text = "text" in part ? part.text : undefined;

    if (
      (type === "text" || type === "input_text" || type === "output_text") &&
      typeof text === "string"
    ) {
      return {
        type: "text",
        text
      };
    }

    throw new Error(`Unsupported responses content part type: ${String(type)}`);
  });
}
