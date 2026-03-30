import { randomUUID } from "node:crypto";
import path from "node:path";
import { CloxyHttpError, PayloadTooLargeError, UnsupportedFeatureError } from "./errors";

export type ChatRole = "system" | "user" | "assistant" | "tool";
export type SupportedImageMediaType = "image/jpeg" | "image/png";
export type ImageDetail = "auto" | "low" | "high";

export interface ChatMessageInputPart {
  type: string;
  [key: string]: unknown;
}

export interface ChatMessageInput {
  role: ChatRole;
  content: string | ChatMessageInputPart[];
  name?: string;
}

export interface ChatCompletionRequestBody {
  model: string;
  messages: ChatMessageInput[];
  stream?: boolean;
  user?: string;
}

export interface ResponseInputItem {
  type?: string;
  role?: string;
  content?: unknown;
  text?: string;
  image_url?: unknown;
  detail?: unknown;
}

export interface TextContentPart {
  type: "text";
  text: string;
}

export interface ImageContentPart {
  type: "image";
  mediaType: SupportedImageMediaType;
  data: string;
  detail: ImageDetail;
  bytes: number;
}

export type MessageContentPart = TextContentPart | ImageContentPart;

export interface ConversationMessage {
  role: ChatRole;
  content: MessageContentPart[];
  name?: string;
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

export function normalizeChatMessages(messages: ChatMessageInput[]): ConversationMessage[] {
  const normalized = messages.map((message) => ({
    role: message.role,
    content: normalizeMessageContent(message.content),
    name: message.name
  }));

  enforceImageConstraints(normalized);
  return normalized;
}

export function normalizeResponsesInput(input: string | ResponseInputItem[]): ConversationMessage[] {
  if (typeof input === "string") {
    return [{ role: "user", content: [{ type: "text", text: input }] }];
  }

  const messages: ConversationMessage[] = [];

  for (const item of input) {
    if (typeof item !== "object" || item === null) {
      throw new CloxyHttpError("Unsupported responses input item.", 400);
    }

    if (item.type === "input_text" && typeof item.text === "string") {
      messages.push({
        role: "user",
        content: [{ type: "text", text: item.text }]
      });
      continue;
    }

    if (item.type === "input_image") {
      messages.push({
        role: "user",
        content: [normalizeImagePart(item.image_url, item.detail)]
      });
      continue;
    }

    if (typeof item.role === "string" && item.content !== undefined) {
      messages.push({
        role: normalizeResponseRole(item.role),
        content: normalizeContentValue(item.content)
      });
      continue;
    }

    if (item.type === "message" && typeof item.role === "string") {
      messages.push({
        role: normalizeResponseRole(item.role),
        content: normalizeContentValue(item.content)
      });
      continue;
    }

    throw new CloxyHttpError("Unsupported responses input item.", 400);
  }

  enforceImageConstraints(messages);
  return messages;
}

export function renderTranscript(
  messages: ConversationMessage[],
  options?: {
    includeImagePlaceholders?: boolean;
  }
): string {
  let imageIndex = 0;
  const systemMessages = messages
    .filter((message) => message.role === "system")
    .map((message) =>
      renderMessageContent(message.content, {
        includeImagePlaceholders: options?.includeImagePlaceholders ?? false,
        nextImageIndex: () => {
          imageIndex += 1;
          return imageIndex;
        }
      }).trim()
    )
    .filter(Boolean);

  const conversation = messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const label = message.name ? `${message.role}:${message.name}` : message.role;
      const content = renderMessageContent(message.content, {
        includeImagePlaceholders: options?.includeImagePlaceholders ?? false,
        nextImageIndex: () => {
          imageIndex += 1;
          return imageIndex;
        }
      }).trim();
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
  messages: ConversationMessage[],
  instructions?: string
): ConversationMessage[] {
  if (!instructions?.trim()) {
    return messages;
  }

  return [
    {
      role: "system",
      content: [{ type: "text", text: instructions.trim() }]
    },
    ...messages
  ];
}

export function toModelAlias(input: string): string {
  return path.basename(input).toLowerCase();
}

export function hasImageParts(messages: ConversationMessage[]): boolean {
  return messages.some((message) =>
    message.content.some((part) => part.type === "image")
  );
}

export function formatChatCompletion(
  requestModel: string,
  text: string,
  options?: {
    sessionMode?: "stateless" | "persist";
    sessionId?: string;
  }
): Record<string, unknown> {
  return {
    id: createCompletionId(),
    object: "chat.completion",
    created: nowSeconds(),
    model: requestModel,
    ...(options?.sessionMode
      ? {
          cloxy: {
            session_mode: options.sessionMode,
            ...(options.sessionId ? { session_id: options.sessionId } : {})
          }
        }
      : {}),
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
  instructions?: string,
  options?: {
    sessionMode?: "stateless" | "persist";
    sessionId?: string;
  }
): Record<string, unknown> {
  return buildResponseObject({
    id: createResponseId(),
    messageId: createMessageId(),
    requestModel,
    text,
    instructions,
    status: "completed",
    sessionMode: options?.sessionMode,
    sessionId: options?.sessionId
  });
}

export function formatResponseCreated(
  id: string,
  requestModel: string,
  instructions?: string,
  options?: {
    sessionMode?: "stateless" | "persist";
    sessionId?: string;
  }
): Record<string, unknown> {
  return buildResponseObject({
    id,
    messageId: createMessageId(),
    requestModel,
    text: "",
    instructions,
    status: "in_progress",
    sessionMode: options?.sessionMode,
    sessionId: options?.sessionId
  });
}

export function formatResponseCompleted(
  id: string,
  messageId: string,
  requestModel: string,
  text: string,
  instructions?: string,
  options?: {
    sessionMode?: "stateless" | "persist";
    sessionId?: string;
  }
): Record<string, unknown> {
  return buildResponseObject({
    id,
    messageId,
    requestModel,
    text,
    instructions,
    status: "completed",
    sessionMode: options?.sessionMode,
    sessionId: options?.sessionId
  });
}

function buildResponseObject(input: {
  id: string;
  messageId: string;
  requestModel: string;
  text: string;
  instructions?: string;
  status: "in_progress" | "completed";
  sessionMode?: "stateless" | "persist";
  sessionId?: string;
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
    metadata: {
      ...(input.sessionMode ? { cloxy_session_mode: input.sessionMode } : {}),
      ...(input.sessionId ? { cloxy_session_id: input.sessionId } : {})
    }
  };
}

function normalizeResponseRole(role: string): ChatRole {
  if (role === "developer") {
    return "system";
  }

  if (role === "system" || role === "user" || role === "assistant" || role === "tool") {
    return role;
  }

  throw new CloxyHttpError(`Unsupported responses role: ${role}`, 400);
}

function normalizeMessageContent(content: string | ChatMessageInputPart[]): MessageContentPart[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  return normalizeContentArray(content);
}

function normalizeContentValue(content: unknown): MessageContentPart[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  if (!Array.isArray(content)) {
    throw new CloxyHttpError("Unsupported responses content.", 400);
  }

  return normalizeContentArray(content);
}

function normalizeContentArray(content: unknown[]): MessageContentPart[] {
  return content.map((part) => normalizeContentPart(part));
}

function normalizeContentPart(part: unknown): MessageContentPart {
  if (typeof part !== "object" || part === null) {
    throw new CloxyHttpError("Unsupported content part.", 400);
  }

  const type = "type" in part ? part.type : undefined;
  const text = "text" in part ? part.text : undefined;
  const imageUrl = "image_url" in part ? part.image_url : undefined;
  const detail = "detail" in part ? part.detail : undefined;

  if (
    (type === "text" || type === "input_text" || type === "output_text") &&
    typeof text === "string"
  ) {
    return {
      type: "text",
      text
    };
  }

  if (type === "image_url" || type === "input_image") {
    return normalizeImagePart(imageUrl, detail);
  }

  throw new CloxyHttpError(`Unsupported content part type: ${String(type)}`, 400);
}

function normalizeImagePart(imageValue: unknown, detailOverride?: unknown): ImageContentPart {
  let url: string | undefined;
  let detailValue = detailOverride;

  if (typeof imageValue === "string") {
    url = imageValue;
  } else if (typeof imageValue === "object" && imageValue !== null) {
    const imageObject = imageValue as Record<string, unknown>;
    url = typeof imageObject.url === "string" ? imageObject.url : undefined;
    detailValue = imageObject.detail ?? detailOverride;
  }

  if (!url) {
    throw new CloxyHttpError("Image content part is missing a valid image URL.", 400);
  }

  if (!url.startsWith("data:")) {
    throw new UnsupportedFeatureError(
      "Only data URL image inputs are supported right now."
    );
  }

  const [header, rawPayload = ""] = url.split(",", 2);
  const mediaType = normalizeMediaType(header);
  const data = rawPayload.replace(/\s+/g, "");

  if (!data) {
    throw new CloxyHttpError("Image data URL payload is empty.", 400);
  }

  const bytes = decodeBase64Size(data);
  if (bytes <= 0) {
    throw new CloxyHttpError("Image data URL payload is invalid base64.", 400);
  }

  if (bytes > MAX_IMAGE_BYTES) {
    throw new PayloadTooLargeError(
      `Image input exceeds the ${formatBytes(MAX_IMAGE_BYTES)} per-image limit.`
    );
  }

  return {
    type: "image",
    mediaType,
    data,
    detail: normalizeImageDetail(detailValue),
    bytes
  };
}

function normalizeMediaType(header: string): SupportedImageMediaType {
  const match = /^data:(image\/[a-z0-9.+-]+);base64$/i.exec(header);
  if (!match) {
    throw new CloxyHttpError(
      "Image data URLs must use base64 encoding and an explicit media type.",
      400
    );
  }

  const mediaType = match[1].toLowerCase();
  if (mediaType === "image/jpeg" || mediaType === "image/png") {
    return mediaType;
  }

  throw new UnsupportedFeatureError(
    "Only data:image/jpeg and data:image/png inputs are supported."
  );
}

function normalizeImageDetail(value: unknown): ImageDetail {
  if (value === undefined || value === null || value === "") {
    return "auto";
  }

  if (value === "auto" || value === "low" || value === "high") {
    return value;
  }

  throw new CloxyHttpError(`Unsupported image detail value: ${String(value)}`, 400);
}

function decodeBase64Size(data: string): number {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    return 0;
  }

  const buffer = Buffer.from(data, "base64");
  const normalizedInput = data.replace(/=+$/, "");
  const normalizedDecoded = buffer.toString("base64").replace(/=+$/, "");
  if (normalizedInput !== normalizedDecoded) {
    return 0;
  }

  return buffer.byteLength;
}

function enforceImageConstraints(messages: ConversationMessage[]): void {
  let totalImageBytes = 0;
  let imageCount = 0;

  for (const message of messages) {
    for (const part of message.content) {
      if (part.type !== "image") {
        continue;
      }

      if (message.role !== "user") {
        throw new UnsupportedFeatureError(
          "Image content is only supported on user messages."
        );
      }

      imageCount += 1;
      totalImageBytes += part.bytes;

      if (imageCount > MAX_IMAGE_COUNT) {
        throw new PayloadTooLargeError(
          `Too many image inputs. The request limit is ${MAX_IMAGE_COUNT} images.`
        );
      }

      if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
        throw new PayloadTooLargeError(
          `Total image input exceeds the ${formatBytes(MAX_TOTAL_IMAGE_BYTES)} request limit.`
        );
      }
    }
  }
}

function renderMessageContent(
  content: MessageContentPart[],
  options: {
    includeImagePlaceholders: boolean;
    nextImageIndex: () => number;
  }
): string {
  const renderedParts = content.map((part) => {
    if (part.type === "text") {
      return part.text;
    }

    const imageIndex = options.nextImageIndex();
    if (!options.includeImagePlaceholders) {
      return `[Image ${imageIndex} attached]`;
    }

    return `[Image ${imageIndex} attached: ${part.mediaType}, detail=${part.detail}]`;
  });

  return renderedParts.join("\n");
}

function formatBytes(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))} MiB`;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_IMAGE_COUNT = 16;
