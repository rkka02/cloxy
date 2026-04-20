import type { CloxyConfig } from "../config";
import { CloxyHttpError } from "../errors";
import { renderTranscript } from "../openai";
import type {
  BackendAdapter,
  CompletionParams,
  CompletionResult,
  GeminiApprovalMode,
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
  readonly usagePolicy = "general" as const;
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
  const selectedModel = params.model ?? config.geminiDefaultModel;
  const fallbackModel =
    config.geminiFallbackModel &&
    config.geminiFallbackModel !== selectedModel &&
    selectedModel === config.geminiDefaultModel
      ? config.geminiFallbackModel
      : undefined;

  try {
    const output = await runGeminiAttempt(config, params, outputFormat, selectedModel);
    if (output.error && fallbackModel && isGeminiQuotaError(output.error)) {
      return runGeminiAttempt(config, params, outputFormat, fallbackModel);
    }

    return output;
  } catch (error) {
    if (fallbackModel && isGeminiQuotaError(error)) {
      return runGeminiAttempt(config, params, outputFormat, fallbackModel);
    }

    throw error;
  }
}

async function runGeminiAttempt(
  config: CloxyConfig,
  params: CompletionParams,
  outputFormat: "json" | "stream-json",
  model: string
): Promise<{
  text?: string;
  sessionId?: string;
  error?: GeminiJsonResult["error"];
}> {
  const prompt = renderTranscript(params.messages, {
    includeImagePlaceholders: false
  });
  const approvalMode = params.geminiApprovalMode ?? "plan";
  const modelArgs = buildGeminiModelArgs(model);

  const args = [
    "--approval-mode",
    approvalMode,
    ...modelArgs,
    "-o",
    outputFormat,
    "-p",
    prompt,
    ...(params.sessionId ? ["--resume", params.sessionId] : [])
  ];

  const child = spawnCli(config.geminiBinary, args, {
    cwd: params.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(params.env || {})
    }
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

function buildGeminiModelArgs(model: string | undefined): string[] {
  const cleanModel = model?.trim();
  if (!cleanModel) {
    return [];
  }

  const normalized = cleanModel.toLowerCase();
  if (normalized === "gemini" || normalized === "cloxy-gemini") {
    return [];
  }

  return ["-m", cleanModel];
}

function normalizeRequestedModel(model: string | undefined, backend: string): string | undefined {
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

function normalizeGeminiError(error: GeminiJsonResult["error"]): Error {
  const message = error?.message?.trim() || "Gemini request failed.";
  const lower = message.toLowerCase();

  if (isGeminiQuotaLikeMessage(lower)) {
    return new CloxyHttpError(message, 429, "rate_limit_exceeded");
  }

  if (lower.includes("unauth") || lower.includes("credentials")) {
    return new CloxyHttpError(message, 401, "authentication_error");
  }

  return new Error(message);
}

function isGeminiQuotaError(error: unknown): boolean {
  if (error instanceof CloxyHttpError) {
    return error.statusCode === 429;
  }

  if (error instanceof Error) {
    return isGeminiQuotaLikeMessage(error.message.toLowerCase());
  }

  if (error && typeof error === "object") {
    const message =
      "message" in error && typeof error.message === "string"
        ? error.message
        : "";
    return isGeminiQuotaLikeMessage(message.toLowerCase());
  }

  return false;
}

function isGeminiQuotaLikeMessage(message: string): boolean {
  return (
    message.includes("resource_exhausted") ||
    message.includes("no capacity available") ||
    message.includes("quota") ||
    message.includes("rate limit")
  );
}
