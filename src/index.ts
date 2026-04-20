import Fastify, { type FastifyReply } from "fastify";
import path from "node:path";
import { z } from "zod";
import { ZodError } from "zod";
import { ClaudeAdapter } from "./adapters/claude";
import { CodexAdapter } from "./adapters/codex";
import { GeminiAdapter } from "./adapters/gemini";
import type {
  BackendAdapter,
  ClaudePermissionMode,
  CodexReasoningEffort,
  CodexSandboxMode,
  GeminiApprovalMode
} from "./adapters/types";
import {
  loadConfig,
  resolveWorkingDirectory,
  type AdvertisedModel,
  type BackendName,
  type CloxyConfig
} from "./config";
import {
  createMessageId,
  createCompletionId,
  createResponseId,
  formatChatCompletion,
  formatChatToolCompletion,
  formatResponseCompleted,
  formatResponseCreated,
  formatResponseObject,
  formatResponseToolObject,
  formatChatStreamChunk,
  hasImageParts,
  normalizeChatMessages,
  normalizeResponsesInput,
  normalizeTools,
  nowSeconds,
  parseToolPlannerResult,
  prependInstructions,
  renderToolPlanningPrompt,
  toModelAlias
} from "./openai";
import { CloxyHttpError, isCloxyHttpError, UnsupportedFeatureError } from "./errors";

type SessionMode = "stateless" | "persist";

interface SessionRequest {
  mode: SessionMode;
  sessionId?: string;
}

interface ResolvedModel {
  backend: BackendName;
  backendModel?: string;
}

interface CodexModelSelection {
  model?: string;
  reasoningEffort?: string;
}

const backendSchema = z.enum(["claude", "codex", "gemini"]);
const contentPartSchema = z.object({ type: z.string() }).passthrough();
const envSchema = z.record(z.string(), z.string());
const streamOptionsSchema = z.object({
  include_usage: z.boolean().optional()
});
const workspacePermissionsSchema = z.object({
  read: z.boolean().optional(),
  write: z.boolean().optional(),
  execute: z.boolean().optional()
});
const workspaceSchema = z.object({
  rootDir: z.string().optional(),
  cwd: z.string().optional(),
  permissionMode: z.string().optional(),
  permissions: workspacePermissionsSchema.optional(),
  env: envSchema.optional(),
  additional_directories: z.array(z.string()).optional()
});
const reasoningSchema = z.object({
  effort: z.string().optional()
});
const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(contentPartSchema), z.null()]),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string().optional(),
        type: z.string().optional(),
        function: z
          .object({
            name: z.string().optional(),
            arguments: z.string().optional()
          })
          .optional()
      })
    )
    .optional()
});

const chatCompletionSchema = z.object({
  model: z.string(),
  backend: backendSchema.optional(),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().optional(),
  stream_options: streamOptionsSchema.optional(),
  user: z.string().optional(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  workspace: workspaceSchema.optional(),
  cwd: z.string().optional(),
  workspace_root: z.string().optional(),
  env: envSchema.optional(),
  additional_directories: z.array(z.string()).optional(),
  codex_search: z.boolean().optional(),
  codex_fast_mode: z.boolean().optional(),
  max_turns: z.number().int().positive().optional(),
  permission_mode: z.string().optional(),
  reasoning: reasoningSchema.optional(),
  reasoning_effort: z.string().optional(),
  permissions: workspacePermissionsSchema.optional(),
  dangerously_skip_permissions: z.boolean().optional()
});

const responsesInputItemSchema = z.object({
  type: z.string().optional(),
  role: z.string().optional(),
  content: z.unknown().optional(),
  text: z.string().optional(),
  image_url: z.unknown().optional(),
  detail: z.unknown().optional(),
  call_id: z.unknown().optional(),
  name: z.unknown().optional(),
  arguments: z.unknown().optional(),
  output: z.unknown().optional()
});

const responsesSchema = z.object({
  model: z.string(),
  backend: backendSchema.optional(),
  input: z.union([z.string(), z.array(responsesInputItemSchema)]),
  instructions: z.string().optional(),
  stream: z.boolean().optional(),
  stream_options: streamOptionsSchema.optional(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  workspace: workspaceSchema.optional(),
  cwd: z.string().optional(),
  workspace_root: z.string().optional(),
  env: envSchema.optional(),
  additional_directories: z.array(z.string()).optional(),
  codex_search: z.boolean().optional(),
  codex_fast_mode: z.boolean().optional(),
  max_turns: z.number().int().positive().optional(),
  permission_mode: z.string().optional(),
  reasoning: reasoningSchema.optional(),
  reasoning_effort: z.string().optional(),
  permissions: workspacePermissionsSchema.optional(),
  dangerously_skip_permissions: z.boolean().optional()
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
    models: listModels(config.models, adapters),
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
    data: listModels(config.models, adapters)
  };
});

server.post("/v1/chat/completions", async (request, reply) => {
  const body = chatCompletionSchema.parse(request.body);
  const resolvedModel = resolveRequestedModel(body.model, config, body.backend);
  const adapter = adapters[resolvedModel.backend];
  const messages = normalizeChatMessages(body.messages);
  const toolConfig = normalizeTools(body.tools, body.tool_choice);
  const session = parseSessionHeaders(request.headers);
  const codexSelection = resolveRequestedCodexModelSelection(request.headers);
  const requestWorkspaceRoot = getRequestedWorkspaceRoot(body);
  const workingDirectory = resolveWorkingDirectory(
    getRequestedWorkingDirectory(request.headers, body),
    mergeAllowedRoots(config.allowedRoots, requestWorkspaceRoot)
  );
  const codexSandbox = resolveRequestedCodexSandbox(body, config.codexSandbox);
  const claudePermissionMode = resolveRequestedClaudePermissionMode(body, config.claudePermissionMode);
  const geminiApprovalMode = resolveRequestedGeminiApprovalMode(body);
  const requestedModel = resolveRequestedExecutionModel(
    resolvedModel,
    codexSelection.model
  );
  const reasoningEffort = resolveRequestedReasoningEffort(
    resolveRequestedCodexReasoningEffort(body),
    codexSelection.reasoningEffort
  );
  const requestedEnv = resolveRequestedEnv(body);
  const additionalDirectories = resolveRequestedAdditionalDirectories(body);
  const includeUsage = body.stream_options?.include_usage === true;

  assertBackendCapabilities(adapter, messages, body.stream === true);

  if (body.stream) {
    const completionId = createCompletionId();
    let responseSessionId = session.sessionId;

    reply.hijack();
    try {
      if (toolConfig.tools.length) {
        const result = await adapter.complete({
          messages: buildBackendMessages(messages, toolConfig, adapter.backend),
          cwd: workingDirectory,
          model: requestedModel,
          reasoningEffort,
          maxTurns: body.max_turns,
          env: requestedEnv,
          additionalDirectories,
          codexSearch: body.codex_search,
          codexFastMode: body.codex_fast_mode,
          codexSandbox,
          claudePermissionMode,
          geminiApprovalMode,
          persistSession: session.mode === "persist",
          sessionId: session.sessionId
        });
        responseSessionId = result.sessionId ?? responseSessionId;

        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          ...buildUsagePolicyHeaders(adapter),
          ...buildSessionHeaders(session.mode, responseSessionId)
        });
        reply.raw.write(
          encodeSse(
            formatChatStreamChunk(
              completionId,
              body.model,
              { role: "assistant" },
              null,
              {
                sessionMode: session.mode,
                sessionId: responseSessionId
              }
            )
          )
        );

        const toolResult = parseToolPlannerResult(result.text, {
          toolChoice: toolConfig.toolChoice,
          tools: toolConfig.tools
        });

        if (toolResult.type === "tool_calls") {
          toolResult.toolCalls.forEach((toolCall, index) => {
            reply.raw.write(
              encodeSse(
                formatChatStreamChunk(completionId, body.model, {
                  tool_calls: [
                    {
                      index,
                      id: toolCall.id,
                      type: "function",
                      function: {
                        name: toolCall.function.name,
                        arguments: toolCall.function.arguments
                      }
                    }
                  ]
                })
              )
            );
          });
          reply.raw.write(
            encodeSse(
              formatChatStreamChunk(completionId, body.model, {}, "tool_calls", {
                sessionMode: session.mode,
                sessionId: responseSessionId,
                usage: includeUsage ? result.usage : undefined
              })
            )
          );
        } else {
          reply.raw.write(
            encodeSse(
              formatChatStreamChunk(completionId, body.model, {
                content: toolResult.content
              })
            )
          );
          reply.raw.write(
            encodeSse(
              formatChatStreamChunk(completionId, body.model, {}, "stop", {
                sessionMode: session.mode,
                sessionId: responseSessionId,
                usage: includeUsage ? result.usage : undefined
              })
            )
          );
        }

        reply.raw.write("data: [DONE]\n\n");
        return reply;
      }

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        ...buildUsagePolicyHeaders(adapter),
        ...buildSessionHeaders(session.mode, responseSessionId)
      });
      reply.raw.write(
        encodeSse(
          formatChatStreamChunk(
            completionId,
            body.model,
            { role: "assistant" },
            null,
            {
              sessionMode: session.mode,
              sessionId: responseSessionId
            }
          )
        )
      );

      for await (const event of adapter.stream({
        messages,
        cwd: workingDirectory,
        model: requestedModel,
        reasoningEffort,
        maxTurns: body.max_turns,
        env: requestedEnv,
        additionalDirectories,
        codexSearch: body.codex_search,
        codexFastMode: body.codex_fast_mode,
        codexSandbox,
        claudePermissionMode,
        geminiApprovalMode,
        persistSession: session.mode === "persist",
        sessionId: session.sessionId
      })) {
        if (event.type === "session" && event.sessionId) {
          responseSessionId = event.sessionId;
          continue;
        }

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
              formatChatStreamChunk(completionId, body.model, {}, "stop", {
                sessionMode: session.mode,
                sessionId: responseSessionId,
                usage: includeUsage ? event.usage : undefined
              })
            )
          );
          reply.raw.write("data: [DONE]\n\n");
        }
      }
    } catch (error) {
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
    messages: buildBackendMessages(messages, toolConfig, adapter.backend),
    cwd: workingDirectory,
    model: requestedModel,
    reasoningEffort,
    maxTurns: body.max_turns,
    env: requestedEnv,
    additionalDirectories,
    codexSearch: body.codex_search,
    codexFastMode: body.codex_fast_mode,
    codexSandbox,
    claudePermissionMode,
    geminiApprovalMode,
    persistSession: session.mode === "persist",
    sessionId: session.sessionId
  });

  applyUsagePolicyHeaders(reply, adapter);
  applySessionHeaders(reply, session.mode, result.sessionId);
  reply.code(200);

  if (toolConfig.tools.length) {
    const toolResult = parseToolPlannerResult(result.text, {
      toolChoice: toolConfig.toolChoice,
      tools: toolConfig.tools
    });

    if (toolResult.type === "tool_calls") {
      return formatChatToolCompletion(body.model, toolResult.toolCalls, {
        sessionMode: session.mode,
        sessionId: result.sessionId,
        usage: result.usage
      });
    }

    return formatChatCompletion(body.model, toolResult.content, {
      sessionMode: session.mode,
      sessionId: result.sessionId,
      usage: result.usage
    });
  }

  return formatChatCompletion(body.model, result.text, {
    sessionMode: session.mode,
    sessionId: result.sessionId,
    usage: result.usage
  });
});

server.post("/v1/responses", async (request, reply) => {
  const body = responsesSchema.parse(request.body);
  const resolvedModel = resolveRequestedModel(body.model, config, body.backend);
  const adapter = adapters[resolvedModel.backend];
  const requestWorkspaceRoot = getRequestedWorkspaceRoot(body);
  const workingDirectory = resolveWorkingDirectory(
    getRequestedWorkingDirectory(request.headers, body),
    mergeAllowedRoots(config.allowedRoots, requestWorkspaceRoot)
  );
  const session = parseSessionHeaders(request.headers);
  const codexSelection = resolveRequestedCodexModelSelection(request.headers);
  const toolConfig = normalizeTools(body.tools, body.tool_choice);
  const codexSandbox = resolveRequestedCodexSandbox(body, config.codexSandbox);
  const claudePermissionMode = resolveRequestedClaudePermissionMode(body, config.claudePermissionMode);
  const geminiApprovalMode = resolveRequestedGeminiApprovalMode(body);
  const requestedModel = resolveRequestedExecutionModel(
    resolvedModel,
    codexSelection.model
  );
  const reasoningEffort = resolveRequestedReasoningEffort(
    resolveRequestedCodexReasoningEffort(body),
    codexSelection.reasoningEffort
  );
  const requestedEnv = resolveRequestedEnv(body);
  const additionalDirectories = resolveRequestedAdditionalDirectories(body);
  const messages = prependInstructions(
    normalizeResponsesInput(body.input),
    body.instructions
  );

  assertBackendCapabilities(adapter, messages, body.stream === true);

  if (body.stream) {
    const responseId = createResponseId();
    const messageId = createMessageId();
    let responseSessionId = session.sessionId;
    reply.hijack();

    try {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        ...buildUsagePolicyHeaders(adapter),
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

      if (toolConfig.tools.length) {
        const result = await adapter.complete({
          messages: buildBackendMessages(messages, toolConfig, adapter.backend),
          cwd: workingDirectory,
          model: requestedModel,
          reasoningEffort,
          maxTurns: body.max_turns,
          env: requestedEnv,
          additionalDirectories,
          codexSearch: body.codex_search,
          codexFastMode: body.codex_fast_mode,
          codexSandbox,
          claudePermissionMode,
          geminiApprovalMode,
          persistSession: session.mode === "persist",
          sessionId: session.sessionId
        });
        responseSessionId = result.sessionId ?? responseSessionId;

        const toolResult = parseToolPlannerResult(result.text, {
          toolChoice: toolConfig.toolChoice,
          tools: toolConfig.tools
        });

        if (toolResult.type === "tool_calls") {
          toolResult.toolCalls.forEach((toolCall, outputIndex) => {
            const item = {
              id: createMessageId(),
              type: "function_call",
              status: "completed",
              call_id: toolCall.id,
              name: toolCall.function.name,
              arguments: toolCall.function.arguments
            };

            reply.raw.write(
              encodeSse({
                type: "response.output_item.added",
                response_id: responseId,
                output_index: outputIndex,
                item
              })
            );
            reply.raw.write(
              encodeSse({
                type: "response.function_call_arguments.done",
                response_id: responseId,
                output_index: outputIndex,
                item_id: item.id,
                call_id: toolCall.id,
                name: toolCall.function.name,
                arguments: toolCall.function.arguments
              })
            );
            reply.raw.write(
              encodeSse({
                type: "response.output_item.done",
                response_id: responseId,
                output_index: outputIndex,
                item
              })
            );
          });

          reply.raw.write(
            encodeSse({
              type: "response.completed",
              response: formatResponseToolObject(
                body.model,
                toolResult.toolCalls,
                body.instructions,
                {
                  sessionMode: session.mode,
                  sessionId: responseSessionId,
                  usage: result.usage
                }
              )
            })
          );
          reply.raw.write("data: [DONE]\n\n");
          return reply;
        }

        reply.raw.write(
          encodeSse({
            type: "response.output_text.done",
            response_id: responseId,
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            text: toolResult.content
          })
        );
        reply.raw.write(
          encodeSse({
            type: "response.completed",
            response: formatResponseObject(body.model, toolResult.content, body.instructions, {
              sessionMode: session.mode,
              sessionId: responseSessionId,
              usage: result.usage
            })
          })
        );
        reply.raw.write("data: [DONE]\n\n");
        return reply;
      }

      let fullText = "";
      for await (const event of adapter.stream({
        messages,
        cwd: workingDirectory,
        model: requestedModel,
        reasoningEffort,
        maxTurns: body.max_turns,
        env: requestedEnv,
        additionalDirectories,
        codexSearch: body.codex_search,
        codexFastMode: body.codex_fast_mode,
        codexSandbox,
        claudePermissionMode,
        geminiApprovalMode,
        persistSession: session.mode === "persist",
        sessionId: session.sessionId
      })) {
        if (event.type === "session" && event.sessionId) {
          responseSessionId = event.sessionId;
          continue;
        }

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
                  sessionId: responseSessionId,
                  usage: event.usage
                }
              )
            })
          );
          reply.raw.write("data: [DONE]\n\n");
        }
      }
    } catch (error) {
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
    messages: buildBackendMessages(messages, toolConfig, adapter.backend),
    cwd: workingDirectory,
    model: requestedModel,
    reasoningEffort,
    maxTurns: body.max_turns,
    env: requestedEnv,
    additionalDirectories,
    codexSearch: body.codex_search,
    codexFastMode: body.codex_fast_mode,
    codexSandbox,
    claudePermissionMode,
    geminiApprovalMode,
    persistSession: session.mode === "persist",
    sessionId: session.sessionId
  });

  applyUsagePolicyHeaders(reply, adapter);
  applySessionHeaders(reply, session.mode, result.sessionId);
  reply.code(200);

  if (toolConfig.tools.length) {
    const toolResult = parseToolPlannerResult(result.text, {
      toolChoice: toolConfig.toolChoice,
      tools: toolConfig.tools
    });

    if (toolResult.type === "tool_calls") {
      return formatResponseToolObject(body.model, toolResult.toolCalls, body.instructions, {
        sessionMode: session.mode,
        sessionId: result.sessionId,
        usage: result.usage
      });
    }

    return formatResponseObject(body.model, toolResult.content, body.instructions, {
      sessionMode: session.mode,
      sessionId: result.sessionId,
      usage: result.usage
    });
  }

  return formatResponseObject(body.model, result.text, body.instructions, {
    sessionMode: session.mode,
    sessionId: result.sessionId,
    usage: result.usage
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
    codex: new CodexAdapter(config),
    gemini: new GeminiAdapter(config)
  };
}

function listModels(
  models: AdvertisedModel[],
  adapters: Record<BackendName, BackendAdapter>
): Array<Record<string, unknown>> {
  const created = nowSeconds();
  return models.map((model) => ({
    id: model.id,
    object: "model",
    created,
    owned_by: "cloxy",
    backend: model.backend,
    ...(model.backendModel ? { backend_model: model.backendModel } : {}),
    usage_policy: adapters[model.backend].usagePolicy,
    capabilities: adapters[model.backend].capabilities
  }));
}

function resolveRequestedModel(
  input: string,
  config: CloxyConfig,
  explicit?: BackendName
): ResolvedModel {
  const requestedId = input.trim();
  const advertised = config.models.find(
    (candidate) =>
      candidate.id === requestedId &&
      (!explicit || candidate.backend === explicit)
  );
  if (advertised) {
    return {
      backend: advertised.backend,
      backendModel: advertised.backendModel
    };
  }

  const backend = resolveBackend(requestedId, config.defaultBackend, explicit);
  return {
    backend,
    backendModel: normalizeRequestedModel(requestedId, backend)
  };
}

function resolveBackend(
  input: string,
  fallback: BackendName,
  explicit?: BackendName
): BackendName {
  if (explicit) {
    return explicit;
  }

  const model = toModelAlias(input);
  if (model.includes("claude")) {
    return "claude";
  }

  if (model === "sonnet" || model === "opus" || model === "haiku") {
    return "claude";
  }
  if (model.includes("codex") || model.includes("gpt") || /^o[1-9]/.test(model)) {
    return "codex";
  }
  if (model.includes("gemini")) {
    return "gemini";
  }
  return fallback;
}

function resolveRequestedExecutionModel(
  resolvedModel: ResolvedModel,
  codexOverride?: string
): string | undefined {
  if (resolvedModel.backend === "codex" && codexOverride?.trim()) {
    return normalizeRequestedModel(codexOverride, resolvedModel.backend);
  }

  return resolvedModel.backendModel;
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

  if (rawMode === "stateless" && rawSessionId) {
    throw new CloxyHttpError(
      "X-Cloxy-Session-Id cannot be combined with X-Cloxy-Session-Mode: stateless.",
      400
    );
  }

  if (rawSessionId !== undefined && !rawSessionId.trim()) {
    throw new CloxyHttpError("X-Cloxy-Session-Id cannot be empty.", 400);
  }

  return {
    mode: rawMode === "persist" || rawSessionId ? "persist" : "stateless",
    sessionId: rawSessionId?.trim()
  };
}

function resolveRequestedCodexModelSelection(
  headers: Record<string, string | string[] | undefined>
): CodexModelSelection {
  const model = getHeaderValue(headers["x-cloxy-codex-model"])?.trim();
  const reasoningEffortRaw = getHeaderValue(
    headers["x-cloxy-codex-reasoning-effort"]
  )?.trim();
  const reasoningEffort = reasoningEffortRaw?.toLowerCase();

  if (
    reasoningEffort &&
    reasoningEffort !== "low" &&
    reasoningEffort !== "medium" &&
    reasoningEffort !== "high" &&
    reasoningEffort !== "xhigh"
  ) {
    throw new CloxyHttpError(
      "X-Cloxy-Codex-Reasoning-Effort must be one of low, medium, high, xhigh.",
      400
    );
  }

  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {})
  };
}

function resolveRequestedReasoningEffort(
  inlineValue?: string,
  headerValue?: string
): string | undefined {
  const clean = (headerValue || inlineValue)?.trim().toLowerCase();
  if (!clean) {
    return undefined;
  }

  if (clean !== "low" && clean !== "medium" && clean !== "high" && clean !== "xhigh") {
    throw new CloxyHttpError(
      "reasoning_effort must be one of low, medium, high, xhigh.",
      400
    );
  }

  return clean;
}

function resolveRequestedEnv(body: {
  env?: Record<string, string>;
  workspace?: {
    env?: Record<string, string>;
  };
}): Record<string, string> | undefined {
  const merged = {
    ...(body.workspace?.env || {}),
    ...(body.env || {})
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function resolveRequestedAdditionalDirectories(body: {
  additional_directories?: string[];
  workspace?: {
    additional_directories?: string[];
  };
}): string[] | undefined {
  const merged = [
    ...(body.workspace?.additional_directories || []),
    ...(body.additional_directories || [])
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  return merged.length > 0 ? [...new Set(merged)] : undefined;
}

function normalizeRequestedModel(
  model: string | undefined,
  backend: BackendName
): string | undefined {
  const clean = model?.trim();
  if (!clean) {
    return undefined;
  }

  const normalized = clean.toLowerCase();
  if (normalized === backend || normalized === `cloxy-${backend}`) {
    return undefined;
  }

  return clean;
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

function applyUsagePolicyHeaders(
  reply: FastifyReply,
  adapter: BackendAdapter
): void {
  const headers = buildUsagePolicyHeaders(adapter);
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

function buildUsagePolicyHeaders(adapter: BackendAdapter): Record<string, string> {
  return {
    "X-Cloxy-Usage-Policy": adapter.usagePolicy
  };
}

function buildBackendMessages(
  messages: ReturnType<typeof normalizeChatMessages>,
  toolConfig: ReturnType<typeof normalizeTools>,
  backend: BackendName
) {
  if (toolConfig.tools.length === 0) {
    return messages;
  }

  return [
    {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: renderToolPlanningPrompt({
            messages,
            tools: toolConfig.tools,
            toolChoice: toolConfig.toolChoice,
            includeImagePlaceholders: backend !== "claude"
          })
        }
      ]
    }
  ];
}

function getRequestedWorkingDirectory(
  headers: Record<string, string | string[] | undefined>,
  body: {
    cwd?: string;
    workspace_root?: string;
    workspace?: {
      cwd?: string;
      rootDir?: string;
    };
  }
): string | undefined {
  return firstNonEmptyString(
    getHeaderValue(headers["x-cloxy-working-directory"]),
    body.cwd,
    body.workspace?.cwd,
    body.workspace_root,
    body.workspace?.rootDir
  );
}

function getRequestedWorkspaceRoot(body: {
  workspace_root?: string;
  cwd?: string;
  workspace?: {
    rootDir?: string;
    cwd?: string;
  };
}): string | undefined {
  return firstNonEmptyString(
    body.workspace_root,
    body.workspace?.rootDir,
    body.cwd,
    body.workspace?.cwd
  );
}

function mergeAllowedRoots(allowedRoots: string[], requestRoot?: string): string[] {
  if (!requestRoot) {
    return allowedRoots;
  }

  return [...new Set([...allowedRoots, path.resolve(requestRoot)])];
}

function resolveRequestedCodexSandbox(
  body: {
    workspace?: {
      permissionMode?: string;
      permissions?: {
        write?: boolean;
      };
    };
    permission_mode?: string;
    permissions?: {
      write?: boolean;
    };
    dangerously_skip_permissions?: boolean;
  },
  fallback: string
): CodexSandboxMode {
  const requestedPermissionMode = firstNonEmptyString(
    body.permission_mode,
    body.workspace?.permissionMode
  );
  const writeEnabled = body.permissions?.write ?? body.workspace?.permissions?.write;

  if (
    body.dangerously_skip_permissions === true ||
    requestedPermissionMode === "dangerously-skip-permissions"
  ) {
    return "danger-full-access";
  }

  if (writeEnabled === true) {
    return "workspace-write";
  }

  if (
    fallback === "read-only" ||
    fallback === "workspace-write" ||
    fallback === "danger-full-access"
  ) {
    return fallback;
  }

  return "read-only";
}

function resolveRequestedCodexReasoningEffort(
  body: {
    reasoning?: {
      effort?: string;
    };
    reasoning_effort?: string;
  }
): CodexReasoningEffort | undefined {
  const requestedEffort = firstNonEmptyString(
    body.reasoning?.effort,
    body.reasoning_effort
  );

  if (
    requestedEffort === "low" ||
    requestedEffort === "medium" ||
    requestedEffort === "high" ||
    requestedEffort === "xhigh"
  ) {
    return requestedEffort;
  }

  return undefined;
}

function resolveRequestedClaudePermissionMode(
  body: {
    workspace?: {
      permissionMode?: string;
      permissions?: {
        write?: boolean;
        execute?: boolean;
      };
    };
    permission_mode?: string;
    permissions?: {
      write?: boolean;
      execute?: boolean;
    };
    dangerously_skip_permissions?: boolean;
  },
  fallback: string
): ClaudePermissionMode {
  const requestedPermissionMode = firstNonEmptyString(
    body.permission_mode,
    body.workspace?.permissionMode
  );
  const writeEnabled = body.permissions?.write ?? body.workspace?.permissions?.write;
  const executeEnabled = body.permissions?.execute ?? body.workspace?.permissions?.execute;

  if (
    body.dangerously_skip_permissions === true ||
    requestedPermissionMode === "dangerously-skip-permissions"
  ) {
    return "bypassPermissions";
  }

  if (writeEnabled === true || executeEnabled === true) {
    return "acceptEdits";
  }

  if (
    fallback === "default" ||
    fallback === "acceptEdits" ||
    fallback === "bypassPermissions" ||
    fallback === "plan" ||
    fallback === "dontAsk"
  ) {
    return fallback;
  }

  return "plan";
}

function resolveRequestedGeminiApprovalMode(
  body: {
    workspace?: {
      permissionMode?: string;
      permissions?: {
        write?: boolean;
      };
    };
    permission_mode?: string;
    permissions?: {
      write?: boolean;
    };
    dangerously_skip_permissions?: boolean;
  }
): GeminiApprovalMode {
  const requestedPermissionMode = firstNonEmptyString(
    body.permission_mode,
    body.workspace?.permissionMode
  );
  const writeEnabled = body.permissions?.write ?? body.workspace?.permissions?.write;

  if (
    body.dangerously_skip_permissions === true ||
    requestedPermissionMode === "dangerously-skip-permissions"
  ) {
    return "yolo";
  }

  if (
    writeEnabled === true ||
    requestedPermissionMode === "auto_edit" ||
    requestedPermissionMode === "acceptEdits"
  ) {
    return "auto_edit";
  }

  if (requestedPermissionMode === "plan") {
    return "plan";
  }

  return "default";
}

function firstNonEmptyString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return undefined;
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
