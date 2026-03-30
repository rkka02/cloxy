# Cloxy

Cloxy is an OpenAI-compatible local proxy for subscription-backed coding CLIs such as Claude Code and Codex CLI.

The first MVP goal is narrow on purpose:

- expose `/v1/models`
- expose `/v1/chat/completions`
- expose `/v1/responses`
- support `stream: true`
- map OpenAI-style requests to local CLI calls

This project does not try to perfectly emulate every OpenAI endpoint. It focuses on making existing coding tools talk to a local CLI backend with the smallest useful compatibility surface.

## Status

Current backend support:

- `cloxy-claude`: recommended first backend, supports real streaming
- `cloxy-codex`: experimental, streams as chunked final text because Codex CLI exposes JSONL events but not token deltas in the tested path

## Why This Shape

The safest MVP is "model transport mode", not "nested autonomous agent mode".

Many OpenAI-compatible coding tools already manage file context, diff application, and agent loops on their side. If Cloxy also lets the backend CLI freely inspect and edit the same workspace, behavior becomes unpredictable. For that reason:

- Claude runs with tools disabled by default
- Codex runs in `read-only` sandbox by default

Backend-native tool use can be added later as an opt-in mode.

## Quick Start

```bash
npm install
npm run start
```

PowerShell on Windows:

```powershell
npm install
npm run start
```

Server defaults:

- host: `127.0.0.1`
- port: `4141`
- working directory allowlist: current project directory only

Optional environment variables:

- `CLOXY_HOST`
- `CLOXY_PORT`
- `CLOXY_API_KEY`
- `CLOXY_DEFAULT_BACKEND`
- `CLOXY_ALLOWED_ROOTS`
- `CLOXY_CLAUDE_BIN`
- `CLOXY_CLAUDE_PERMISSION_MODE`
- `CLOXY_CODEX_BIN`
- `CLOXY_CODEX_SANDBOX`

## Models

`GET /v1/models` returns:

- `cloxy-claude`
- `cloxy-codex`

The proxy also accepts simple aliases such as `claude` and `codex`.

## Headers

- `Authorization: Bearer <token>` if `CLOXY_API_KEY` is configured
- `X-Cloxy-Working-Directory: /absolute/path` to override the working directory within the configured allowlist
- Windows absolute paths such as `C:\work\repo` are supported too

Requests are stateless by default. That matches how most OpenAI-compatible clients use `chat.completions`: they resend the relevant message history on every request.

## Example

Non-streaming:

```bash
curl http://127.0.0.1:4141/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "cloxy-claude",
    "messages": [
      {"role": "system", "content": "Answer concisely."},
      {"role": "user", "content": "Say hello in Korean."}
    ]
  }'
```

Responses API:

```bash
curl http://127.0.0.1:4141/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "cloxy-claude",
    "instructions": "Answer concisely.",
    "input": "Say hello in Korean."
  }'
```

Streaming:

```bash
curl http://127.0.0.1:4141/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "cloxy-claude",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Count from 1 to 3."}
    ]
  }'
```

## Limitations

- `/v1/chat/completions` and `/v1/responses` are implemented in this MVP.
- `/v1/responses` currently supports text input only.
- Tool calling, embeddings, image inputs, and stored conversations are not implemented yet.
- Cloxy does not persist backend sessions in the MVP.
- Codex emits machine-readable events, but token-by-token output was not available in the tested command path, so streaming compatibility is coarse.
- The "fixed cost" thesis only makes sense when the underlying CLI is authenticated in subscription-backed mode rather than API-key billing mode.

## Windows Notes

- Cloxy now launches `claude` and `codex` through the Windows command shell when they are installed as `.cmd` or `.bat` shims.
- If you use custom binaries, prefer setting `CLOXY_CLAUDE_BIN` and `CLOXY_CODEX_BIN` to the exact command or executable you already run successfully in PowerShell.

## Architecture

See [docs/architecture.md](docs/architecture.md).
