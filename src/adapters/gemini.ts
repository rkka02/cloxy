import type { CloxyConfig } from "../config";
import { CloxyHttpError } from "../errors";
import { renderTranscript } from "../openai";
import type {
  BackendAdapter,
  CompletionParams,
  CompletionResult,
  StreamEvent
} from "./types";
import { spawnCli, waitForExit } from "./process";

interface GeminiJsonResult {
  session_id?: string;
  response?: string;
  error?: {
    type?: string;
    message?: string;
    code?: number;
  };
}

interface GeminiStreamEvent {
  type?: string;
  session_id?: string;
  role?: string;
  content?: string;
  status?: string;
  error?: {
    type?: string;
    message?: string;
    code?: number;
  };
}

export class GeminiAdapter implements BackendAdapter {
  readonly backend = "gemini" as const;
  readonly capabilities = {
    text: true,
    imageInput: false,
    sessionPersistence: true,
    tools: true,
    streaming: true
  } as const;

  constructor(private readonly config: CloxyConfig) {}

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const output = await runGeminiProcess(this.config, params, "json");
    if (output.error) {
      throw normalizeGeminiError(output.error);
    }

    return {
      backend: this.backend,
      text: output.text ?? "",
      sessionId: params.persistSession || params.sessionId ? output.sessionId : undefined
    };
  }

  async *stream(params: CompletionParams): AsyncGenerator<StreamEvent> {
    const output = await runGeminiProcess(this.config, params, "stream-json");
    if (output.error) {
      throw normalizeGeminiError(output.error);
    }

    if ((params.persistSession || params.sessionId) && output.sessionId) {
      yield {
        type: "session",
        sessionId: output.sessionId
      };
    }

    if (output.text) {
      yield {
        type: "delta",
        text: output.text
      };
    }

    yield {
      type: "done"
    };
  }
}

async function runGeminiProcess(
  config: CloxyConfig,
  params: CompletionParams,
  outputFormat: "json" | "stream-json"
): Promise<{
  text?: string;
  sessionId?: string;
  error?: GeminiJsonResult["error"];
}> {
  const prompt = renderTranscript(params.messages, {
    includeImagePlaceholders: false
  });

  const args = [
    "--approval-mode",
    "plan",
    "-o",
    outputFormat,
    "-p",
    prompt,
    ...(params.sessionId ? ["--resume", params.sessionId] : [])
  ];

  const child = spawnCli(config.geminiBinary, args, {
    cwd: params.cwd,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr!.on("data", (chunk) => {
    stderr += chunk;
  });

  const exitCode = await waitForExit(child, config.geminiTimeoutMs, "Gemini");
  if (exitCode !== 0) {
    throw normalizeGeminiError({
      type: "Error",
      message: [stderr.trim(), stdout.trim()].filter(Boolean).join("\n"),
      code: exitCode ?? 1
    });
  }

  return outputFormat === "json"
    ? parseGeminiJson(stdout, stderr)
    : parseGeminiStreamJson(stdout, stderr);
}

function parseGeminiJson(
  stdout: string,
  stderr: string
): {
  text?: string;
  sessionId?: string;
  error?: GeminiJsonResult["error"];
} {
  const jsonText = extractJsonObject(stdout);
  if (!jsonText) {
    throw new Error(
      `Gemini returned no JSON output.${stderr.trim() ? ` ${stderr.trim()}` : ""}`
    );
  }

  const parsed = JSON.parse(jsonText) as GeminiJsonResult;
  return {
    text: parsed.response ?? "",
    sessionId: parsed.session_id,
    error: parsed.error
  };
}

function parseGeminiStreamJson(
  stdout: string,
  stderr: string
): {
  text?: string;
  sessionId?: string;
  error?: GeminiJsonResult["error"];
} {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"));

  let sessionId: string | undefined;
  let text = "";
  let error: GeminiJsonResult["error"];

  for (const line of lines) {
    const parsed = JSON.parse(line) as GeminiStreamEvent;

    if (parsed.type === "init" && typeof parsed.session_id === "string") {
      sessionId = parsed.session_id;
      continue;
    }

    if (
      parsed.type === "message" &&
      parsed.role === "assistant" &&
      typeof parsed.content === "string"
    ) {
      text += parsed.content;
      continue;
    }

    if (parsed.type === "error" && parsed.error) {
      error = parsed.error;
      continue;
    }

    if (parsed.type === "result" && parsed.status && parsed.status !== "success") {
      error = {
        type: "Error",
        message: `Gemini returned status ${parsed.status}.`,
        code: 1
      };
    }
  }

  if (!sessionId && !text && !error && stderr.trim()) {
    throw new Error(stderr.trim());
  }

  return {
    text,
    sessionId,
    error
  };
}

function extractJsonObject(output: string): string | undefined {
  const firstBrace = output.indexOf("{");
  const lastBrace = output.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    return undefined;
  }

  return output.slice(firstBrace, lastBrace + 1);
}

function normalizeGeminiError(error: GeminiJsonResult["error"]): Error {
  const message = error?.message?.trim() || "Gemini request failed.";
  const lower = message.toLowerCase();

  if (lower.includes("resource_exhausted") || lower.includes("no capacity available")) {
    return new CloxyHttpError(message, 429, "rate_limit_exceeded");
  }

  if (lower.includes("unauth") || lower.includes("credentials")) {
    return new CloxyHttpError(message, 401, "authentication_error");
  }

  return new Error(message);
}
