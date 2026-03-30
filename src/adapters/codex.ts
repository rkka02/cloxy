import { spawn } from "node:child_process";
import type { CloxyConfig } from "../config";
import type {
  BackendAdapter,
  CompletionParams,
  CompletionResult,
  StreamEvent
} from "./types";

interface CodexParsedOutput {
  text?: string;
}

export class CodexAdapter implements BackendAdapter {
  readonly backend = "codex" as const;

  constructor(private readonly config: CloxyConfig) {}

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const output = await runCodexProcess(this.config, params);
    if (!output.text?.trim()) {
      throw new Error("Codex returned an empty result.");
    }

    return {
      backend: this.backend,
      text: output.text.trim()
    };
  }

  async *stream(params: CompletionParams): AsyncGenerator<StreamEvent> {
    const output = await runCodexProcess(this.config, params);

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

async function runCodexProcess(
  config: CloxyConfig,
  params: CompletionParams
): Promise<CodexParsedOutput> {
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--json",
    "--sandbox",
    config.codexSandbox,
    "-"
  ];

  const child = spawn(config.codexBinary, args, {
    cwd: params.cwd,
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdin.end(params.prompt);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exitCode = await waitForExit(child);
  if (exitCode !== 0) {
    throw new Error(`Codex exited with code ${exitCode}: ${stderr.trim()}`);
  }

  return parseCodexJsonl(stdout);
}

function parseCodexJsonl(stdout: string): CodexParsedOutput {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  let text: string | undefined;

  for (const line of lines) {
    const parsed = JSON.parse(line) as Record<string, unknown>;

    if (parsed.type === "item.completed") {
      const item = parsed.item as Record<string, unknown> | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        text = item.text;
      }
    }
  }

  return { text };
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}
