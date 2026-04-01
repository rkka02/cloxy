import type { BackendName } from "../config";
import type { ConversationMessage } from "../openai";

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface CompletionParams {
  messages: ConversationMessage[];
  cwd: string;
  persistSession: boolean;
  sessionId?: string;
  codexSandbox?: CodexSandboxMode;
}

export interface CompletionResult {
  backend: BackendName;
  text: string;
  sessionId?: string;
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
}

export interface BackendAdapter {
  readonly backend: BackendName;
  readonly capabilities: BackendCapabilities;
  complete(params: CompletionParams): Promise<CompletionResult>;
  stream(params: CompletionParams): AsyncGenerator<StreamEvent>;
}
