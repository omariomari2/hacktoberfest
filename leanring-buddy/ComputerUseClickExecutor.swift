//
//  ComputerUseClickExecutor.swift
//  leanring-buddy
//
//  Performs a single confirmed mouse click (left, double or right) by
//  posting CGEvents, after safety checks. Posting synthetic mouse events
//  requires the Accessibility permission the app already asks for.
//

import AppKit
import ApplicationServices
import CoreGraphics

/// Why a confirmed click was not performed. Each case has a sentence that
/// is spoken back to the user, so they know nothing was clicked.
nonisolated enum ComputerUseClickRefusal: Error, Equatable {
    case accessibilityPermissionMissing
    case targetOutsideAllDisplays
    case secureTextFieldAtTarget
    case sensitiveApplicationAtTarget(applicationName: String)
    case mouseEventCreationFailed

    var spokenExplanation: String {
        switch self {
        case .accessibilityPermissionMissing:
            return "i can't click without accessibility permission, so i didn't click anything."
        case .targetOutsideAllDisplays:
            return "that spot isn't on any of your screens anymore, so i didn't click."
        case .secureTextFieldAtTarget:
            return "that's a password field, so i won't click it for you."
        case .sensitiveApplicationAtTarget(let applicationName):
            return "i don't click inside \(applicationName), so you'll want to do that one yourself."
        case .mouseEventCreationFailed:
            return "something went wrong creating the click, so nothing was clicked."
        }
    }
}

enum ComputerUseClickExecutor {

    /// Apps where an accidental click could change security or privacy
    /// settings, reveal credentials, or approve an authentication prompt.
    static let sensitiveApplicationBundleIdentifiers: Set<String> = [
        "com.apple.systempreferences",      // System Settings
        "com.apple.keychainaccess",         // Keychain Access
        "com.apple.Passwords",              // Passwords (macOS 15+)
        "com.apple.SecurityAgent",          // System authentication dialogs
        "com.1password.1password",
        "com.agilebits.onepassword7",
        "com.bitwarden.desktop",
    ]

    /// Short pauses between synthetic events. Some apps ignore a mouse-down
    /// that arrives in the same instant as the move, and double-clicks need
    /// two distinct click pairs.
    private static let delayAfterMovingCursorInNanoseconds: UInt64 = 60_000_000
    private static let delayBetweenDoubleClickPairsInNanoseconds: UInt64 = 40_000_000

    /// Moves the real mouse cursor to the target and performs the click.
    /// Throws a ComputerUseClickRefusal (without clicking) if any safety check fails.
    static func performClick(
        clickKind: ComputerUseClickKind,
        atAppKitGlobalLocation appKitGlobalLocation: CGPoint
    ) async throws {
        guard AXIsProcessTrusted() else {
            throw ComputerUseClickRefusal.accessibilityPermissionMissing
        }

        let isTargetOnAConnectedDisplay = NSScreen.screens.contains { screen in
            screen.frame.contains(appKitGlobalLocation)
        }
        guard isTargetOnAConnectedDisplay,
              let primaryDisplayHeightInPoints = NSScreen.screens.first?.frame.height else {
            throw ComputerUseClickRefusal.targetOutsideAllDisplays
        }

        let coreGraphicsLocation = ScreenCoordinateConversion.coreGraphicsGlobalLocation(
            fromAppKitGlobalLocation: appKitGlobalLocation,
            primaryDisplayHeightInPoints: primaryDisplayHeightInPoints
        )

        if let refusal = refusalForElementAtTarget(coreGraphicsLocation: coreGraphicsLocation) {
            throw refusal
        }

        let eventSource = CGEventSource(stateID: .hidSystemState)

        try postMouseEvent(type: .mouseMoved, button: .left, clickState: 0, at: coreGraphicsLocation, eventSource: eventSource)
        try await Task.sleep(nanoseconds: delayAfterMovingCursorInNanoseconds)

        switch clickKind {
        case .left:
            try postMouseEvent(type: .leftMouseDown, button: .left, clickState: 1, at: coreGraphicsLocation, eventSource: eventSource)
            try postMouseEvent(type: .leftMouseUp, button: .left, clickState: 1, at: coreGraphicsLocation, eventSource: eventSource)
        case .double:
            // macOS only treats the second pair as a double-click when its
            // click state is 2; two pairs with click state 1 are two single clicks.
            try postMouseEvent(type: .leftMouseDown, button: .left, clickState: 1, at: coreGraphicsLocation, eventSource: eventSource)
            try postMouseEvent(type: .leftMouseUp, button: .left, clickState: 1, at: coreGraphicsLocation, eventSource: eventSource)
            try await Task.sleep(nanoseconds: delayBetweenDoubleClickPairsInNanoseconds)
            try postMouseEvent(type: .leftMouseDown, button: .left, clickState: 2, at: coreGraphicsLocation, eventSource: eventSource)
            try postMouseEvent(type: .leftMouseUp, button: .left, clickState: 2, at: coreGraphicsLocation, eventSource: eventSource)
        case .right:
            try postMouseEvent(type: .rightMouseDown, button: .right, clickState: 1, at: coreGraphicsLocation, eventSource: eventSource)
            try postMouseEvent(type: .rightMouseUp, button: .right, clickState: 1, at: coreGraphicsLocation, eventSource: eventSource)
        }
    }

    private static func postMouseEvent(
        type mouseEventType: CGEventType,
        button mouseButton: CGMouseButton,
        clickState: Int64,
        at coreGraphicsLocation: CGPoint,
        eventSource: CGEventSource?
    ) throws {
        guard let mouseEvent = CGEvent(
            mouseEventSource: eventSource,
            mouseType: mouseEventType,
            mouseCursorPosition: coreGraphicsLocation,
            mouseButton: mouseButton
        ) else {
            throw ComputerUseClickRefusal.mouseEventCreationFailed
        }
        mouseEvent.setIntegerValueField(.mouseEventClickState, value: clickState)
        mouseEvent.post(tap: .cghidEventTap)
    }

    /// Uses the Accessibility API to look at what is actually under the
    /// target point right now, and refuses password fields and sensitive apps.
    private static func refusalForElementAtTarget(coreGraphicsLocation: CGPoint) -> ComputerUseClickRefusal? {
        let systemWideAccessibilityElement = AXUIElementCreateSystemWide()
        var elementAtTarget: AXUIElement?
        let elementLookupResult = AXUIElementCopyElementAtPosition(
            systemWideAccessibilityElement,
            Float(coreGraphicsLocation.x),
            Float(coreGraphicsLocation.y),
            &elementAtTarget
        )

        var targetProcessIdentifier: pid_t = 0
        if elementLookupResult == .success, let elementAtTarget {
            var subroleValue: CFTypeRef?
            let subroleLookupResult = AXUIElementCopyAttributeValue(
                elementAtTarget,
                kAXSubroleAttribute as CFString,
                &subroleValue
            )
            if subroleLookupResult == .success,
               let subrole = subroleValue as? String,
               subrole == kAXSecureTextFieldSubrole {
                return .secureTextFieldAtTarget
            }
            AXUIElementGetPid(elementAtTarget, &targetProcessIdentifier)
        }

        // Our own overlay sits above everything (click-through), so if the
        // hit test lands on our process, judge by the frontmost app instead.
        let isTargetOurOwnProcess = targetProcessIdentifier == ProcessInfo.processInfo.processIdentifier
        let targetApplication: NSRunningApplication? = (targetProcessIdentifier != 0 && !isTargetOurOwnProcess)
            ? NSRunningApplication(processIdentifier: targetProcessIdentifier)
            : NSWorkspace.shared.frontmostApplication

        if let targetBundleIdentifier = targetApplication?.bundleIdentifier,
           sensitiveApplicationBundleIdentifiers.contains(targetBundleIdentifier) {
            let applicationName = targetApplication?.localizedName ?? "that app"
            return .sensitiveApplicationAtTarget(applicationName: applicationName)
        }

        return nil
    }
}
