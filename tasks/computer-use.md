# Computer use: first slice (branch `feature/computer-use`)

Coach can now perform **one left, double or right click per request**. It only clicks after the user says "yes", and the feature is **off by default**.

## How it works

1. The user asks Coach to do something ("open the downloads folder for me").
2. When computer use is enabled, the model ends its answer with `[CLICK:left|double|right:x,y:label(:screenN)]` instead of a `[POINT:…]` tag.
3. The blue cursor flies to the target. Its bubble shows something like "double-click report pdf? say yes", and Coach adds "say yes to confirm." to its spoken answer.
4. The user holds push-to-talk and says "yes", "do it", "go ahead", "click it" and so on. "Hey coach" and "please" around those words are fine. The whole utterance must be a confirmation; "yes but what does it do" counts as a new question.
5. Coach moves the real mouse to the target and clicks, then says "done, i double-clicked report pdf." If the click is refused, it says why.

The pending click is discarded without clicking if:
- the user says anything else (which is handled as a normal question),
- 20 seconds pass, or
- the app stops.

## Safety checks before every click

- Accessibility permission must be granted. The app already requests it.
- The target must be on a connected display.
- Password fields are refused. This is detected through the Accessibility API at click time.
- Sensitive apps are refused: System Settings, Keychain Access, Passwords, system authentication dialogs, 1Password and Bitwarden.
- At most one click per model answer. There are no chained steps.

## Files

| File | What it does |
| --- | --- |
| `leanring-buddy/ComputerUseActions.swift` | Pure logic: tag parsing, confirmation matching, the pending click and its expiry, coordinate conversion |
| `leanring-buddy/ComputerUseClickExecutor.swift` | Safety checks and posting the CGEvent clicks; double-click uses click state 2 |
| `leanring-buddy/CompanionManager.swift` | Opt-in setting, prompt addition, parsing `[CLICK:…]`, the confirmation step, spoken result. The screenshot→screen conversion moved to `ScreenCoordinateConversion` (same math) |
| `leanring-buddyTests/ComputerUseTests.swift` | Swift Testing tests for the pure logic |

## Verified on Windows (not the Mac)

`ComputerUseActions.swift` and the refusal enum were compiled with Swift 6.4.2 on Windows, using `-default-isolation MainActor` (as in the project) and `-warnings-as-errors`. Both Swift 5 and Swift 6 language modes compiled with no warnings, and a harness passed every case in `ComputerUseTests.swift`. That check found and fixed one real problem: main-actor-isolated `Equatable` conformances. The pure types are now `nonisolated`.

`ComputerUseClickExecutor` (AppKit, Accessibility, CGEvent) and the `CompanionManager` changes **could not be compiled on Windows**. They were reviewed by hand only.

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
8. **Expiry:** ask for a click, wait more than 20 seconds, then say "yes". There should be no click.
9. **Refusals:**
   - With System Settings open, ask Coach to click something there and say "yes". Coach should refuse out loud.
   - On a web page login form, ask Coach to click the password field and say "yes". Coach should say it won't. **If it clicks anyway, report it.** The likely cause is that the Accessibility hit-test returned Coach's own click-through overlay instead of the browser.
10. **Multiple displays:** if a second display is connected, ask for a click on it and check that the click lands on the right spot.

Please report each step as PASS, FAIL or BLOCKED, with the console lines starting with `🖱️`.

## Not in this slice (next steps)

- Snapping the click to the nearest Accessibility element to correct model coordinates that are a few pixels off.
- A toggle in the menu-bar panel instead of `defaults write`.
- A key to cancel a pending click immediately.
- Multi-step tasks that re-screenshot after each click.
