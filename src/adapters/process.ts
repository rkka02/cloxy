import path from "node:path";
import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export function spawnCli(
  command: string,
  args: string[],
  options: SpawnOptions
) {
  return spawn(command, args, {
    ...options,
    shell: options.shell ?? shouldUseCommandShell(command)
  });
}

function shouldUseCommandShell(command: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }

  const extension = path.extname(command).toLowerCase();

  // Windows coding CLIs are commonly installed as cmd/bat shims.
  return extension === "" || extension === ".cmd" || extension === ".bat";
}

export function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
  label: string
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void terminateProcessTree(child);
      reject(new Error(`${label} process timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onExit = (code: number | null) => {
      cleanup();
      resolve(code);
    };

    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => resolve());
    });
    return;
  }

  child.kill("SIGKILL");
}
