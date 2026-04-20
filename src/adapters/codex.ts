import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CloxyConfig } from "../config";
import { renderTranscript } from "../openai";
import type {
  BackendAdapter,
  CompletionUsage,
  CodexSandboxMode,
  CompletionParams,
  CompletionResult,
  StreamEvent
} from "./types";
import { spawnCli, waitForExit } from "./process";

interface CodexParsedOutput {
  text?: string;
  sessionId?: string;
  usage?: CompletionUsage;
}

export class CodexAdapter implements BackendAdapter {
  readonly backend = "codex" as const;
  readonly usagePolicy = "general" as const;
  readonly capabilities = {
    text: true,
    imageInput: true,
    sessionPersistence: true,
    tools: true,
    streaming: true
  } as const;

  constructor(private readonly config: CloxyConfig) {}

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const output = await runCodexProcess(this.config, params);
    if (!output.text?.trim()) {
      throw new Error("Codex returned an empty result.");
    }

    return {
      backend: this.backend,
      text: output.text.trim(),
      sessionId: output.sessionId,
      usage: output.usage
    };
  }

  async *stream(params: CompletionParams): AsyncGenerator<StreamEvent> {
    const output = await runCodexProcess(this.config, params);

    if (output.sessionId) {
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
      type: "done",
      usage: output.usage
    };
  }
}

async function runCodexProcess(
  config: CloxyConfig,
  params: CompletionParams
): Promise<CodexParsedOutput> {
  const imageTempDir = await createImageTempDir(params);
  const sandbox = params.codexSandbox ?? (config.codexSandbox as CodexSandboxMode);
  const args = buildCodexArgs(params, sandbox, imageTempDir.args);

  const child = spawnCli(config.codexBinary, args, {
    cwd: params.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(params.env || {})
    }
  });

  let stdout = "";
  let stderr = "";

  try {
    child.stdin!.end(
      renderTranscript(params.messages, {
        includeImagePlaceholders: true
      })
    );
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr!.on("data", (chunk) => {
      stderr += chunk;
    });

    const exitCode = await waitForExit(child, config.codexTimeoutMs, "Codex");
    if (exitCode !== 0) {
      throw new Error(`Codex exited with code ${exitCode}: ${stderr.trim()}`);
    }

    return parseCodexJsonl(stdout);
  } finally {
    if (imageTempDir.path) {
      await rm(imageTempDir.path, { recursive: true, force: true });
    }
  }
}

async function createImageTempDir(
  params: CompletionParams
): Promise<{ path?: string; args: string[] }> {
  const imageParts = params.messages.flatMap((message) =>
    message.content.filter((part) => part.type === "image")
  );

  if (imageParts.length === 0) {
    return { args: [] };
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cloxy-codex-"));
  const args: string[] = [];

  for (const [index, image] of imageParts.entries()) {
    const extension = image.mediaType === "image/png" ? ".png" : ".jpg";
    const filePath = path.join(tempDir, `image-${index + 1}${extension}`);
    await writeFile(filePath, Buffer.from(image.data, "base64"));
    args.push("--image", filePath);
  }

  return {
    path: tempDir,
    args
  };
}

function parseCodexJsonl(stdout: string): CodexParsedOutput {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  let text: string | undefined;
  let sessionId: string | undefined;
  let usage: CompletionUsage | undefined;

  for (const line of lines) {
    const parsed = JSON.parse(line) as Record<string, unknown>;

    if (parsed.type === "thread.started" && typeof parsed.thread_id === "string") {
      sessionId = parsed.thread_id;
      continue;
    }

    if (parsed.type === "turn.completed") {
      usage = extractCodexUsage(parsed) ?? usage;
      continue;
    }

    if (parsed.type === "item.completed") {
      const item = parsed.item as Record<string, unknown> | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        text = item.text;
      }
    }
  }

  return { text, sessionId, usage };
}

function buildResumeModeArgs(codexSandbox: string): string[] {
  if (codexSandbox === "danger-full-access") {
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }

  if (codexSandbox === "workspace-write") {
    return ["--full-auto"];
  }

  return [];
}

export function buildCodexArgs(
  params: CompletionParams,
  sandbox: CodexSandboxMode,
  imageArgs: string[] = []
): string[] {
  const searchArgs = params.codexSearch ? ["--search"] : [];
  const resumeModeArgs = buildResumeModeArgs(sandbox);
  const modelArgs = buildModelArgs(
    normalizeRequestedModel(params.model, "codex"),
    params.reasoningEffort
  );
  const fastModeArgs = buildFastModeArgs(params.codexFastMode);

  if (params.sessionId) {
    return [
      ...searchArgs,
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      ...resumeModeArgs,
      ...modelArgs,
      ...fastModeArgs,
      ...imageArgs,
      params.sessionId,
      "-"
    ];
  }

  return [
    ...searchArgs,
    "exec",
    "--skip-git-repo-check",
    "--json",
    ...buildExecModeArgs(sandbox, params.persistSession),
    ...modelArgs,
    ...fastModeArgs,
    ...imageArgs,
    "-"
  ];
}

function buildExecModeArgs(
  codexSandbox: CodexSandboxMode,
  persistSession: boolean
): string[] {
  const persistenceArgs = persistSession ? [] : ["--ephemeral"];

  if (codexSandbox === "danger-full-access") {
    return ["--dangerously-bypass-approvals-and-sandbox", ...persistenceArgs];
  }

  return ["--sandbox", codexSandbox, ...persistenceArgs];
}

function buildModelArgs(
  model: string | undefined,
  reasoningEffort: string | undefined
): string[] {
  const args: string[] = [];
  const cleanModel = model?.trim();
  const cleanEffort = reasoningEffort?.trim();

  if (cleanModel) {
    args.push("--model", cleanModel);
  }

  if (cleanEffort) {
    args.push("-c", `model_reasoning_effort="${cleanEffort}"`);
  }

  return args;
}

function buildFastModeArgs(fastMode: boolean | null | undefined): string[] {
  if (fastMode === true) {
    return ["--enable", "fast_mode"];
  }

  if (fastMode === false) {
    return ["--disable", "fast_mode"];
  }

  return [];
}

function extractCodexUsage(parsed: Record<string, unknown>): CompletionUsage | undefined {
  const usage = parsed.usage as Record<string, unknown> | undefined;
  if (!usage) {
    return undefined;
  }

  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;

  return {
    inputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens,
    contextWindow: null,
    totalContextTokens: inputTokens
  };
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
