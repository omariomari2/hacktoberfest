# Text input: type instead of talk (branch `feature/text-input`)

Press **option + space** anywhere to open a small text box. Type an instruction, then press **Enter** to send it to Coach. **Esc**, clicking elsewhere, or pressing option + space again closes it. Push-to-talk (`ctrl + option`) works exactly as before.

## How it works

- The box appears Spotlight-style on the screen the mouse is on. It takes keyboard focus without activating Coach, so your app stays frontmost and gets focus back when the box closes.
- On Enter, the box hides first so it isn't in the screenshot, then the text goes through the same pipeline as a voice transcript: screenshot, model, pointing, spoken answer. Typed and spoken turns share one conversation history.
- Opening the box behaves like pressing push-to-talk: it stops any answer being spoken, clears the old pointer target, and closes the menu bar panel.
- If the "Show Clicky" cursor is off, the cursor appears for the answer and fades out afterwards, as with voice.
- The box only opens after onboarding is finished, all permissions are granted, and no recording is in progress. Otherwise the hotkey beeps.

**Why option + space:** push-to-talk fires as soon as ctrl and option are both held, so any ctrl + option + key hotkey would also start a recording. The hotkey is registered with macOS's global-hotkey API (`RegisterEventHotKey`), so the keystroke doesn't also type into your app. To change it, edit the three constants at the top of `TextInputHotKeyMonitor.swift`. A test checks that it never includes both ctrl and option.

**Known conflict:** apps like ChatGPT, Raycast or Alfred may already use option + space. If so, macOS gives the hotkey to whichever app registered it first. Coach logs `⚠️ Text input hotkey: couldn't register…` when registration fails, but some conflicts can't be detected from Coach's side.

## Files

| File | What it does |
| --- | --- |
| `leanring-buddy/TextInputHotKeyMonitor.swift` | Registers the global hotkey with Carbon and calls back on the main thread |
| `leanring-buddy/TextInputPanelManager.swift` | The non-activating panel, its SwiftUI text field, positioning, and closing on Esc or a click elsewhere |
| `leanring-buddy/CompanionManager.swift` | `canAcceptTypedInstruction`, `prepareForTypedInstruction()`, `submitTypedInstruction(_:)` |
| `leanring-buddy/leanring_buddyApp.swift` | Creates the manager and starts the hotkey at launch |
| `leanring-buddyTests/TextInputTests.swift` | Checks that the hotkey can't clash with push-to-talk |

## Verification so far

Not compiled. This feature is all AppKit, SwiftUI and Carbon, none of which is available on Windows. Every API signature and concurrency annotation was checked by hand against the macOS SDK. The first real build is on the Mac.

## Mac teammate: build and test

Build and run through the Xcode GUI only. Do not use `xcodebuild`.

1. **Build** (Cmd+B) and run the tests (Cmd+U). `TextInputTests` should pass. The console should show `⌨️ Text input hotkey registered: option + space`.
2. **Open and close:** with Safari or Notes frontmost, press option + space. The box should appear near the top centre, ready for typing. Esc should close it, and your app should still be frontmost. Repeat, closing it by clicking elsewhere, then by pressing option + space again.
3. **No stray characters:** with the cursor in a Notes document, press option + space. No space or non-breaking space should be typed into Notes.
4. **Ask by typing:** type "what's on my screen?" and press Enter. The box should disappear and Coach should answer aloud, with no box in the screenshot.
5. **Pointing:** type "where is the share button?" and press Enter. The blue cursor should fly to it.
6. **Mixed conversation:** ask something by voice, then type a follow-up that refers to it, such as "explain that more". Coach should remember the voice turn.
7. **Interrupt:** while Coach is speaking, press option + space. The speech should stop.
8. **Multiple displays:** move the mouse to the other display and press option + space. The box should appear on that display.
9. **Hotkey conflict:** if another app owns option + space, note what happens and report it.

Report each step as PASS, FAIL or BLOCKED, with the console lines starting with `⌨️`.

## Next steps (not in this slice)

- Quiet mode: show Coach's answer as text under the box instead of speaking it, for libraries and classrooms.
- A setting for choosing the hotkey.
- Once computer use (PR #3) is merged, typing "yes" confirms a pending click with no extra work, because confirmation is checked in the same function.

## Review fixes

Typed answers now fall back to the retained macOS speech synthesizer when ElevenLabs fails (including the deployed backend returning 503). This speaks the actual model answer. Opening the composer or starting push-to-talk stops fallback speech. App shutdown also stops it; transient hiding waits for local speech to finish.

Opening the composer now clears the cancelled response task and resets voice state. Escape, shortcut-toggle and outside-click dismissal restore the transient hide lifecycle; sending does not schedule a competing hide timer.

Required Mac regression checks (not runnable on Windows):
1. Leave ElevenLabs unset; type a question and verify the actual answer is spoken by the macOS voice, not a credits error.
2. While Gemma is processing, open the composer and press Escape: spinner clears and transient cursor fades normally.
3. Repeat cancellation by outside click and Option+Space.
4. Start push-to-talk or reopen the composer during native fallback speech: speech stops immediately.
5. Submit a question: composer hides before capture and the overlay stays through the answer.

No native build or runtime pass is claimed until these checks run on the Mac through Xcode.

## Combined integration review

Text input, HeyCoach branding and computer use have been combined. Composer dismissal observes push-to-talk transitions, submission rechecks readiness, local/global clicks dismiss it, and typed input/answers are excluded from raw analytics. Click proposals snapshot the actual Accessibility element and geometry; execution refuses when identity or geometry changes. Lookup failures remain refusals. Computer use stays off by default.

Verification on Windows: backend 49/49 tests and TypeScript checks pass; plist/feed XML and product/module/test-host checks pass. Native Xcode compilation and keyboard/audio/Accessibility execution remain unverified; use the Mac GUI test checklists before enabling computer use for the demo. Existing Wrangler dev dependencies have audit findings; the deployed Node backend has no runtime npm dependencies.
