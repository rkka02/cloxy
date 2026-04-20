import type { BackendName } from "../config";
import type { ConversationMessage } from "../openai";

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type ClaudePermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
export type GeminiApprovalMode = "default" | "auto_edit" | "yolo" | "plan";
export type BackendUsagePolicy = "general" | "private-use-only";

export interface CompletionUsage {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  contextWindow?: number | null;
  totalContextTokens: number;
}

export interface CompletionParams {
  messages: ConversationMessage[];
  cwd: string;
  persistSession: boolean;
  sessionId?: string;
  model?: string;
  reasoningEffort?: string;
  maxTurns?: number;
  env?: Record<string, string>;
  additionalDirectories?: string[];
  codexSearch?: boolean;
  codexFastMode?: boolean | null;
  codexSandbox?: CodexSandboxMode;
  codexReasoningEffort?: CodexReasoningEffort;
  claudePermissionMode?: ClaudePermissionMode;
  geminiApprovalMode?: GeminiApprovalMode;
}

export interface CompletionResult {
  backend: BackendName;
  text: string;
  sessionId?: string;
  usage?: CompletionUsage;
}

export interface BackendCapabilities {
  text: boolean;
  imageInput: boolean;
  sessionPersistence: boolean;
  tools: boolean;
  streaming: boolean;
}

export interface StreamEvent {
  type: "session" | "delta" | "done";
  sessionId?: string;
  text?: string;
  usage?: CompletionUsage;
}

export interface BackendAdapter {
  readonly backend: BackendName;
  readonly capabilities: BackendCapabilities;
  readonly usagePolicy: BackendUsagePolicy;
  complete(params: CompletionParams): Promise<CompletionResult>;
  stream(params: CompletionParams): AsyncGenerator<StreamEvent>;
}
