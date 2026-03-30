import type { BackendName } from "../config";

export interface CompletionParams {
  prompt: string;
  cwd: string;
}

export interface CompletionResult {
  backend: BackendName;
  text: string;
}

export interface StreamEvent {
  type: "delta" | "done";
  text?: string;
}

export interface BackendAdapter {
  readonly backend: BackendName;
  complete(params: CompletionParams): Promise<CompletionResult>;
  stream(params: CompletionParams): AsyncGenerator<StreamEvent>;
}
