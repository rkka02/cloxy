# Cloxy Architecture

## Core Flow

1. An OpenAI-compatible client sends a `chat.completions` or `responses` request.
2. Cloxy resolves the backend from the requested model name.
3. The request message array is flattened into a deterministic prompt transcript.
4. Cloxy launches the chosen local CLI in non-interactive mode.
5. CLI output is translated back into OpenAI-compatible JSON or SSE chunks.

## Request Translation

MVP request translation deliberately stays simple:

- support `system`, `user`, `assistant`, and `tool` roles
- support message content as plain strings
- support content arrays with text and image parts
- support `responses.instructions` as an injected system message
- support OpenAI-style `function` tools through a Cloxy planning layer
- accept `data:image/jpeg;base64,...` and `data:image/png;base64,...`
- reject remote URLs and non-image binary inputs for now

Prompt rendering follows this shape:

- combined system guidance block
- normalized transcript of prior messages
- explicit instruction to continue with the next assistant reply only
- when tools are present, Cloxy swaps in a strict JSON planner prompt so the backend emits either assistant text or function call intents

This keeps behavior predictable across both backends.

## Stateless By Default

Cloxy defaults to stateless request transport.

Why:

- most OpenAI-compatible clients already resend relevant history on every request
- stateless requests are easier to reason about and debug
- backend-native session reuse creates cleanup and divergence problems if it becomes implicit

The default backend launches are therefore ephemeral:

- Claude runs with SDK `persistSession: false`
- Codex runs with `codex exec --ephemeral`

Session reuse is available as an explicit opt-in transport mode instead:

- `X-Cloxy-Session-Mode: persist` creates a backend-native session and returns its ID in `X-Cloxy-Session-Id`
- `X-Cloxy-Session-Id: <uuid>` resumes that backend-native session on later requests

When resuming a persisted session, clients should send only the new turn they want appended. Resending the entire older transcript will duplicate context inside the backend session.

## Working Directory Control

Because the backend CLIs can access the local filesystem, each request runs inside a resolved working directory:

- default: server startup directory
- override: `X-Cloxy-Working-Directory`
- validation: requested path must live inside one of `CLOXY_ALLOWED_ROOTS`

This prevents the proxy from becoming an unrestricted local shell bridge by accident.

Image inputs are also guarded before backend handoff:

- maximum 10 MiB per image
- maximum 40 MiB total image payload per request
- maximum 16 images per request

## Backend Notes

### Claude

- command path uses the Claude Agent SDK against the local Claude Code install
- multimodal requests are sent through SDK streaming input mode so image blocks survive translation
- stateless requests disable transcript persistence; persisted sessions use SDK resume mode
- tools are disabled by default to avoid nested-agent surprises
- on Windows, shim-style commands are launched through the shell so `.cmd` installs work

### Codex

- command path uses `codex exec --json`
- sandbox defaults to `read-only`
- stateless requests use `--ephemeral`; persisted sessions use `codex exec resume`
- data URL images are materialized to temporary files and attached via `--image`
- JSONL events are translated into a final assistant chunk for stream requests
- on Windows, shim-style commands are launched through the shell so `.cmd` installs work

### Gemini

- command path uses `gemini -p ... -o json|stream-json --approval-mode plan`
- stateless requests still create backend sessions internally, but Cloxy only exposes and resumes them when persistence is requested
- current Cloxy integration is text-only
- stream-json events are parsed from line-oriented JSON with an initial `init` event carrying the session ID

## Non-Goals For MVP

- full OpenAI `/v1/responses` parity
- backend-native tool invocation passthrough
- embeddings
- automatic workspace checkout or worktree management
