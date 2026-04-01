# Cloxy

Cloxy is an OpenAI-compatible local proxy for subscription-backed coding CLIs such as Claude Code and Codex CLI.

The first MVP goal is narrow on purpose:

- expose `/v1/models`
- expose `/v1/chat/completions`
- expose `/v1/responses`
- support `stream: true`
- map OpenAI-style requests to local CLI calls
- support OpenAI-style function tool calls for external agent services

This project does not try to perfectly emulate every OpenAI endpoint. It focuses on making existing coding tools talk to a local CLI backend with the smallest useful compatibility surface.

## Status

Current backend support:

- `cloxy-claude`: supports real streaming and image input, but is marked `private-use-only`
- `cloxy-codex`: experimental, streams as chunked final text because Codex CLI exposes JSONL events but not token deltas in the tested path; image input is supported
- `cloxy-gemini`: experimental, supports text input, stream-json parsing, and opt-in session resume; image input is not wired yet

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
- `CLOXY_CODEX_TIMEOUT_MS`
- `CLOXY_GEMINI_BIN`
- `CLOXY_GEMINI_TIMEOUT_MS`

## Models

`GET /v1/models` returns:

- `cloxy-claude`
- `cloxy-codex`
- `cloxy-gemini`

The proxy also accepts simple aliases such as `claude`, `codex`, and `gemini`.

Each model object also includes a `capabilities` block describing support for:

- `text`
- `imageInput`
- `sessionPersistence`
- `tools`
- `streaming`

Each model object also includes `usage_policy`.

- `cloxy-claude`: `private-use-only`
- `cloxy-codex`: `general`
- `cloxy-gemini`: `general`

## Headers

- `Authorization: Bearer <token>` if `CLOXY_API_KEY` is configured
- `X-Cloxy-Working-Directory: /absolute/path` to override the working directory within the configured allowlist
- Windows absolute paths such as `C:\work\repo` are supported too
- `X-Cloxy-Session-Mode: persist` to opt into backend-native session persistence
- `X-Cloxy-Session-Id: <uuid>` to resume a previously persisted Cloxy backend session
- `X-Cloxy-Usage-Policy` is returned on responses so backend-specific usage restrictions stay visible to callers

Requests are stateless by default. That matches how most OpenAI-compatible clients use `chat.completions`: they resend the relevant message history on every request.

When `X-Cloxy-Session-Mode: persist` is set, Cloxy returns the backend session ID in the `X-Cloxy-Session-Id` response header. It also includes the same value in the response body:

- `chat.completions`: top-level `cloxy.session_id`
- `responses`: `metadata.cloxy_session_id`

Reuse that session ID on later requests with `X-Cloxy-Session-Id` to continue the same backend-native session.

When you resume a session, do not resend the full earlier transcript unless you intentionally want duplicate context inside the backend session. Send only the new turn plus any fresh system guidance you want applied.

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

Image input with OpenAI-style `image_url` data URLs:

```bash
curl http://127.0.0.1:4141/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "cloxy-claude",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "What is in this image?"},
          {
            "type": "image_url",
            "image_url": {
              "url": "data:image/png;base64,...",
              "detail": "low"
            }
          }
        ]
      }
    ]
  }'
```

Opt-in session persistence:

```bash
curl -i http://127.0.0.1:4141/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-Cloxy-Session-Mode: persist' \
  -d '{
    "model": "cloxy-codex",
    "messages": [
      {"role": "user", "content": "Remember the word BANANA and reply only stored."}
    ]
  }'
```

Then reuse the returned `X-Cloxy-Session-Id`:

```bash
curl http://127.0.0.1:4141/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-Cloxy-Session-Id: <uuid-from-previous-response>' \
  -d '{
    "model": "cloxy-codex",
    "messages": [
      {"role": "user", "content": "What word did I ask you to remember? Reply with one word."}
    ]
  }'
```

Responses API image input:

```bash
curl http://127.0.0.1:4141/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "cloxy-claude",
    "input": [
      {
        "type": "message",
        "role": "user",
        "content": [
          {"type": "input_text", "text": "What is in this image?"},
          {"type": "input_image", "image_url": "data:image/png;base64,...", "detail": "low"}
        ]
      }
    ]
  }'
```

## Limitations

- `/v1/chat/completions` and `/v1/responses` are implemented in this MVP.
- `/v1/responses` currently supports text and image input only.
- Only `function` tools are supported.
- Cloxy emits tool-call responses, but external callers still execute the tools themselves and send tool results back on the next turn.
- Backend-native tool use is separate from this OpenAI-style tool-call layer.
- Embeddings are not implemented yet.
- Session persistence is opt-in and header-based rather than automatic OpenAI conversation storage.
- `cloxy-claude` is intentionally marked `private-use-only`.
- Codex emits machine-readable events, but token-by-token output was not available in the tested command path, so streaming compatibility is coarse.
- Gemini currently supports text-only requests in Cloxy even though the underlying CLI may evolve further.
- The "fixed cost" thesis only makes sense when the underlying CLI is authenticated in subscription-backed mode rather than API-key billing mode.
- Only `data:image/jpeg;base64,...` and `data:image/png;base64,...` inputs are accepted right now.
- Image inputs are limited to 10 MiB per image, 40 MiB total, and 16 images per request.
- For streaming requests, `X-Cloxy-Session-Id` is always echoed when you resume an existing session. For brand-new persisted streaming sessions, use a non-streaming bootstrap request first if your client needs the session ID immediately.

## Windows Notes

- Cloxy now resolves npm-installed Windows shims for `claude`, `codex`, and `gemini` to their underlying Node entrypoints instead of relying on `cmd.exe` argument forwarding.
- Explicit PowerShell script paths such as `C:\Users\...\gemini.ps1` are also supported.
- If you use custom binaries, prefer setting `CLOXY_CLAUDE_BIN`, `CLOXY_CODEX_BIN`, and `CLOXY_GEMINI_BIN` to the exact command or executable you already run successfully in PowerShell.
- Image smoke tests were verified on Windows by running a second Cloxy instance on a non-default port.

## Architecture

See [docs/architecture.md](docs/architecture.md).
