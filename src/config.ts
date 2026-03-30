import path from "node:path";

export type BackendName = "claude" | "codex";

export interface CloxyConfig {
  host: string;
  port: number;
  apiKey?: string;
  defaultBackend: BackendName;
  allowedRoots: string[];
  claudeBinary: string;
  claudePermissionMode: string;
  codexBinary: string;
  codexSandbox: string;
}

function normalizeAbsolutePath(input: string): string {
  return path.resolve(input);
}

function splitPaths(input: string | undefined): string[] {
  if (!input) {
    return [];
  }

  return input
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeAbsolutePath);
}

export function loadConfig(): CloxyConfig {
  const cwd = process.cwd();
  const allowedRoots = splitPaths(process.env.CLOXY_ALLOWED_ROOTS);
  const config: CloxyConfig = {
    host: process.env.CLOXY_HOST ?? "127.0.0.1",
    port: Number(process.env.CLOXY_PORT ?? "4141"),
    apiKey: process.env.CLOXY_API_KEY,
    defaultBackend: (process.env.CLOXY_DEFAULT_BACKEND as BackendName) ?? "claude",
    allowedRoots: allowedRoots.length > 0 ? allowedRoots : [normalizeAbsolutePath(cwd)],
    claudeBinary: process.env.CLOXY_CLAUDE_BIN ?? "claude",
    claudePermissionMode: process.env.CLOXY_CLAUDE_PERMISSION_MODE ?? "default",
    codexBinary: process.env.CLOXY_CODEX_BIN ?? "codex",
    codexSandbox: process.env.CLOXY_CODEX_SANDBOX ?? "read-only"
  };

  return config;
}

export function resolveWorkingDirectory(
  requestedDir: string | undefined,
  allowedRoots: string[]
): string {
  const candidate = normalizeAbsolutePath(requestedDir ?? process.cwd());

  const allowed = allowedRoots.some((root) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });

  if (!allowed) {
    throw new Error(`Working directory is outside allowed roots: ${candidate}`);
  }

  return candidate;
}
