//
//  TextInputTests.swift
//  leanring-buddyTests
//
//  Guards the text-input hotkey choice against clashing with push-to-talk.
//

import Carbon.HIToolbox
import CoreGraphics
import Testing
@testable import leanring_buddy

@MainActor
struct TextInputTests {

    /// Push-to-talk starts as soon as ctrl + option are both held, so a
    /// text-input hotkey containing both would also start a voice recording.
    @Test func textInputHotKeyDoesNotIncludeBothControlAndOption() {
        let controlAndOptionCarbonFlags = UInt32(controlKey) | UInt32(optionKey)
        let textInputModifierFlags = TextInputHotKeyMonitor.hotKeyCarbonModifierFlags

        #expect(textInputModifierFlags & controlAndOptionCarbonFlags != controlAndOptionCarbonFlags)
    }

    @Test func textInputHotKeyUsesAtLeastOneModifier() {
        // A bare key would be stolen from every app the user types in.
        #expect(TextInputHotKeyMonitor.hotKeyCarbonModifierFlags != 0)
    }
    @Test func whitespaceSubmissionDoesNotStartAnInteraction() {
        let manager = CompanionManager()
        manager.prepareForTypedInstruction()
        manager.submitTypedInstruction("   ")
        #expect(manager.lastTranscript == nil)
        #expect(manager.voiceState == .idle)
    }

    @Test func composerCancellationClearsPointerAndLeavesIdleState() {
        let manager = CompanionManager()
        manager.detectedElementScreenLocation = CGPoint(x: 20, y: 30)
        manager.prepareForTypedInstruction()
        manager.cancelTypedInstruction()
        #expect(manager.detectedElementScreenLocation == nil)
        #expect(manager.voiceState == .idle)
    }
}
