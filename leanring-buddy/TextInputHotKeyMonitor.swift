//
//  TextInputHotKeyMonitor.swift
//  leanring-buddy
//
//  Registers the system-wide hotkey that opens the text-input box (option +
//  space by default). Uses Carbon's RegisterEventHotKey instead of the
//  listen-only CGEvent tap that push-to-talk uses, because a registered
//  hotkey is consumed by macOS — the keystroke doesn't also type a
//  non-breaking space into whatever app the user is in.
//
//  The hotkey deliberately does not include both control and option:
//  push-to-talk fires as soon as ctrl + option are held, so any ctrl +
//  option + key combination would also start a voice recording.
//

import AppKit
import Carbon.HIToolbox

final class TextInputHotKeyMonitor {

    /// Virtual key code and Carbon modifier mask for the hotkey. Change both
    /// together (and `hotKeyDisplayText`) to move the shortcut.
    static let hotKeyVirtualKeyCode = UInt32(kVK_Space)
    static let hotKeyCarbonModifierFlags = UInt32(optionKey)
    static let hotKeyDisplayText = "option + space"

    /// Four-character signature ('COAC') that identifies hotkeys registered
    /// by this app, so the handler ignores anyone else's hotkey events.
    nonisolated private static let hotKeySignature: OSType = 0x434F_4143
    nonisolated private static let hotKeyIdentifierNumber: UInt32 = 1

    private let onHotKeyPressed: () -> Void
    private var registeredHotKeyReference: EventHotKeyRef?
    private var installedEventHandlerReference: EventHandlerRef?

    init(onHotKeyPressed: @escaping () -> Void) {
        self.onHotKeyPressed = onHotKeyPressed
    }

    deinit {
        if let registeredHotKeyReference {
            UnregisterEventHotKey(registeredHotKeyReference)
        }
        if let installedEventHandlerReference {
            RemoveEventHandler(installedEventHandlerReference)
        }
    }

    /// Installs the hotkey. Safe to call more than once; later calls do nothing.
    func start() {
        guard registeredHotKeyReference == nil else { return }

        var hotKeyPressedEventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )

        // Carbon calls this C function pointer on the main thread, so it
        // can't capture Swift context; `self` is passed through userData.
        let hotKeyEventHandler: EventHandlerUPP = { _, hotKeyEvent, userData in
            guard let hotKeyEvent, let userData else { return OSStatus(eventNotHandledErr) }

            var pressedHotKeyIdentifier = EventHotKeyID()
            let parameterStatus = GetEventParameter(
                hotKeyEvent,
                EventParamName(kEventParamDirectObject),
                EventParamType(typeEventHotKeyID),
                nil,
                MemoryLayout<EventHotKeyID>.size,
                nil,
                &pressedHotKeyIdentifier
            )
            guard parameterStatus == noErr,
                  pressedHotKeyIdentifier.signature == TextInputHotKeyMonitor.hotKeySignature,
                  pressedHotKeyIdentifier.id == TextInputHotKeyMonitor.hotKeyIdentifierNumber else {
                return OSStatus(eventNotHandledErr)
            }

            let textInputHotKeyMonitor = Unmanaged<TextInputHotKeyMonitor>
                .fromOpaque(userData)
                .takeUnretainedValue()
            MainActor.assumeIsolated {
                textInputHotKeyMonitor.onHotKeyPressed()
            }
            return OSStatus(noErr)
        }

        let handlerInstallStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            hotKeyEventHandler,
            1,
            &hotKeyPressedEventType,
            Unmanaged.passUnretained(self).toOpaque(),
            &installedEventHandlerReference
        )
        guard handlerInstallStatus == noErr else {
            print("⚠️ Text input hotkey: couldn't install event handler (status \(handlerInstallStatus))")
            return
        }

        let hotKeyIdentifier = EventHotKeyID(
            signature: Self.hotKeySignature,
            id: Self.hotKeyIdentifierNumber
        )
        let hotKeyRegistrationStatus = RegisterEventHotKey(
            Self.hotKeyVirtualKeyCode,
            Self.hotKeyCarbonModifierFlags,
            hotKeyIdentifier,
            GetApplicationEventTarget(),
            0,
            &registeredHotKeyReference
        )
        if hotKeyRegistrationStatus == noErr {
            print("⌨️ Text input hotkey registered: \(Self.hotKeyDisplayText)")
        } else {
            print("⚠️ Text input hotkey: couldn't register \(Self.hotKeyDisplayText) (status \(hotKeyRegistrationStatus)); another app may own it")
        }
    }
}
