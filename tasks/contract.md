# Mac ↔ backend contract (frozen in task 1)

Implementation branch: `feature/gemma-backend`, created from published hackathon `origin/main` (02a25e6). Never merge the original upstream-history `main` into it.

Change this contract only by agreement between the backend owner (this PC) and the Mac teammate. Record the change in this file in the same commit.

## Ownership

| Area | Owner | Files |
| --- | --- | --- |
| Backend adapter, Node service, deployment | This PC | `worker/**`, `deploy/**` |
| Native build, permissions, voice, UI | Mac teammate | `leanring-buddy/**` except `ClaudeAPI.swift` |
| `ClaudeAPI.swift` (auth header, error display) | This PC writes, Mac teammate builds and verifies | `leanring-buddy/ClaudeAPI.swift` |
| `CompanionManager.swift` | Mac teammate only; this PC sends proposed diffs and does not commit them directly | — |

## Model

The server pins `gemma-4-26b-a4b-it` and ignores the client's `model` field. Every `/chat` response carries the `X-Clicky-Model: gemma-4-26b-a4b-it` header. The nonstreaming body also includes `"model"`. The UI should show this value instead of a Claude model picker (task 7).

## Authentication

- Expensive routes (`POST /chat`, `/tts`, `/transcribe-token`) require `Authorization: Bearer <CLICKY_APP_TOKEN>`.
- `GET /health` and `HEAD /` are unauthenticated and return no secrets. `HEAD /` is used for the client's TLS warm-up.
- The server compares tokens in constant time. A missing or wrong token gets `401` before the request body is parsed.
- This is a shared demo token, not per-user identity.

## POST /chat request

The existing Anthropic-style body sent by `ClaudeAPI.swift` is unchanged:

```json
{
  "model": "ignored",
  "max_tokens": 1024,
  "stream": true,
  "system": "string",
  "messages": [
    { "role": "user", "content": "history placeholder" },
    { "role": "assistant", "content": "previous answer" },
    { "role": "user", "content": [
      { "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": "..." } },
      { "type": "text", "text": "screen label" },
      { "type": "text", "text": "user prompt" }
    ] }
  ]
}
```

- `content` is either a string or an array of `text` and `image` blocks. Other block types are rejected with `400`.
- `media_type` must be `image/jpeg` or `image/png`, and the bytes must match the declared type.
- `stream` defaults to `false` when omitted.

## Limits (checked before any model call)

| Limit | Value | Error |
| --- | --- | --- |
| Request body | 10 MB | 413 `payload_too_large` |
| Images per request | 4 | 400 `invalid_request` |
| Decoded size per image | 4 MB | 413 `payload_too_large` |
| Messages per request | 40 | 400 `invalid_request` |
| `max_tokens` | clamped to 1–2048 | — |
| Upstream time limit | 90 s | 504 `upstream_timeout` |
| Concurrent `/chat` requests | 4 | 503 `busy` |

Captures are 1280 px JPEGs at quality 0.8 (`CompanionScreenCaptureUtility.swift`), which is well under these limits.

## Streaming response (`stream: true`)

`200`, `content-type: text/event-stream`. Each event is one `data:` line followed by a blank line:

```text
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"..."}}

data: {"type":"message_stop"}
```

- Text arrives in increments as Gemma produces it; the backend does not buffer the whole answer.
- Gemma thought/reasoning parts are never emitted.
- `[POINT:x,y:label:screenN]` tags pass through unchanged. Coordinates follow the convention in the system prompt sent by `CompanionManager.swift`.
- An error after the stream starts is emitted as `data: {"type":"error","error":{"type":"...","message":"..."}}`, and then the stream closes. The current Swift parser ignores this event. Task 7 makes it visible.

## Nonstreaming response (`stream: false`)

```json
{ "model": "gemma-4-26b-a4b-it", "content": [ { "type": "text", "text": "..." } ] }
```

## Errors (before streaming starts)

Status code plus this JSON body. Messages are safe to show to users and never include keys, prompts or upstream bodies.

```json
{ "error": { "type": "unauthorized", "message": "Missing or invalid app token" } }
```

| Status | `type` | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | Malformed JSON, bad blocks or roles, too many images/messages |
| 401 | `unauthorized` | Missing or wrong app token |
| 404 / 405 | `not_found` / `method_not_allowed` | Unknown route or method |
| 413 | `payload_too_large` | Body or image over the limit |
| 415 | `unsupported_media_type` | Image is not JPEG or PNG, or its bytes do not match the declared type |
| 429 | `rate_limited` | Gemini quota exceeded; the backend never silently switches models |
| 502 | `upstream_error` | Gemini returned an error or an unusable response |
| 503 | `busy` / `not_configured` | Concurrency limit reached, or a speech credential is missing |
| 504 | `upstream_timeout` | Gemini took longer than 90 s |

`ClaudeAPI.swift` already displays `API Error (<status>): <body>` for non-2xx responses.

## Speech routes

`/tts` and `/transcribe-token` keep their existing request and response shapes. If `ELEVENLABS_API_KEY` or `ASSEMBLYAI_API_KEY` is not set, they return 503 `not_configured`. The Mac should prefer `VoiceTranscriptionProvider=apple` and use native speech output as the fallback (task 8).

## Logging

Each request logs only: request ID, route, status, duration, image count and byte sizes. The backend never logs prompts, transcripts, images, model output, tokens or keys.

## Configuration names (values never committed)

| Where | Name | Purpose |
| --- | --- | --- |
| Backend env | `GEMINI_API_KEY` | Gemini API key |
| Backend env | `CLICKY_APP_TOKEN` | Shared demo token |
| Backend env | `PORT` | Listen port (default 8787) |
| Backend env (optional) | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ASSEMBLYAI_API_KEY` | Speech routes |
| Mac user defaults | `ClickyBackendBaseURL` | HTTPS base URL, no trailing slash |
| Mac user defaults | `ClickyAppToken` | Same value as `CLICKY_APP_TOKEN` |

Mac local setup (does not touch the repository; the bundle ID must match the one in Xcode signing):

```bash
defaults write com.yourcompany.leanring-buddy ClickyBackendBaseURL -string "https://<backend-host>"
defaults write com.yourcompany.leanring-buddy ClickyAppToken -string "$(pbpaste)"   # copy the token from the team password manager first
```

User defaults are stored as plaintext in `~/Library/Preferences`. That is acceptable for a revocable demo token, but not for provider API keys, which stay on the backend only.

## Open items

- [ ] Mac teammate reviews and accepts this contract.
- [ ] Task 2: confirm whether Gemma accepts `systemInstruction`. If it does not, the backend prepends the trusted system text to the first user turn.
