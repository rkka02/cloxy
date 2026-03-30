import Fastify, { type FastifyReply } from "fastify";
import { z } from "zod";
import { ZodError } from "zod";
import { ClaudeAdapter } from "./adapters/claude";
import { CodexAdapter } from "./adapters/codex";
import type { BackendAdapter } from "./adapters/types";
import {
  loadConfig,
  resolveWorkingDirectory,
  type BackendName,
  type CloxyConfig
} from "./config";
import {
  createMessageId,
  createCompletionId,
  createResponseId,
  formatChatCompletion,
  formatResponseCompleted,
  formatResponseCreated,
  formatResponseObject,
  formatChatStreamChunk,
  hasImageParts,
  normalizeChatMessages,
  normalizeResponsesInput,
  nowSeconds,
  prependInstructions,
  toModelAlias
} from "./openai";
import { CloxyHttpError, isCloxyHttpError, UnsupportedFeatureError } from "./errors";

type SessionMode = "stateless" | "persist";

interface SessionRequest {
  mode: SessionMode;
  sessionId?: string;
}

const contentPartSchema = z.object({ type: z.string() }).passthrough();
const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(contentPartSchema)]),
  name: z.string().optional()
});

const chatCompletionSchema = z.object({
  model: z.string(),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().optional(),
  user: z.string().optional()
});

const responsesInputItemSchema = z.object({
  type: z.string().optional(),
  role: z.string().optional(),
  content: z.unknown().optional(),
  text: z.string().optional(),
  image_url: z.unknown().optional(),
  detail: z.unknown().optional()
});

const responsesSchema = z.object({
  model: z.string(),
  input: z.union([z.string(), z.array(responsesInputItemSchema)]),
  instructions: z.string().optional(),
  stream: z.boolean().optional()
});

const config = loadConfig();
const adapters = buildAdapters(config);

const server = Fastify({
  logger: true
});

server.addHook("onResponse", async (request, reply) => {
  request.log.info(
    {
      statusCode: reply.statusCode
    },
    "request completed"
  );
});

server.setErrorHandler((error, _request, reply) => {
  const payload = toErrorPayload(error);
  reply.status(payload.statusCode).send({
    error: {
      message: payload.message,
      type: payload.type
    }
  });
});

server.addHook("preHandler", async (request, reply) => {
  if (!config.apiKey) {
    return;
  }

  const header = request.headers.authorization;
  if (!header || header !== `Bearer ${config.apiKey}`) {
    reply.code(401);
    throw new Error("Unauthorized");
  }
});

server.get("/", async () => {
  return {
    name: "cloxy",
    object: "service",
    models: listModels(adapters),
    default_backend: config.defaultBackend
  };
});

server.get("/health", async () => {
  return {
    status: "ok",
    time: new Date().toISOString()
  };
});

server.get("/v1/models", async () => {
  return {
    object: "list",
    data: listModels(adapters)
  };
});

server.post("/v1/chat/completions", async (request, reply) => {
  const body = chatCompletionSchema.parse(request.body);
  const backend = resolveBackend(body.model, config.defaultBackend);
  const adapter = adapters[backend];
  const messages = normalizeChatMessages(body.messages);
  const session = parseSessionHeaders(request.headers);
  const workingDirectory = resolveWorkingDirectory(
    getHeaderValue(request.headers["x-cloxy-working-directory"]),
    config.allowedRoots
  );

  assertBackendCapabilities(adapter, messages, body.stream === true);

  if (body.stream) {
    const completionId = createCompletionId();
    let streamStarted = false;
    let responseSessionId = session.sessionId;

    const startChatStream = () => {
      if (streamStarted) {
        return;
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        ...buildSessionHeaders(session.mode, responseSessionId)
      });
      reply.raw.write(
        encodeSse(
          formatChatStreamChunk(completionId, body.model, {
            role: "assistant",
            cloxy: {
              session_mode: session.mode,
              ...(responseSessionId ? { session_id: responseSessionId } : {})
            }
          })
        )
      );
      streamStarted = true;
    };

    try {
      for await (const event of adapter.stream({
        messages,
        cwd: workingDirectory,
        persistSession: session.mode === "persist",
        sessionId: session.sessionId
      })) {
        if (event.type === "session" && event.sessionId) {
          responseSessionId = event.sessionId;
          continue;
        }

        startChatStream();

        if (event.type === "delta" && event.text) {
          reply.raw.write(
            encodeSse(
              formatChatStreamChunk(completionId, body.model, {
                content: event.text
              })
            )
          );
        }

        if (event.type === "done") {
          reply.raw.write(
            encodeSse(
              formatChatStreamChunk(completionId, body.model, {}, "stop")
            )
          );
          reply.raw.write("data: [DONE]\n\n");
        }
      }

      if (!streamStarted) {
        startChatStream();
      }
    } catch (error) {
      startChatStream();
      reply.raw.write(
        encodeSse({
          error: {
            message: toErrorPayload(error).message,
            type: toErrorPayload(error).type
          }
        })
      );
      reply.raw.write("data: [DONE]\n\n");
    } finally {
      reply.raw.end();
    }

    return reply;
  }

  const result = await adapter.complete({
    messages,
    cwd: workingDirectory,
    persistSession: session.mode === "persist",
    sessionId: session.sessionId
  });

  applySessionHeaders(reply, session.mode, result.sessionId);
  reply.code(200);
  return formatChatCompletion(body.model, result.text, {
    sessionMode: session.mode,
    sessionId: result.sessionId
  });
});

server.post("/v1/responses", async (request, reply) => {
  const body = responsesSchema.parse(request.body);
  const backend = resolveBackend(body.model, config.defaultBackend);
  const adapter = adapters[backend];
  const workingDirectory = resolveWorkingDirectory(
    getHeaderValue(request.headers["x-cloxy-working-directory"]),
    config.allowedRoots
  );
  const session = parseSessionHeaders(request.headers);
  const messages = prependInstructions(
    normalizeResponsesInput(body.input),
    body.instructions
  );

  assertBackendCapabilities(adapter, messages, body.stream === true);

  if (body.stream) {
    const responseId = createResponseId();
    const messageId = createMessageId();
    let fullText = "";
    let streamStarted = false;
    let responseSessionId = session.sessionId;

    const startResponsesStream = () => {
      if (streamStarted) {
        return;
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        ...buildSessionHeaders(session.mode, responseSessionId)
      });
      reply.raw.write(
        encodeSse({
          type: "response.created",
          response: formatResponseCreated(responseId, body.model, body.instructions, {
            sessionMode: session.mode,
            sessionId: responseSessionId
          })
        })
      );
      streamStarted = true;
    };

    try {
      for await (const event of adapter.stream({
        messages,
        cwd: workingDirectory,
        persistSession: session.mode === "persist",
        sessionId: session.sessionId
      })) {
        if (event.type === "session" && event.sessionId) {
          responseSessionId = event.sessionId;
          continue;
        }

        startResponsesStream();

        if (event.type === "delta" && event.text) {
          fullText += event.text;
          reply.raw.write(
            encodeSse({
              type: "response.output_text.delta",
              response_id: responseId,
              item_id: messageId,
              output_index: 0,
              content_index: 0,
              delta: event.text
            })
          );
        }

        if (event.type === "done") {
          reply.raw.write(
            encodeSse({
              type: "response.output_text.done",
              response_id: responseId,
              item_id: messageId,
              output_index: 0,
              content_index: 0,
              text: fullText
            })
          );
          reply.raw.write(
            encodeSse({
              type: "response.completed",
              response: formatResponseCompleted(
                responseId,
                messageId,
                body.model,
                fullText,
                body.instructions,
                {
                  sessionMode: session.mode,
                  sessionId: responseSessionId
                }
              )
            })
          );
          reply.raw.write("data: [DONE]\n\n");
        }
      }

      if (!streamStarted) {
        startResponsesStream();
      }
    } catch (error) {
      startResponsesStream();
      reply.raw.write(
        encodeSse({
          type: "error",
          error: {
            message: toErrorPayload(error).message,
            type: toErrorPayload(error).type
          }
        })
      );
      reply.raw.write("data: [DONE]\n\n");
    } finally {
      reply.raw.end();
    }

    return reply;
  }

  const result = await adapter.complete({
    messages,
    cwd: workingDirectory,
    persistSession: session.mode === "persist",
    sessionId: session.sessionId
  });

  applySessionHeaders(reply, session.mode, result.sessionId);
  reply.code(200);
  return formatResponseObject(body.model, result.text, body.instructions, {
    sessionMode: session.mode,
    sessionId: result.sessionId
  });
});

async function main(): Promise<void> {
  await server.listen({
    host: config.host,
    port: config.port
  });
  server.log.info(
    `Cloxy listening on http://${config.host}:${config.port} with default backend ${config.defaultBackend}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

function buildAdapters(config: CloxyConfig): Record<BackendName, BackendAdapter> {
  return {
    claude: new ClaudeAdapter(config),
    codex: new CodexAdapter(config)
  };
}

function listModels(adapters: Record<BackendName, BackendAdapter>): Array<Record<string, unknown>> {
  const created = nowSeconds();
  return [
    {
      id: "cloxy-claude",
      object: "model",
      created,
      owned_by: "cloxy",
      capabilities: adapters.claude.capabilities
    },
    {
      id: "cloxy-codex",
      object: "model",
      created,
      owned_by: "cloxy",
      capabilities: adapters.codex.capabilities
    }
  ];
}

function resolveBackend(input: string, fallback: BackendName): BackendName {
  const model = toModelAlias(input);
  if (model.includes("claude")) {
    return "claude";
  }
  if (model.includes("codex")) {
    return "codex";
  }
  return fallback;
}

function encodeSse(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function getHeaderValue(
  value: string | string[] | undefined
): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseSessionHeaders(
  headers: Record<string, string | string[] | undefined>
): SessionRequest {
  const rawMode = getHeaderValue(headers["x-cloxy-session-mode"]);
  const rawSessionId = getHeaderValue(headers["x-cloxy-session-id"]);

  if (rawMode && rawMode !== "stateless" && rawMode !== "persist") {
    throw new CloxyHttpError(
      "X-Cloxy-Session-Mode must be either 'stateless' or 'persist'.",
      400
    );
  }

  if (rawSessionId && !isUuid(rawSessionId)) {
    throw new CloxyHttpError("X-Cloxy-Session-Id must be a valid UUID.", 400);
  }

  if (rawMode === "stateless" && rawSessionId) {
    throw new CloxyHttpError(
      "X-Cloxy-Session-Id cannot be combined with X-Cloxy-Session-Mode: stateless.",
      400
    );
  }

  return {
    mode: rawMode === "persist" || rawSessionId ? "persist" : "stateless",
    sessionId: rawSessionId
  };
}

function applySessionHeaders(
  reply: FastifyReply,
  mode: SessionMode,
  sessionId?: string
): void {
  const headers = buildSessionHeaders(mode, sessionId);
  for (const [name, value] of Object.entries(headers)) {
    reply.raw.setHeader(name, value);
  }
}

function buildSessionHeaders(
  mode: SessionMode,
  sessionId?: string
): Record<string, string> {
  return {
    "X-Cloxy-Session-Mode": mode,
    ...(sessionId ? { "X-Cloxy-Session-Id": sessionId } : {})
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value
  );
}

function assertBackendCapabilities(
  adapter: BackendAdapter,
  messages: Parameters<typeof hasImageParts>[0],
  stream: boolean
): void {
  if (hasImageParts(messages) && !adapter.capabilities.imageInput) {
    throw new UnsupportedFeatureError(
      `cloxy-${adapter.backend} does not support image input yet.`
    );
  }

  if (stream && !adapter.capabilities.streaming) {
    throw new UnsupportedFeatureError(
      `cloxy-${adapter.backend} does not support streaming.`
    );
  }
}

function toErrorPayload(error: unknown): {
  message: string;
  statusCode: number;
  type: string;
} {
  if (isCloxyHttpError(error)) {
    return {
      message: error.message,
      statusCode: error.statusCode,
      type: error.type
    };
  }

  if (error instanceof ZodError) {
    const issue = error.issues[0];
    return {
      message: issue?.message ?? "Invalid request body.",
      statusCode: 400,
      type: "invalid_request_error"
    };
  }

  if (error instanceof CloxyHttpError) {
    return {
      message: error.message,
      statusCode: error.statusCode,
      type: error.type
    };
  }

  if (error instanceof Error) {
    const backendApiError = parseEmbeddedApiError(error.message);
    if (backendApiError) {
      return backendApiError;
    }

    return {
      message: error.message,
      statusCode: 500,
      type: "server_error"
    };
  }

  return {
    message: "Unknown error",
    statusCode: 500,
    type: "server_error"
  };
}

function parseEmbeddedApiError(message: string): {
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
      const parsed = JSON.parse(apiSlice.slice(jsonStart)) as {
        error?: {
          message?: string;
          type?: string;
        };
      };

      if (parsed.error?.message) {
        parsedMessage = parsed.error.message;
      }

      if (parsed.error?.type) {
        type = parsed.error.type;
      }
    } catch {
      // Ignore malformed embedded API payloads and keep the original message.
    }
  }

  return {
    message: parsedMessage,
    statusCode,
    type
  };
}
