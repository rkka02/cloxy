import Fastify from "fastify";
import { z } from "zod";
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
  createCompletionId,
  formatChatCompletion,
  formatChatStreamChunk,
  nowSeconds,
  renderTranscript,
  toModelAlias
} from "./openai";

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([
    z.string(),
    z.array(
      z.object({
        type: z.string(),
        text: z.string().optional()
      })
    )
  ]),
  name: z.string().optional()
});

const chatCompletionSchema = z.object({
  model: z.string(),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().optional(),
  user: z.string().optional()
});

const config = loadConfig();
const adapters = buildAdapters(config);

const server = Fastify({
  logger: true
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
    models: listModels(),
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
    data: listModels()
  };
});

server.post("/v1/chat/completions", async (request, reply) => {
  const body = chatCompletionSchema.parse(request.body);
  const backend = resolveBackend(body.model, config.defaultBackend);
  const adapter = adapters[backend];
  const workingDirectory = resolveWorkingDirectory(
    getHeaderValue(request.headers["x-cloxy-working-directory"]),
    config.allowedRoots
  );
  const prompt = renderTranscript(body.messages);

  if (body.stream) {
    const completionId = createCompletionId();
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    reply.raw.write(
      encodeSse(
        formatChatStreamChunk(completionId, body.model, {
          role: "assistant"
        })
      )
    );

    try {
      for await (const event of adapter.stream({
        prompt,
        cwd: workingDirectory
      })) {
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
    } catch (error) {
      reply.raw.write(
        encodeSse({
          error: {
            message: toErrorMessage(error),
            type: "server_error"
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
    prompt,
    cwd: workingDirectory
  });

  reply.code(200);
  return formatChatCompletion(body.model, result.text);
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

function listModels(): Array<Record<string, unknown>> {
  const created = nowSeconds();
  return [
    {
      id: "cloxy-claude",
      object: "model",
      created,
      owned_by: "cloxy"
    },
    {
      id: "cloxy-codex",
      object: "model",
      created,
      owned_by: "cloxy"
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}
