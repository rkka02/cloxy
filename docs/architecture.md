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
- support text-only content arrays
- support `responses.instructions` as an injected system message
- reject image or binary parts for now

Prompt rendering follows this shape:

- combined system guidance block
- normalized transcript of prior messages
- explicit instruction to continue with the next assistant reply only

This keeps behavior predictable across both backends.

## Stateless By Default

The MVP intentionally does not persist backend-native session IDs.

Why:

- most OpenAI-compatible clients already resend relevant history on every request
- stateless requests are easier to reason about and debug
- keeping backend sessions around creates cleanup and divergence problems

If session reuse ever comes back, it should be opt-in and explicit rather than the default transport model.

## Working Directory Control

Because the backend CLIs can access the local filesystem, each request runs inside a resolved working directory:

- default: server startup directory
- override: `X-Cloxy-Working-Directory`
- validation: requested path must live inside one of `CLOXY_ALLOWED_ROOTS`

This prevents the proxy from becoming an unrestricted local shell bridge by accident.

## Backend Notes

### Claude

- command path uses `claude -p`
- JSON mode is used for non-streaming
- `stream-json` mode is used for SSE
- tools are disabled by default to avoid nested-agent surprises
- on Windows, shim-style commands are launched through the shell so `.cmd` installs work

### Codex

- command path uses `codex exec --json`
- sandbox defaults to `read-only`
- JSONL events are translated into a final assistant chunk for stream requests
- on Windows, shim-style commands are launched through the shell so `.cmd` installs work

## Non-Goals For MVP

- full OpenAI `/v1/responses` parity
- assistant tool calling passthrough
- embeddings
- multimodal inputs
- automatic workspace checkout or worktree management
