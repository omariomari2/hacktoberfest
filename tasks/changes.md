# Changes on `feature/gemma-backend`

Branch created from published hackathon `origin/main` (02a25e6). Nothing has been pushed yet.

| Commit | Task | Summary |
| --- | --- | --- |
| c3d5ff6 | 1 | Froze the Mac ↔ backend contract (`tasks/contract.md`); `setup.md` now points to it |
| e09263d | 2 | Gemma adapter for `/chat`: request translation, validation, safe errors |
| a2f45c1 | 4 | Progressive streaming that the existing Swift parser understands |
| 4402c49 | 5 | Protected Node service for DigitalOcean |
| (docs) | — | This summary; `tasks/todo.md` is left as the original plan |

## Task status against `tasks/todo.md`

| Task | Status |
| --- | --- |
| 1. Branch and contract | Done. Mac teammate review of the contract is still pending |
| 2. Gemma screenshot response | Code and unit tests done. Real-image smoke test **blocked** on `GEMINI_API_KEY` |
| 3. Mac baseline | Not started (Mac teammate) |
| 4. Streaming | Done. Checked against a test copy of the Swift parser; still needs a check on the Mac |
| 5. Protected Node service | Done and verified locally |
| 6. DigitalOcean deployment | Not started; needs cost, region and hostname decisions |
| 7. Mac ↔ hosted Gemma | Not started |
| 8. Voice output and handoff | Not started |

## What changed and why

### Contract (`tasks/contract.md`)

This is the single reference for both sides. It covers the request and response shapes, the `Authorization: Bearer <CLICKY_APP_TOKEN>` header, size and concurrency limits, the error JSON format and status codes, logging rules, configuration names and file ownership. The Mac reads `ClickyBackendBaseURL` and `ClickyAppToken` from `defaults write`, so nothing secret goes into the repository.

### Gemma adapter (`worker/src/gemma.ts`)

- Accepts the exact Anthropic-style body `ClaudeAPI.swift` already sends and converts it to Gemini `contents`. Assistant becomes `model`; image blocks become `inlineData`.
- The model is pinned to `gemma-4-26b-a4b-it` on the server, and the client's `model` field is ignored. Each response carries an `x-clicky-model` header.
- The system prompt is added to the front of the first user turn by default, because it's unconfirmed whether Gemma accepts `systemInstruction`. Setting `GEMMA_SYSTEM_PROMPT_MODE=instruction` switches modes once that's tested.
- Validation runs before any model call: JPEG/PNG only, with magic bytes checked; at most 4 images, each 4 MB or less; body 10 MB or less; at most 40 messages; `max_tokens` clamped to 1–2048.
- Upstream errors are mapped to safe messages (429 → `rate_limited`, others → `upstream_error`, a timeout over 90 s → `upstream_timeout`). Gemini's error body is never forwarded.
- Thought/reasoning parts are dropped. `[POINT:…]` tags pass through unchanged.

### Streaming (same file)

- Gemini `streamGenerateContent?alt=sse` is re-emitted as `content_block_delta` / `text_delta` events, followed by `message_stop`.
- The parser handles any chunk split, including inside multi-byte characters and CRLF pairs. Each delta is forwarded as soon as it completes, never buffered.
- When the client cancels or disconnects, the upstream request is aborted. A failure mid-stream becomes an `error` event. The current Swift parser ignores that event; task 7 will make it visible.

### Node service (`worker/src/server.ts`, `worker/src/main.ts`, `worker/src/speech.ts`)

- `GET /health` and `HEAD /` (the client's TLS warm-up) need no token.
- `POST /chat`, `/tts` and `/transcribe-token` require the app token. The comparison is constant-time and happens before the body is read.
- The 10 MB body cap is enforced while the body streams in. At most 4 concurrent `/chat` requests are allowed; a slot frees when the stream ends or the client disconnects.
- The service refuses to start without `CLICKY_APP_TOKEN`. At startup it logs which settings are present, never their values.
- Each request produces one JSON log line: request ID, route, status, ms, image count and bytes. Prompts, images, answers, tokens and keys are never logged.
- The speech handlers moved to `speech.ts`. Without their keys they return 503 `not_configured`, so the Mac can fall back to native speech.
- The Cloudflare Worker entry (`src/index.ts`) uses the same Gemma and speech code but has **no auth**. Use the Node service for the demo.

### Tooling (`worker/`)

- `package.json` is now an ES module. New scripts: `start` (`node src/main.ts`), `build`/`typecheck` (`tsc`), `test` (Node's built-in runner, using its native TypeScript support), `smoke:gemma`.
- Dev dependencies `typescript` and `@types/node` are installed. Node 22.18 or newer is required; I tested with 24.13.1.
- `.env.example` lists the variable names. `worker/.env` is git-ignored.

## Verification

| Check | Result |
| --- | --- |
| `npm test` in `worker/` | 47 passed, 0 failed |
| `npm run build` (typecheck) | Passed |
| Local server over real HTTP, no Gemini key | `/health` 200, `HEAD /` 200, `/chat` with no token 401, authenticated `/chat` 503 `not_configured`, 11 MB body 413, `/tts` 503 `not_configured`; the token never appeared in the logs |
| Real Gemma screenshot, streaming and POINT accuracy | **Not run.** `GEMINI_API_KEY` is not set on this PC |

The tests cover every single-byte split point of a sample stream, progressive delivery, cancellation, mid-stream errors, token rejection, oversized bodies, the concurrency limit and slot release, and logs free of payloads.

## How to run the real smoke test

Set the key in the backend environment, or in `worker/.env`. Don't paste it into chat. Then run:

```bash
cd worker
npm run smoke:gemma               # system prompt prepended (default)
npm run smoke:gemma instruction   # tests whether Gemma accepts systemInstruction
```

The script draws a synthetic 640×400 screen with one red button at a known position. It then reports the answer, whether the POINT tag lands inside the button, the time to the first streamed delta and whether `message_stop` arrived.

## Still to do

- **Task 2:** Run the smoke test above. If `instruction` mode works, consider making it the default.
- **Task 3 (Mac teammate):** Xcode build, permissions and Apple Speech check.
- **Task 6:** Before provisioning anything, decide the DigitalOcean region, size, monthly cost and HTTPS hostname/TLS approach. Supply `GEMINI_API_KEY` and `CLICKY_APP_TOKEN` through the platform's secret store.
- **Task 7:** `ClaudeAPI.swift` doesn't send the `Authorization` header yet. Until it does, the deployed backend will answer 401. The app should also read `ClickyBackendBaseURL`/`ClickyAppToken`, show Gemma instead of the Claude picker, and surface stream `error` events.
- **Team review:** Have the Mac teammate review `tasks/contract.md` (the checkpoint after task 5).


## Review fixes and live verification

- Explicitly set Gemma thinkingLevel to minimal so short companion replies do not spend the response budget on hidden thinking.
- Smoke checks now fail for absent, wrong-screen or out-of-target POINT tags in both answer modes. Added regression coverage for settings and target validation.
- The fixture prompt explicitly requires conversion from normalized coordinates to screenshot pixels. This is a fixture instruction, not a claim that production Mac pointing is solved.
- Verification on Windows: 49 tests pass; npm run build passes. Live Gemma screenshot smoke test returned HTTP 200 in both modes, nonstream point (517,300), stream point (518,301), both inside the red button. First visible stream delta arrived at 793 ms; message_stop received.
- Mac app authentication, native speech, real display coordinate mapping and DigitalOcean deployment remain pending. No Swift source or production infrastructure changed in these fixes.
