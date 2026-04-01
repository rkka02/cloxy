import {
  query,
  type PermissionMode,
  type SDKMessage,
  type SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { CloxyConfig } from "../config";
import { CloxyHttpError } from "../errors";
import type { ConversationMessage, MessageContentPart } from "../openai";
import type {
  BackendAdapter,
  ClaudePermissionMode,
  CompletionParams,
  CompletionResult,
  StreamEvent
} from "./types";

export class ClaudeAdapter implements BackendAdapter {
  readonly backend = "claude" as const;
  readonly usagePolicy = "private-use-only" as const;
  readonly capabilities = {
    text: true,
    imageInput: true,
    sessionPersistence: true,
    tools: true,
    streaming: true
  } as const;

  constructor(private readonly config: CloxyConfig) {}

  async complete(params: CompletionParams): Promise<CompletionResult> {
    let text = "";
    let sessionId = params.sessionId;

    for await (const message of runClaudeQuery(this.config, params, false)) {
      sessionId ??= getClaudeSessionId(message);

      if (message.type !== "result") {
        continue;
      }

      if (message.subtype !== "success" || message.is_error) {
        throw toClaudeFailureError(message);
      }

      text = message.result.trim();
    }

    if (!text) {
      throw new Error("Claude returned an empty result.");
    }

    return {
      backend: this.backend,
      text,
      sessionId
    };
  }

  async *stream(params: CompletionParams): AsyncGenerator<StreamEvent> {
    let emittedDone = false;
    let emittedSession = false;

    for await (const message of runClaudeQuery(this.config, params, true)) {
      const sessionId = getClaudeSessionId(message);
      if (!emittedSession && sessionId) {
        emittedSession = true;
        yield { type: "session", sessionId };
      }

      if (message.type === "stream_event") {
        const text = extractClaudeTextDelta(message);
        if (text) {
          yield { type: "delta", text };
        }
        continue;
      }

      if (message.type === "result") {
        if (message.subtype !== "success" || message.is_error) {
          throw toClaudeFailureError(message);
        }

        emittedDone = true;
        yield { type: "done" };
      }
    }

    if (!emittedDone) {
      yield { type: "done" };
    }
  }
}

async function* runClaudeQuery(
  config: CloxyConfig,
  params: CompletionParams,
  includePartialMessages: boolean
): AsyncGenerator<SDKMessage> {
  const permissionMode = params.claudePermissionMode ?? (config.claudePermissionMode as ClaudePermissionMode);
  const maxTurns = permissionMode === "plan" ? 1 : 8;
  const session = query({
    prompt: createClaudeInput(params.messages),
    options: {
      cwd: params.cwd,
      includePartialMessages,
      maxTurns,
      pathToClaudeCodeExecutable: config.claudeBinary,
      permissionMode: permissionMode as PermissionMode,
      allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
      persistSession: params.persistSession,
      resume: params.sessionId,
      systemPrompt: buildClaudeSystemPrompt(params.messages)
    }
  });

  try {
    for await (const message of session) {
      yield message;
    }
  } catch (error) {
    throw normalizeClaudeError(error);
  } finally {
    session.close();
  }
}

async function* createClaudeInput(
  messages: ConversationMessage[]
): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: buildClaudeUserContent(messages)
    }
  };
}

function buildClaudeSystemPrompt(messages: ConversationMessage[]): string {
  const systemMessages = messages
    .filter((message) => message.role === "system")
    .map((message) =>
      message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim()
    )
    .filter(Boolean);

  return [
    "You are a helpful AI assistant.",
    "Continue the conversation naturally as the assistant.",
    "Return only the assistant's next message.",
    systemMessages.length > 0
      ? `SYSTEM INSTRUCTIONS:\n${systemMessages.join("\n\n")}`
      : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildClaudeUserContent(messages: ConversationMessage[]): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  let textBuffer = "";

  const appendText = (text: string) => {
    textBuffer += text;
  };

  const flushText = () => {
    if (!textBuffer) {
      return;
    }

    blocks.push({
      type: "text",
      text: textBuffer
    });
    textBuffer = "";
  };

  appendText("CONVERSATION:\n");

  const conversationMessages = messages.filter((message) => message.role !== "system");
  if (conversationMessages.length === 0) {
    appendText("USER:\nReply to the system instructions.");
  }

  conversationMessages.forEach((message, messageIndex) => {
    if (messageIndex > 0) {
      appendText("\n\n");
    }

    const label = message.name ? `${message.role}:${message.name}` : message.role;
    appendText(`${label.toUpperCase()}:\n`);

    message.content.forEach((part, partIndex) => {
      appendClaudePart(part, appendText, flushText, blocks);

      if (partIndex < message.content.length - 1) {
        appendText("\n");
      }
    });
  });

  appendText("\n\nASSISTANT:");
  flushText();
  return blocks;
}

function appendClaudePart(
  part: MessageContentPart,
  appendText: (text: string) => void,
  flushText: () => void,
  blocks: ContentBlockParam[]
): void {
  if (part.type === "text") {
    appendText(part.text);
    return;
  }

  flushText();
  blocks.push({
    type: "image",
    source: {
      type: "base64",
      media_type: part.mediaType,
      data: part.data
    }
  });
}

function getClaudeSessionId(message: SDKMessage): string | undefined {
  return "session_id" in message && typeof message.session_id === "string"
    ? message.session_id
    : undefined;
}

function extractClaudeTextDelta(message: SDKMessage): string | undefined {
  if (message.type !== "stream_event") {
    return undefined;
  }

  const event = message.event as unknown as Record<string, unknown>;
  if (event.type !== "content_block_delta") {
    return undefined;
  }

  const delta = event.delta as Record<string, unknown> | undefined;
  if (delta?.type !== "text_delta" || typeof delta.text !== "string") {
    return undefined;
  }

  return delta.text;
}

function toClaudeFailureError(message: Extract<SDKMessage, { type: "result" }>): Error {
  if ("result" in message && typeof message.result === "string" && message.result.trim()) {
    return normalizeClaudeError(new Error(message.result.trim()));
  }

  return new Error(`Claude exited with ${message.subtype}.`);
}

function normalizeClaudeError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error("Unknown Claude error.");
  }

  const parsed = parseClaudeApiError(error.message);
  if (!parsed) {
    return error;
  }

  return new CloxyHttpError(parsed.message, parsed.statusCode, parsed.type);
}

function parseClaudeApiError(message: string): {
  message: string;
  statusCode: number;
  type: string;
} | null {
  const apiIndex = message.indexOf("API Error:");
  if (apiIndex === -1) {
    return null;
  }

  const apiSlice = message.slice(apiIndex);
  const statusMatch = /API Error:\s*(\d+)/.exec(apiSlice);
  if (!statusMatch) {
    return null;
  }

  const statusCode = Number(statusMatch[1]);
  let parsedMessage = message;
  let type = statusCode >= 500 ? "server_error" : "invalid_request_error";
  const jsonStart = apiSlice.indexOf("{");

  if (jsonStart !== -1) {
    try {
      const body = JSON.parse(apiSlice.slice(jsonStart)) as {
        error?: {
          message?: string;
          type?: string;
        };
      };
      if (body.error?.message) {
        parsedMessage = body.error.message;
      }
      if (body.error?.type) {
        type = body.error.type;
      }
    } catch {
      // Leave the original message if Claude returned a non-JSON API error body.
    }
  }

  return {
    message: parsedMessage,
    statusCode,
    type
  };
}
