import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export function spawnCli(
  command: string,
  args: string[],
  options: SpawnOptions
) {
  const windowsCommand = resolveWindowsCommand(command);
  if (windowsCommand) {
    return spawn(windowsCommand.command, [...windowsCommand.args, ...args], {
      ...options,
      shell: false
    });
  }

  return spawn(command, args, {
    ...options,
    shell: options.shell ?? shouldUseCommandShell(command)
  });
}

interface ResolvedWindowsCommand {
  command: string;
  args: string[];
}

function resolveWindowsCommand(command: string): ResolvedWindowsCommand | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }

  const extension = path.extname(command).toLowerCase();

  if (extension === ".ps1") {
    return {
      command: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        resolveExistingPath(command)
      ]
    };
  }

  const shimPath =
    extension === ".cmd" || extension === ".bat"
      ? resolveExistingPath(command)
      : resolveCommandOnPath(command, [".cmd", ".bat"]);

  if (!shimPath) {
    return undefined;
  }

  return parseNodeShim(shimPath);
}

function shouldUseCommandShell(command: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }

  const extension = path.extname(command).toLowerCase();

  // Windows coding CLIs are commonly installed as cmd/bat shims.
  return extension === "" || extension === ".cmd" || extension === ".bat";
}

function resolveExistingPath(input: string): string {
  return path.isAbsolute(input) ? input : path.resolve(input);
}

function resolveCommandOnPath(command: string, extensions: string[]): string | undefined {
  const pathEnv = process.env.PATH;
  if (!pathEnv) {
    return undefined;
  }

  const commandName = path.basename(command);
  for (const directory of pathEnv.split(path.delimiter)) {
    const trimmed = directory.trim();
    if (!trimmed) {
      continue;
    }

    for (const extension of extensions) {
      const candidate = path.join(trimmed, `${commandName}${extension}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function parseNodeShim(shimPath: string): ResolvedWindowsCommand | undefined {
  const contents = readFileSync(shimPath, "utf8");
  const scriptMatch = contents.match(/"%dp0%\\([^"]+\.js)"/i);
  if (!scriptMatch) {
    return undefined;
  }

  const nodeArgsMatch = contents.match(/"%_prog%"\s+(.*?)\s+"%dp0%\\[^"]+\.js"/i);
  const nodeArgs = nodeArgsMatch?.[1]?.trim()
    ? nodeArgsMatch[1].trim().split(/\s+/)
    : [];

  return {
    command: process.execPath,
    args: [
      ...nodeArgs,
      path.resolve(path.dirname(shimPath), scriptMatch[1].replace(/\\/g, path.sep))
    ]
  };
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
