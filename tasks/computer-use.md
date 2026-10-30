# Computer use: first slice (branch `feature/computer-use`)

Coach can now perform **one left, double or right click per request**. It only clicks after the user says "yes", and the feature is **off by default**.

## How it works

1. The user asks Coach to do something ("open the downloads folder for me").
2. When computer use is enabled, the model ends its answer with `[CLICK:left|double|right:x,y:label(:screenN)]` instead of a `[POINT:…]` tag. If it adds a `[POINT:…]` tag right after the click tag anyway, the click still counts. A click tag followed by more prose is never acted on. Any leftover `[CLICK:…]` or `[POINT:…]` text is removed before Coach speaks or saves the answer to history.
3. The blue cursor flies to the target. Its bubble shows something like "double-click report pdf? say yes", and Coach adds "say yes to confirm." to its spoken answer.
4. The user holds push-to-talk and says "yes", "do it", "go ahead", "click it" and so on. "Hey coach" and "please" around those words are fine. The whole utterance must be a confirmation; "yes but what does it do" counts as a new question.
5. Coach moves the real mouse to the target and clicks, then says "done, i double-clicked report pdf." If the click is refused, it says why.

The pending click is discarded without clicking if:
- the user says anything else (which is handled as a normal question),
- 20 seconds pass after Coach finishes speaking the question (the window restarts when speech ends, so a long answer doesn't use it up),
- computer use was turned off before the user said "yes" (the "yes" is then handled as a normal question), or
- the app stops.

## Safety checks before every click

- Accessibility permission must be granted. The app already requests it.
- The target must be on a connected display. Converted points are kept one point inside the display's top and right edges, so menu-bar targets (screenshot y = 0) are not refused as off-screen.
- The element under the target is identified with the Accessibility API at click time. Coach's own overlay windows are taken off screen for about 50 ms while this hit test runs, so the check sees the real app underneath.
- The check **fails closed**. The click is refused with "i couldn't check what's under that spot, so i didn't click." if the hit test fails, times out, still lands on one of Coach's own windows, the element's process can't be identified, or its subrole can't be read.
- Each Accessibility request has a 1 second timeout (the default is about 6 seconds), so a hung app can't freeze Coach. A timeout refuses the click.
- Password fields are refused.
- Sensitive apps are refused: System Settings (including its pane extension processes, bundle IDs starting with `com.apple.settings.` or `com.apple.systempreferences.`), Keychain Access, Passwords, system authentication dialogs, 1Password and Bitwarden.
- At most one click per model answer. There are no chained steps.

## Files

| File | What it does |
| --- | --- |
| `leanring-buddy/ComputerUseActions.swift` | Pure logic: tag parsing and stray-tag removal, confirmation matching, the pending click with its expiry and restart, the sensitive-app list, coordinate conversion |
| `leanring-buddy/ComputerUseClickExecutor.swift` | Safety checks and posting the CGEvent clicks; double-click uses click state 2 |
| `leanring-buddy/CompanionManager.swift` | Opt-in setting, prompt addition, parsing `[CLICK:…]`, the confirmation step, spoken result. The screenshot→screen conversion moved to `ScreenCoordinateConversion`, which the pointing flow and the onboarding demo both use |
| `leanring-buddy/OverlayWindow.swift` | `temporarilyHideOverlayWindows()` / `restoreTemporarilyHiddenOverlayWindows()` used around the Accessibility hit test |
| `leanring-buddyTests/ComputerUseTests.swift` | Swift Testing tests for the pure logic |

## Verified on Windows (not the Mac)

`ComputerUseActions.swift` and the refusal enum were compiled with Swift 6.4.2 on Windows, using `-default-isolation MainActor` (as in the project) and `-warnings-as-errors`. Both Swift 5 and Swift 6 language modes compiled with no warnings, and a harness passed every case in `ComputerUseTests.swift`. That check found and fixed one real problem: main-actor-isolated `Equatable` conformances. The pure types are now `nonisolated`.

After the PR #3 review fixes, the same check was repeated: `ComputerUseActions.swift`, the refusal enum, and a verbatim copy of `CompanionManager.parsePointingCoordinates` compiled with no warnings in both language modes, and a harness mirroring every case in `ComputerUseTests.swift` (74 checks) passed in both. The checks cover the click tag followed by `[POINT:none]`, stray-tag removal, menu-bar coordinates staying inside the display, the confirmation-window restart and the System Settings extension prefixes.

`ComputerUseClickExecutor` (AppKit, Accessibility, CGEvent), the `OverlayWindowManager` additions and the `CompanionManager` changes **could not be compiled on Windows**. They were reviewed by hand only.

## Mac teammate: build and test

Build and run through the Xcode GUI only, as before. Do not use terminal `xcodebuild`.

1. **Build** the `leanring-buddy` scheme (Cmd+B), then run the tests (Cmd+U). `ComputerUseTests` should pass.
2. **Check that it's off by default.** Run the app and ask "click the finder icon in the dock". Coach should only point, with no confirmation question.
3. **Turn it on**, then restart Coach:
   ```bash
   defaults write com.yourcompany.leanring-buddy isComputerUseEnabled -bool true
   ```
   Turn it off again with `-bool false`. The bundle ID must match the one in Xcode signing.
4. **Single click:** open Finder and say "click downloads in the sidebar for me". Confirm the cursor and bubble appear, then say "yes". Downloads should open.
5. **Double click:** say "double click <some file> for me", then "yes". The file should open.
6. **Right click:** say "right click the desktop", then "yes". The context menu should appear.
7. **Cancel:** ask for a click, then say "wait, what is that?". There should be no click, and Coach should answer the question.
8. **Expiry:** ask for a click, wait until Coach **finishes speaking**, then wait more than 20 seconds and say "yes". There should be no click. Also check that saying "yes" about 15 seconds after Coach finishes still clicks, even when the spoken answer was long.
9. **Refusals:**
   - With System Settings open, ask Coach to click something inside a settings pane (for example Privacy & Security) and say "yes". Coach should refuse out loud.
   - On a web page login form, ask Coach to click the password field and say "yes". Coach should say it won't. **If it clicks anyway, report it.**
   - Watch the blue cursor when you say "yes": it should disappear for a split second during the check and then come back. If every click is refused with "i couldn't check what's under that spot", hiding the overlay isn't working; report it with the `🖱️ Click refused` console line.
10. **Menu bar:** with the cursor shown, ask Coach to "click the apple menu for me" and say "yes". The Apple menu should open. Before this fix it was refused as off-screen.
11. **Tag leakage:** in the Xcode console, every `🖱️ Click proposed` reply should be spoken without any bracketed `[CLICK:` or `[POINT:` text.
12. **Turned off while waiting:** ask for a click, run `defaults write com.yourcompany.leanring-buddy isComputerUseEnabled -bool false`, then say "yes". There should be no click, and Coach should answer "yes" as a normal question. The console should show `🖱️ Pending click discarded (… computer use enabled: false)`. If the running app doesn't see the `defaults write` change in time, mark this step BLOCKED rather than FAIL.
13. **Multiple displays:** if a second display is connected, ask for a click on it and check that the click lands on the right spot.

Please report each step as PASS, FAIL or BLOCKED, with the console lines starting with `🖱️`.

## Not in this slice (next steps)

- Snapping the click to the nearest Accessibility element to correct model coordinates that are a few pixels off.
- A toggle in the menu-bar panel instead of `defaults write`.
- A key to cancel a pending click immediately.
- Multi-step tasks that re-screenshot after each click.
