# HeyCoach branding and activation

The hackathon companion is now named **HeyCoach** (based on upstream Clicky). Keep the existing `leanring-buddy` project and scheme names and the upstream MIT attribution. Visible app product/display names, companion labels and persona use HeyCoach. Hold the existing push-to-talk shortcut and say "hey coach" followed by your question. No always-listening wake-word detector is implemented or intended for this milestone.

The rename needs an Xcode GUI build on the demo Mac. Preserve its current bundle identifier and user-default keys so signing/configuration do not change unnecessarily. Internal Clicky class names and backend environment keys remain compatible with the existing handoff.

# macOS agent handoff: build and test HeyCoach

You are the coding agent on the teammate's Mac. This document is self-contained; you do not need the originating chat or its Windows filesystem. Your immediate job is to get this native app building and verify the Mac interaction pipeline, then connect the team's backend when it is ready. A successful build alone does not verify AI functionality.

## Start here: instructions for the Mac agent

1. Locate the repository root containing this file and `leanring-buddy.xcodeproj`. Read root `AGENTS.md` and `leanring-buddy/AGENTS.md` before editing. Run `git status --short` and preserve existing teammate changes.
2. Check macOS with `sw_vers -productVersion` and the active developer directory with `xcode-select -p`. Confirm Xcode is installed and launch it with `open -a Xcode`; finish GUI onboarding if needed. Do not run `xcodebuild`, including for version checks.
3. Inspect the current files rather than assuming the status table below is still current. Search for placeholder URLs, inspect the provider factory and Worker routes, and identify whether teammates have already added Gemma/DigitalOcean support.
4. Open the project with `open leanring-buddy.xcodeproj`. Use Xcode GUI to select the scheme, resolve packages, configure signing, build, and run. Ask the human only for account sign-in, signing-team selection when ambiguous, and macOS permission prompts that need their interaction.
5. Work through the acceptance checklist below. Report build, permissions, voice input, backend, screenshots, pointing, and voice output separately as **PASS**, **FAIL**, or **BLOCKED**, with sanitized evidence. Do not describe a blocked backend as a failed native build.

Setup does not authorize publishing releases, creating paid resources, changing shared credentials, or overwriting another teammate's work. Keep changes small and explain any required source edits. Do not rename the legacy `leanring` targets. Do not upgrade dependencies or refactor unrelated code just to remove warnings.

### Team context and ownership

- We are adapting upstream Clicky as HeyCoach for a hackathon, developing together, and testing the native app on this Mac. The first milestone is general-purpose HeyCoach: capture the screen, ask a question, receive a Gemma answer, and verify pointing. Student-specific features come later; do not add them during baseline setup.
- Gemma and DigitalOcean are the priority platforms. Snowflake is lower priority; the originating agent uses its Browser UI because MCP did not work. Do not assume your Mac agent has those connections or credentials.
- The Windows-side agent verified a direct hosted Gemma text request, but has not built the native app. Your Mac build and runtime checks are essential.
- First inspect what is already implemented. If Gemma/backend changes are absent, finish the native baseline and report the backend dependency to the team. Do not silently deploy the upstream Cloudflare/Claude alternative or duplicate another teammate's backend work.
- Never ask anyone to paste credentials into an agent conversation. Use a local secret-input mechanism, environment configuration, or the deployment platform's secret store. Log variable names and whether they are set, never their values.

### Files to inspect

All paths below are relative to this repository root:

| Path | What the Mac agent should verify |
| --- | --- |
| `leanring-buddy.xcodeproj` | App scheme, signing, package resolution and macOS destination |
| `leanring-buddy/leanring_buddyApp.swift` | Menu-bar app entry point; absence of a Dock window is intentional |
| `leanring-buddy/CompanionManager.swift` | `workerBaseURL`, model selection, prompt, request lifecycle and pointing tags |
| `leanring-buddy/ClaudeAPI.swift` | Existing Anthropic-shaped request/stream contract, even if backend uses Gemma |
| `leanring-buddy/Info.plist` | `VoiceTranscriptionProvider`, privacy descriptions and upstream updater configuration |
| `leanring-buddy/BuddyTranscriptionProvider.swift` | Available providers and fallback behavior |
| `leanring-buddy/AssemblyAIStreamingTranscriptionProvider.swift` | Separate token proxy URL for voice input |
| `leanring-buddy/CompanionScreenCaptureUtility.swift` | Screenshot capture, multi-monitor labeling and permissions |
| `leanring-buddy/OverlayWindow.swift` | Pointer animation and screenshot-to-display coordinates |
| `worker/src/index.ts` | Actual implemented routes/providers; do not assume Gemma is wired |

### Backend coordination contract

The frozen contract for the Gemma backend is `tasks/contract.md`. It covers the auth header, limits, error shapes, ownership, and the local `defaults write` setup for `ClickyBackendBaseURL` and `ClickyAppToken`. Never commit the token. Get its value from the team's password manager, not from chat.

Ask the backend teammate for the HTTPS base URL, ready routes, model/provider in use, and any required app authentication method. These are non-secret configuration details. The existing app expects:

```text
POST /chat
  Existing input: Anthropic-style system + messages, including base64 image blocks.
  Streaming output: SSE data events containing
    {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
  Nonstreaming output:
    {"content":[{"type":"text","text":"..."}]}

POST /tts
  Existing ElevenLabs audio path; verify backend implementation before claiming voice works.

POST /transcribe-token
  Needed only when AssemblyAI input is selected.
```

Preserve `[POINT:x,y:label:screenN]` output tags and the client's expected coordinate conventions. A Gemini endpoint is not a drop-in URL for `ClaudeAPI.swift`; the backend must translate requests and responses, or the client must be deliberately updated. Keep `GEMINI_API_KEY` on the backend.

The verified model is `gemma-4-26b-a4b-it`. A separate text-only test returned HTTP 200 and `GEMMA_CONNECTION_OK`. This establishes neither screenshot accuracy nor compatibility with this client's SSE parser. Verify both on the Mac.

### Completion report template

```text
Commit/branch tested:
macOS / Xcode:
Build and menu-bar launch: PASS / FAIL / BLOCKED — evidence
Permissions and voice transcription: PASS / FAIL / BLOCKED — evidence
Backend HTTPS connection and provider/model: PASS / FAIL / BLOCKED — evidence
Screenshot -> streamed answer: PASS / FAIL / BLOCKED — evidence
Pointer target on the correct display: PASS / FAIL / BLOCKED — evidence
Spoken response: PASS / FAIL / BLOCKED — evidence
Files changed:
Remaining blocker and responsible teammate:
Next concrete action:
```

Use harmless demo content. Include the first relevant sanitized error and reproduction steps for failures. Do not claim tests were run when they were only inspected.

## Current state

This checkout is the MIT-licensed macOS Clicky source, based on [farzaa/clicky](https://github.com/farzaa/clicky). Keep the upstream LICENSE and attribution when publishing our changes.

| Component | Current status |
| --- | --- |
| Native menu-bar app | Existing SwiftUI/AppKit implementation; not yet built on our teammate's Mac |
| Chat backend | Existing Cloudflare Worker calls Anthropic; URLs in the app are placeholders |
| Gemma 4 | Direct text API test passed separately; not integrated into this source yet |
| DigitalOcean | Plugin/account access verified; backend not ported or deployed yet |
| Snowflake | Browser SQL verified; app integration pending, lower priority |

The intended hackathon backend uses hosted `gemma-4-26b-a4b-it` and DigitalOcean. Do not download model weights onto the Mac. Gemma screenshot input, streaming compatibility, and pointing accuracy still need testing.

## 1. Prepare the Mac

- macOS **14.2 or newer**.
- **Xcode 15 or newer**, compatible with the installed macOS. Launch Xcode once and finish its component installation.
- Git and an Apple account for Xcode signing.
- Node.js/npm only if this teammate will run the existing Worker locally; not needed just to build the Swift app.

Windows teammates can edit source and backend code, but this native app must be built and tested on a Mac.

## 2. Clone our team repository

After the team pushes the source to the repository:

```bash
git clone https://github.com/omariomari2/hacktoberfest.git
cd hacktoberfest
open leanring-buddy.xcodeproj
```

These commands assume the Clicky source is pushed at the repository root. If it is inside a `clicky/` subfolder, run `cd clicky` before `open`. If GitHub reports repository not found, check that the source has been pushed and your GitHub account has access.

Keep the existing `leanring` spelling in project, directory, and scheme names.

## 3. Build and launch in Xcode

1. Let Xcode resolve Swift package dependencies. If resolution fails, check its package-resolution errors before changing versions.
2. Select the **leanring-buddy** scheme and **My Mac** as the destination.
3. Select the app target, open **Signing & Capabilities**, and choose your development team. If signing reports a bundle-identifier collision, agree on a team-specific bundle identifier before changing it.
4. Press **Cmd+R**. Look for the app's icon in the **menu bar**, not the Dock.
5. Open the companion panel and check the permissions it requests.

Use Xcode's interface to build and run. The repository's `AGENTS.md` explicitly forbids terminal `xcodebuild` because it can disrupt screen/accessibility permission setup. Do not spend hackathon time fixing the documented non-blocking Swift concurrency or deprecated `onChange` warnings.

## 4. Grant permissions and test the shell

In **System Settings > Privacy & Security**, allow the development app when prompted:

- **Microphone** for push-to-talk.
- **Accessibility** for the global shortcut.
- **Screen Recording / Screen & System Audio Recording** for screen capture; wording varies by macOS.
- **Speech Recognition** if using the Apple Speech provider.

Quit and reopen the app if macOS requests it after a permission change. Recheck permissions after changing the app's signing identity or bundle identifier.

Open an innocuous test window, then try the default **Control+Option** push-to-talk shortcut. The shell and permission UI can be checked before the backend is ready. A failed AI request while placeholder URLs remain is expected; it does not prove the Mac build is broken. Use demo content rather than private messages or personal documents for screenshot tests.

## 5. Connect the backend

### Planned hackathon path: Gemma + DigitalOcean

This path still requires implementation. The backend teammate must:

1. Adapt the existing `/chat` route to call Gemini API with `gemma-4-26b-a4b-it`, including screenshot image data.
2. Preserve the response format expected by `ClaudeAPI.swift`, including streamed text deltas and `[POINT:x,y:label:screenN]` tags, or update the Swift client alongside it.
3. Add a server entry point for DigitalOcean and deploy an HTTPS service. The current `worker/package.json` only runs Wrangler; it is not a ready Node production server.
4. Configure `GEMINI_API_KEY` as a backend secret. Never put it in Swift, Info.plist, Git, screenshots, or chat. Free-tier text access was tested; quota remains limited.
5. Share the deployed backend's public base URL with the Mac teammate, then test a real screenshot-to-response interaction.

Once a compatible HTTPS backend is ready, replace the placeholder URLs in:

| File | Setting |
| --- | --- |
| `leanring-buddy/CompanionManager.swift` | `workerBaseURL`; used for `/chat` and `/tts` |
| `leanring-buddy/AssemblyAIStreamingTranscriptionProvider.swift` | `tokenProxyURL`; must end in `/transcribe-token` if using AssemblyAI |

Gemma chat does not automatically replace speech services. Current voice input defaults to AssemblyAI, and voice output uses ElevenLabs. Those routes need their own configuration, or an explicitly implemented fallback.

`leanring-buddy/Info.plist` sets `VoiceTranscriptionProvider` to `assemblyai`. The existing provider factory also supports `apple` for Apple Speech input; test its permissions and behavior on the Mac before relying on it. This changes input transcription only, not ElevenLabs voice output.

### Optional upstream baseline: existing Cloudflare Worker

Use this only if the team deliberately chooses to test the original providers before the Gemma port. It requires separate Anthropic, AssemblyAI, and ElevenLabs accounts/keys; the Gemma key cannot replace `ANTHROPIC_API_KEY` in the existing code.

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ASSEMBLYAI_API_KEY
npx wrangler secret put ELEVENLABS_API_KEY
```

Set your ElevenLabs voice ID in `worker/wrangler.toml`, then deploy with `npx wrangler deploy`. Use the resulting HTTPS URL in the two Swift settings above. This is an alternative baseline, not our completed DigitalOcean deployment. Check provider pricing before use.

For local Worker development, `npx wrangler dev` reads secrets from `worker/.dev.vars`, which is already ignored by Git. A server running on a Windows teammate's `localhost` is not reachable as `localhost` from the Mac. Prefer a shared HTTPS backend for the demo; HTTP development endpoints may need additional macOS networking configuration.

## Handoff checklist

- [ ] Xcode builds and the menu-bar panel opens.
- [ ] Permissions and push-to-talk work on the demo Mac.
- [ ] App URLs point at the agreed HTTPS backend.
- [ ] A real screenshot gets a Gemma response and a sensible pointer target.
- [ ] The public repository includes LICENSE, attribution, and instructions; no credentials are committed.

When reporting a blocker, share the failing step and sanitized Xcode/backend error, not an API key. A packaged `.app` can be opened without Xcode after building; distributing it to other Macs may require signing/notarization work beyond this development setup.


HeyCoach branding: upstream update-feed URL and signing key are removed; automatic updating remains disabled until the team publishes its own signed releases. Existing bundled demonstration media is inherited from upstream and is not a HeyCoach demo.
