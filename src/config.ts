import path from "node:path";

export type BackendName = "claude" | "codex" | "gemini";

export interface AdvertisedModel {
  id: string;
  backend: BackendName;
  backendModel?: string;
}

export interface CloxyConfig {
  host: string;
  port: number;
  apiKey?: string;
  defaultBackend: BackendName;
  models: AdvertisedModel[];
  allowedRoots: string[];
  claudeBinary: string;
  claudePermissionMode: string;
  codexBinary: string;
  codexSandbox: string;
  codexTimeoutMs: number;
  geminiBinary: string;
  geminiDefaultModel: string;
  geminiFallbackModel?: string;
  geminiTimeoutMs: number;
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

function parseAdvertisedModels(
  input: string | undefined,
  backend: BackendName,
  defaults: AdvertisedModel[]
): AdvertisedModel[] {
  if (!input?.trim()) {
    return defaults;
  }

  const seen = new Set<string>();
  const models: AdvertisedModel[] = [];

  for (const rawEntry of input.split(",")) {
    const entry = rawEntry.trim();
    if (!entry) {
      continue;
    }

    const separatorIndex = entry.indexOf("=");
    const publicId =
      separatorIndex === -1 ? entry : entry.slice(0, separatorIndex).trim();
    const backendModel =
      separatorIndex === -1 ? undefined : entry.slice(separatorIndex + 1).trim();

    if (!publicId || seen.has(publicId)) {
      continue;
    }

    seen.add(publicId);
    models.push({
      id: publicId,
      backend,
      ...(backendModel ? { backendModel } : {})
    });
  }

  return models.length > 0 ? models : defaults;
}

export function loadConfig(): CloxyConfig {
  const cwd = process.cwd();
  const allowedRoots = splitPaths(process.env.CLOXY_ALLOWED_ROOTS);
  const geminiDefaultModel =
    process.env.CLOXY_GEMINI_DEFAULT_MODEL ?? "gemini-3.1-pro-preview";
  const geminiFallbackModel =
    process.env.CLOXY_GEMINI_FALLBACK_MODEL ?? "gemini-3-flash-preview";
  const defaultModels: AdvertisedModel[] = [
    { id: "cloxy-claude", backend: "claude" },
    { id: "claude", backend: "claude" },
    { id: "sonnet", backend: "claude", backendModel: "sonnet" },
    { id: "opus", backend: "claude", backendModel: "opus" },
    { id: "cloxy-codex", backend: "codex" },
    { id: "codex", backend: "codex" },
    { id: "gpt-5", backend: "codex", backendModel: "gpt-5" },
    { id: "gpt-5-codex", backend: "codex", backendModel: "gpt-5-codex" },
    { id: "cloxy-gemini", backend: "gemini", backendModel: geminiDefaultModel },
    { id: "gemini", backend: "gemini", backendModel: geminiDefaultModel },
    { id: geminiDefaultModel, backend: "gemini", backendModel: geminiDefaultModel },
    ...(geminiFallbackModel && geminiFallbackModel !== geminiDefaultModel
      ? [
          {
            id: geminiFallbackModel,
            backend: "gemini" as const,
            backendModel: geminiFallbackModel
          }
        ]
      : [])
  ];
  const config: CloxyConfig = {
    host: process.env.CLOXY_HOST ?? "127.0.0.1",
    port: Number(process.env.CLOXY_PORT ?? "4141"),
    apiKey: process.env.CLOXY_API_KEY,
    defaultBackend: (process.env.CLOXY_DEFAULT_BACKEND as BackendName) ?? "claude",
    models: [
      ...parseAdvertisedModels(
        process.env.CLOXY_CLAUDE_MODELS,
        "claude",
        defaultModels.filter((model) => model.backend === "claude")
      ),
      ...parseAdvertisedModels(
        process.env.CLOXY_CODEX_MODELS,
        "codex",
        defaultModels.filter((model) => model.backend === "codex")
      ),
      ...parseAdvertisedModels(
        process.env.CLOXY_GEMINI_MODELS,
        "gemini",
        defaultModels.filter((model) => model.backend === "gemini")
      )
    ],
    allowedRoots: allowedRoots.length > 0 ? allowedRoots : [normalizeAbsolutePath(cwd)],
    claudeBinary: process.env.CLOXY_CLAUDE_BIN ?? "claude",
    claudePermissionMode: process.env.CLOXY_CLAUDE_PERMISSION_MODE ?? "default",
    codexBinary: process.env.CLOXY_CODEX_BIN ?? "codex",
    codexSandbox: process.env.CLOXY_CODEX_SANDBOX ?? "read-only",
    codexTimeoutMs: Number(process.env.CLOXY_CODEX_TIMEOUT_MS ?? "7200000"),
    geminiBinary: process.env.CLOXY_GEMINI_BIN ?? "gemini",
    geminiDefaultModel,
    geminiFallbackModel,
    geminiTimeoutMs: Number(process.env.CLOXY_GEMINI_TIMEOUT_MS ?? "7200000")
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
