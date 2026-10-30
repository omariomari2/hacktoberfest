# Clicky integration tasks

Status: planning complete; implementation not started. Every task below is pending.

## Task 1: Clean implementation branch and agree contract

**Owner:** This PC / team
**Description:** Clean implementation branch and agree contract to deliver the next verifiable general-purpose Clicky milestone.
**Dependencies:** None
**Files likely touched:** git refs; tasks/contract.md (new); setup.md
**Estimated scope:** Small: 1–2 docs; 10–15 minutes

**Acceptance criteria:**
- [ ] Fetch hackathon main and create feature/gemma-backend from the published clean history; preserve dirty work and original local main.
- [ ] Record /chat request and SSE/nonstream response shapes, error semantics, auth header, limits and Mac/backend ownership.
- [ ] Document local-only token configuration without committing a credential.

**Verification:**
- [ ] Compare branch ancestry with hackathon/main; inspect actual ClaudeAPI parser; review contract with Mac teammate. Never merge original main into the clean branch.

## Task 2: Prove Gemma screenshot response

**Owner:** This PC
**Description:** Prove Gemma screenshot response to deliver the next verifiable general-purpose Clicky milestone.
**Dependencies:** 1
**Files likely touched:** worker/src/gemma.ts (new); worker/test/gemma.test.ts (new); worker/src/index.ts
**Estimated scope:** Medium: 3 files; 25–40 minutes

**Acceptance criteria:**
- [ ] Translate existing system, history, text and JPEG/PNG image blocks; server pins gemma-4-26b-a4b-it.
- [ ] Return existing nonstreaming content text shape and preserve valid POINT tags; omit thought parts.
- [ ] A real harmless labeled screenshot yields a relevant answer; unsupported images and provider errors return safe messages.

**Verification:**
- [ ] Focused unit tests with captured input shapes plus one real image smoke request. Record actual command once test tooling is introduced; proposed Node test runner with TypeScript execution configured in task 1/2. Do not call it passed until executed.

## Task 3: Build Mac baseline and verify input

**Owner:** Mac teammate
**Description:** Build Mac baseline and verify input to deliver the next verifiable general-purpose Clicky milestone.
**Dependencies:** 1
**Files likely touched:** leanring-buddy/Info.plist; setup.md
**Estimated scope:** Small: 1–2 files; 20–40 minutes

**Acceptance criteria:**
- [ ] Build/run leanring-buddy scheme through Xcode GUI and open menu-bar panel.
- [ ] Grant screen, accessibility and microphone permissions; verify screenshot capture and shortcut.
- [ ] Test VoiceTranscriptionProvider=apple on demo Mac; report actual transcript or blocker, not assumed fallback success.

**Verification:**
- [ ] Xcode GUI build, actual permission checks and spoken test. Backend failures remain separately marked BLOCKED. Never run terminal xcodebuild.

### Checkpoint after task 3
- [ ] Review actual evidence and unresolved blockers with the team before the next stage.
- [ ] Run applicable focused backend checks and/or Xcode GUI build; update task status honestly.

## Task 4: Stream Gemma output to existing Swift parser

**Owner:** This PC
**Description:** Stream Gemma output to existing Swift parser to deliver the next verifiable general-purpose Clicky milestone.
**Dependencies:** 2
**Files likely touched:** worker/src/gemma.ts; worker/test/gemma.test.ts
**Estimated scope:** Small: 2 files; 25–40 minutes

**Acceptance criteria:**
- [ ] Consume Gemini streaming events across arbitrary network chunk boundaries and emit actual progressive text_delta SSE events.
- [ ] Honor cancellation, end of stream, Unicode and provider errors without exposing secrets or reasoning parts.
- [ ] Existing Swift parser accumulates the same visible text as the nonstreaming path.

**Verification:**
- [ ] Focused fragmented-SSE fixtures including multiple events/chunk, split JSON, Unicode, cancellation and errors. Confirm progressive delivery, not buffered output relabeled as streaming.

## Task 5: Run protected Node backend locally

**Owner:** This PC
**Description:** Run protected Node backend locally to deliver the next verifiable general-purpose Clicky milestone.
**Dependencies:** 4
**Files likely touched:** worker/src/server.ts (new); worker/package.json; worker/test/server.test.ts (new); worker/.env.example (new)
**Estimated scope:** Medium: 4 files; 25–40 minutes

**Acceptance criteria:**
- [ ] Provide Node start/build/test commands and GET /health plus HEAD / support for client TLS warmup.
- [ ] Require demo app token on expensive routes; enforce agreed body/image sizes, timeout and bounded concurrency.
- [ ] Missing optional speech credentials produce controlled errors; logs contain only request ID, timing and status, not payloads/keys.

**Verification:**
- [ ] Run focused server tests and production build; curl health and authenticated /chat locally. Assert unauthenticated request is rejected and oversized input fails before model invocation.

### Checkpoint after task 5
- [ ] Review actual evidence and unresolved blockers with the team before the next stage.
- [ ] Run applicable focused backend checks and/or Xcode GUI build; update task status honestly.

## Task 6: Deploy backend over HTTPS on DigitalOcean

**Owner:** This PC
**Description:** Deploy backend over HTTPS on DigitalOcean to deliver the next verifiable general-purpose Clicky milestone.
**Dependencies:** 5
**Files likely touched:** worker/Dockerfile (new); worker/.dockerignore (new); deploy/README.md (new); optional deploy service config
**Estimated scope:** Medium: 3–4 files; 30–60 minutes after prerequisites

**Acceptance criteria:**
- [ ] Choose cost, region, hostname/TLS and obtain approval for the concrete resource before provisioning; use DigitalOcean plugin where supported.
- [ ] Deploy production service with GEMINI_API_KEY and app token supplied securely; automatic restart, only necessary inbound ports.
- [ ] Public HTTPS health, unauthorized rejection and authenticated screenshot stream succeed from an independent client.

**Verification:**
- [ ] Check valid TLS hostname/chain, service restart recovery and one real hosted Gemma screenshot response. Document resource identifiers, cost and teardown steps without secrets. Do not claim browser account sign-in proves deployment.

## Task 7: Connect native Mac to hosted Gemma

**Owner:** Mac teammate + this PC
**Description:** Connect native Mac to hosted Gemma to deliver the next verifiable general-purpose Clicky milestone.
**Dependencies:** 3, 6
**Files likely touched:** leanring-buddy/CompanionManager.swift; leanring-buddy/ClaudeAPI.swift; leanring-buddy/CompanionPanelView.swift; local config reader if required
**Estimated scope:** Medium: 3–4 files; 20–35 minutes

**Acceptance criteria:**
- [ ] Configure HTTPS backend URL and local app token; display Gemma rather than misleading Claude selection.
- [ ] Real voice question + captured screen receives progressive text; POINT target maps sensibly on one display.
- [ ] Three successive questions work with context; permission denial, quota failure and backend outage recover visibly.

**Verification:**
- [ ] Mac GUI exercise with harmless target screens. Capture sanitized evidence and timings; test display scaling and one coordinate boundary. No Mac build claims from Windows.

## Task 8: Finish spoken response and teammate handoff

**Owner:** Mac teammate
**Description:** Finish spoken response and teammate handoff to deliver the next verifiable general-purpose Clicky milestone.
**Dependencies:** 7
**Files likely touched:** leanring-buddy/CompanionManager.swift; native speech helper if needed; setup.md
**Estimated scope:** Medium: up to 3 files; 20–35 minutes

**Acceptance criteria:**
- [ ] If ElevenLabs is unavailable, native speech speaks actual answer text and interruption works; do not use hardcoded error speech as successful output.
- [ ] Update setup.md with verified production URL/config names, current provider choices and reproducible Mac steps.
- [ ] Commit and push only reviewed changes on clean hackathon history; retain license and exclude all local credentials.

**Verification:**
- [ ] Mac test of voice output, follow-up interruption and full screen-to-answer-to-pointer flow; git diff --check, focused backend tests, Xcode GUI build and secret scan of new changes before push.

### Checkpoint after task 8
- [ ] Review actual evidence and unresolved blockers with the team before the next stage.
- [ ] Run applicable focused backend checks and/or Xcode GUI build; update task status honestly.
