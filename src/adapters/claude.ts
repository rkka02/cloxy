import { spawn } from "node:child_process";
import type { CloxyConfig } from "../config";
import type {
  BackendAdapter,
  CompletionParams,
  CompletionResult,
  StreamEvent
} from "./types";

interface ClaudeJsonResult {
  result?: string;
}

export class ClaudeAdapter implements BackendAdapter {
  readonly backend = "claude" as const;

  constructor(private readonly config: CloxyConfig) {}

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const args = this.buildCommonArgs(["--output-format=json"]);
    const stdout = await runProcess({
      command: this.config.claudeBinary,
      args: [...args, "--", params.prompt],
      cwd: params.cwd
    });
    const parsed = JSON.parse(stdout.trim()) as ClaudeJsonResult;
    const text = (parsed.result ?? "").trim();

    if (!text) {
      throw new Error("Claude returned an empty result.");
    }

    return {
      backend: this.backend,
      text
    };
  }

  async *stream(params: CompletionParams): AsyncGenerator<StreamEvent> {
    const args = this.buildCommonArgs([
      "--verbose",
      "--output-format=stream-json",
      "--include-partial-messages"
    ]);
    const child = spawn(this.config.claudeBinary, [...args, "--", params.prompt], {
      cwd: params.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    let buffer = "";
    child.stdout.setEncoding("utf8");

    for await (const chunk of child.stdout) {
      buffer += chunk;

      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          break;
        }

        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (!line) {
          continue;
        }

        const event = JSON.parse(line) as Record<string, unknown>;
        const type = event.type;

        if (type === "stream_event") {
          const payload = event.event as Record<string, unknown> | undefined;
          const delta = payload?.delta as Record<string, unknown> | undefined;
          const text = delta?.text as string | undefined;
          if (typeof text === "string" && text.length > 0) {
            yield { type: "delta", text };
          }
          continue;
        }

        if (type === "result") {
          yield { type: "done" };
        }
      }
    }

    const exitCode = await waitForExit(child);
    if (exitCode !== 0) {
      throw new Error(`Claude exited with code ${exitCode}: ${stderr.trim()}`);
    }
  }

  private buildCommonArgs(extraArgs: string[]): string[] {
    return [
      "-p",
      "--permission-mode",
      this.config.claudePermissionMode,
      "--tools",
      "",
      ...extraArgs
    ];
  }
}

async function runProcess(input: {
  command: string;
  args: string[];
  cwd: string;
}): Promise<string> {
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
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
    throw new Error(`Claude exited with code ${exitCode}: ${stderr.trim()}`);
  }

  return stdout;
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}
