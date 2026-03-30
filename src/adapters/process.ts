import path from "node:path";
import { spawn, type SpawnOptions } from "node:child_process";

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
