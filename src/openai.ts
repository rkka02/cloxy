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

export interface ToolFunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface ToolDefinition {
  type: "function";
  function: ToolFunctionDefinition;
}

export interface ToolChoiceFunction {
  type: "function";
  function: {
    name: string;
  };
}

export type ToolChoice = "auto" | "none" | "required" | ToolChoiceFunction;

export interface ToolCallInput {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface ChatMessageInput {
  role: ChatRole;
  content: string | ChatMessageInputPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCallInput[];
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
  call_id?: unknown;
  name?: unknown;
  arguments?: unknown;
  output?: unknown;
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

export interface PlannedToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ConversationMessage {
  role: ChatRole;
  content: MessageContentPart[];
  name?: string;
  toolCallId?: string;
  toolCalls?: PlannedToolCall[];
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

export function createToolCallId(): string {
  return `call_${randomUUID().replace(/-/g, "")}`;
}

export function normalizeChatMessages(messages: ChatMessageInput[]): ConversationMessage[] {
  const normalized = messages.map((message) => ({
    role: message.role,
    content: normalizeMessageContent(message.content),
    name: message.name,
    toolCallId: message.tool_call_id,
    toolCalls: normalizeToolCalls(message.tool_calls)
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

    if (item.type === "function_call_output") {
      if (typeof item.call_id !== "string") {
        throw new CloxyHttpError("Function call output is missing call_id.", 400);
      }

      messages.push({
        role: "tool",
        content: normalizeToolOutputContent(item.output),
        toolCallId: item.call_id
      });
      continue;
    }

    if (item.type === "function_call") {
      if (typeof item.name !== "string") {
        throw new CloxyHttpError("Function call item is missing a function name.", 400);
      }

      messages.push({
        role: "assistant",
        content: [],
        toolCalls: [
          {
            id: typeof item.call_id === "string" ? item.call_id : createToolCallId(),
            type: "function",
            function: {
              name: item.name,
              arguments: normalizeToolArguments(item.arguments)
            }
          }
        ]
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
      const label = renderConversationLabel(message);
      const parts: string[] = [];
      const content = renderMessageContent(message.content, {
        includeImagePlaceholders: options?.includeImagePlaceholders ?? false,
        nextImageIndex: () => {
          imageIndex += 1;
          return imageIndex;
        }
      }).trim();
      if (content) {
        parts.push(content);
      }

      if (message.toolCalls?.length) {
        parts.push(renderToolCallsForTranscript(message.toolCalls));
      }

      return `${label.toUpperCase()}:\n${parts.join("\n")}`;
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

export function renderToolPlanningPrompt(input: {
  messages: ConversationMessage[];
  tools: ToolDefinition[];
  toolChoice: ToolChoice;
  includeImagePlaceholders?: boolean;
}): string {
  return [
    "You are a helpful AI assistant.",
    "You may either answer normally or request one or more function calls.",
    "Return strictly valid JSON and no markdown.",
    'If you want to answer directly, return {"type":"assistant","content":"..."}',
    'If you want to call tool(s), return {"type":"tool_calls","tool_calls":[{"name":"tool_name","arguments":{}}]}',
    "Arguments must be valid JSON objects.",
    renderToolChoiceInstruction(input.toolChoice),
    `AVAILABLE TOOLS:\n${renderAvailableTools(input.tools)}`,
    renderTranscript(input.messages, {
      includeImagePlaceholders: input.includeImagePlaceholders
    })
  ].join("\n\n");
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

export function formatChatToolCompletion(
  requestModel: string,
  toolCalls: PlannedToolCall[],
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
          content: null,
          tool_calls: toolCalls
        },
        finish_reason: "tool_calls"
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

export function formatResponseToolObject(
  requestModel: string,
  toolCalls: PlannedToolCall[],
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
    text: "",
    instructions,
    status: "completed",
    sessionMode: options?.sessionMode,
    sessionId: options?.sessionId,
    toolCalls
  });
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
  toolCalls?: PlannedToolCall[];
}): Record<string, unknown> {
  const output =
    input.status === "completed"
      ? input.toolCalls?.length
        ? input.toolCalls.map((toolCall) => ({
            id: input.messageId,
            type: "function_call",
            status: "completed",
            call_id: toolCall.id,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments
          }))
        : [
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
      ...(input.sessionId ? { cloxy_session_id: input.sessionId } : {}),
      ...(input.toolCalls?.length ? { cloxy_tool_call_count: input.toolCalls.length } : {})
    }
  };
}

export function normalizeTools(
  tools: unknown,
  toolChoice: unknown
): {
  tools: ToolDefinition[];
  toolChoice: ToolChoice;
} {
  if (tools === undefined) {
    return {
      tools: [],
      toolChoice: "none"
    };
  }

  if (!Array.isArray(tools)) {
    throw new CloxyHttpError("tools must be an array.", 400);
  }

  const normalizedTools = tools.map((tool) => normalizeToolDefinition(tool));
  const normalizedToolChoice = normalizeToolChoice(toolChoice, normalizedTools);

  return {
    tools: normalizedTools,
    toolChoice: normalizedToolChoice
  };
}

export function parseToolPlannerResult(
  text: string,
  context: {
    toolChoice: ToolChoice;
    tools: ToolDefinition[];
  }
):
  | { type: "assistant"; content: string }
  | { type: "tool_calls"; toolCalls: PlannedToolCall[] } {
  const parsed = parseJsonObject(text);
  if (!parsed || typeof parsed !== "object") {
    if (context.toolChoice === "required" || typeof context.toolChoice === "object") {
      throw new Error("Backend did not return valid JSON for the requested tool call.");
    }

    return {
      type: "assistant",
      content: text.trim()
    };
  }

  if (parsed.type === "assistant") {
    if (typeof parsed.content !== "string") {
      throw new Error("Tool planner assistant response is missing string content.");
    }

    if (context.toolChoice === "required" || typeof context.toolChoice === "object") {
      throw new Error("Tool choice required a function call, but backend returned assistant text.");
    }

    return {
      type: "assistant",
      content: parsed.content
    };
  }

  if (parsed.type === "tool_calls") {
    if (!Array.isArray(parsed.tool_calls) || parsed.tool_calls.length === 0) {
      throw new Error("Tool planner response did not include any tool calls.");
    }

    const availableToolNames = new Set(context.tools.map((tool) => tool.function.name));
    const toolCalls = parsed.tool_calls.map((toolCall: unknown) => {
      if (typeof toolCall !== "object" || toolCall === null) {
        throw new Error("Tool call must be an object.");
      }

      const name =
        "name" in toolCall && typeof toolCall.name === "string"
          ? toolCall.name
          : undefined;
      const argumentsValue =
        "arguments" in toolCall ? toolCall.arguments : undefined;

      if (!name || !availableToolNames.has(name)) {
        throw new Error(`Tool call referenced unknown tool: ${name ?? "unknown"}`);
      }

      return {
        id: createToolCallId(),
        type: "function" as const,
        function: {
          name,
          arguments: normalizeToolArguments(argumentsValue)
        }
      };
    });

    if (typeof context.toolChoice === "object") {
      const requiredName = context.toolChoice.function.name;
      if (toolCalls.length !== 1 || toolCalls[0].function.name !== requiredName) {
        throw new Error(
          `Tool choice required function ${requiredName}, but backend returned a different tool call.`
        );
      }
    }

    return {
      type: "tool_calls",
      toolCalls
    };
  }

  throw new Error("Tool planner response has unsupported type.");
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

function normalizeMessageContent(
  content: string | ChatMessageInputPart[] | null
): MessageContentPart[] {
  if (content === null) {
    return [];
  }

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

function normalizeToolCalls(toolCalls: ToolCallInput[] | undefined): PlannedToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) {
    return undefined;
  }

  return toolCalls.map((toolCall) => {
    if (toolCall.type !== undefined && toolCall.type !== "function") {
      throw new CloxyHttpError(
        `Unsupported tool call type: ${String(toolCall.type)}`,
        400
      );
    }

    const name = toolCall.function?.name;
    if (!name) {
      throw new CloxyHttpError("Assistant tool call is missing a function name.", 400);
    }

    return {
      id: toolCall.id ?? createToolCallId(),
      type: "function",
      function: {
        name,
        arguments: normalizeToolArguments(toolCall.function?.arguments)
      }
    };
  });
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

function normalizeToolDefinition(tool: unknown): ToolDefinition {
  if (typeof tool !== "object" || tool === null) {
    throw new CloxyHttpError("Tool definition must be an object.", 400);
  }

  const candidate = tool as {
    type?: unknown;
    function?: {
      name?: unknown;
      description?: unknown;
      parameters?: unknown;
    };
  };

  if (candidate.type !== "function") {
    throw new UnsupportedFeatureError("Only function tools are supported right now.");
  }

  if (!candidate.function || typeof candidate.function.name !== "string") {
    throw new CloxyHttpError("Function tool is missing a valid name.", 400);
  }

  return {
    type: "function",
    function: {
      name: candidate.function.name,
      ...(typeof candidate.function.description === "string"
        ? { description: candidate.function.description }
        : {}),
      ...(candidate.function.parameters &&
      typeof candidate.function.parameters === "object" &&
      !Array.isArray(candidate.function.parameters)
        ? { parameters: candidate.function.parameters as Record<string, unknown> }
        : {})
    }
  };
}

function normalizeToolChoice(
  toolChoice: unknown,
  tools: ToolDefinition[]
): ToolChoice {
  if (toolChoice === undefined || toolChoice === null) {
    return tools.length > 0 ? "auto" : "none";
  }

  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    return toolChoice;
  }

  if (typeof toolChoice !== "object" || toolChoice === null) {
    throw new CloxyHttpError("tool_choice is invalid.", 400);
  }

  const candidate = toolChoice as {
    type?: unknown;
    function?: {
      name?: unknown;
    };
  };

  if (
    candidate.type !== "function" ||
    !candidate.function ||
    typeof candidate.function.name !== "string"
  ) {
    throw new CloxyHttpError("tool_choice must reference a valid function name.", 400);
  }

  const exists = tools.some((tool) => tool.function.name === candidate.function!.name);
  if (!exists) {
    throw new CloxyHttpError(
      `tool_choice referenced unknown tool: ${candidate.function.name}`,
      400
    );
  }

  return {
    type: "function",
    function: {
      name: candidate.function.name
    }
  };
}

function normalizeToolArguments(argumentsValue: unknown): string {
  if (argumentsValue === undefined) {
    return "{}";
  }

  if (typeof argumentsValue === "string") {
    try {
      const parsed = JSON.parse(argumentsValue) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Tool call arguments must decode to an object.");
      }

      return JSON.stringify(parsed);
    } catch (error) {
      throw new CloxyHttpError(
        error instanceof Error ? error.message : "Tool call arguments are not valid JSON.",
        400
      );
    }
  }

  if (typeof argumentsValue !== "object" || argumentsValue === null || Array.isArray(argumentsValue)) {
    throw new CloxyHttpError("Tool call arguments must be an object.", 400);
  }

  return JSON.stringify(argumentsValue);
}

function normalizeToolOutputContent(output: unknown): MessageContentPart[] {
  if (typeof output === "string") {
    return [{ type: "text", text: output }];
  }

  if (output === undefined) {
    return [{ type: "text", text: "" }];
  }

  return [{ type: "text", text: JSON.stringify(output) }];
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

function renderConversationLabel(message: ConversationMessage): string {
  if (message.role === "tool") {
    if (message.name && message.toolCallId) {
      return `tool:${message.name}:${message.toolCallId}`;
    }
    if (message.name) {
      return `tool:${message.name}`;
    }
    if (message.toolCallId) {
      return `tool:${message.toolCallId}`;
    }
  }

  return message.name ? `${message.role}:${message.name}` : message.role;
}

function renderToolCallsForTranscript(toolCalls: PlannedToolCall[]): string {
  return toolCalls
    .map(
      (toolCall) =>
        `[TOOL CALL ${toolCall.id}] ${toolCall.function.name}\nARGUMENTS:\n${toolCall.function.arguments}`
    )
    .join("\n");
}

function renderAvailableTools(tools: ToolDefinition[]): string {
  return tools
    .map((tool) => {
      const description = tool.function.description?.trim();
      const parameters = tool.function.parameters
        ? JSON.stringify(tool.function.parameters, null, 2)
        : "{}";

      return [
        `- ${tool.function.name}`,
        description ? `  description: ${description}` : "",
        `  parameters_json_schema: ${parameters}`
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}

function renderToolChoiceInstruction(toolChoice: ToolChoice): string {
  if (toolChoice === "none") {
    return "You must answer directly and must not call any tool.";
  }

  if (toolChoice === "required") {
    return "You must return at least one tool call.";
  }

  if (toolChoice === "auto") {
    return "You may answer directly or call tool(s) if needed.";
  }

  return `You must call exactly one function named ${toolChoice.function.name}.`;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as unknown;
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}
