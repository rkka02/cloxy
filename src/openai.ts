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
