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
    /// The Accessibility API couldn't say what is under the target (no
    /// answer, a timeout, or it only saw Coach's own windows), so the
    /// password-field and sensitive-app checks couldn't run.
    case targetElementCouldNotBeVerified
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
        case .targetElementCouldNotBeVerified:
            return "i couldn't check what's under that spot, so i didn't click."
        case .mouseEventCreationFailed:
            return "something went wrong creating the click, so nothing was clicked."
        }
    }
}

enum ComputerUseClickExecutor {
    struct VerifiedTarget {
        let element: AXUIElement
        let position: CGPoint
        let size: CGSize
    }

    static func captureVerifiedTarget(at location: CGPoint, overlayWindowManager: OverlayWindowManager) async throws -> VerifiedTarget {
        guard AXIsProcessTrusted(), let height = NSScreen.screens.first?.frame.height else {
            throw ComputerUseClickRefusal.accessibilityPermissionMissing
        }
        let point = ScreenCoordinateConversion.coreGraphicsGlobalLocation(
            fromAppKitGlobalLocation: location, primaryDisplayHeightInPoints: height
        )
        overlayWindowManager.temporarilyHideOverlayWindows()
        defer { overlayWindowManager.restoreTemporarilyHiddenOverlayWindows() }
        try await Task.sleep(nanoseconds: delayForOverlayToLeaveScreenInNanoseconds)
        let system = AXUIElementCreateSystemWide()
        var element: AXUIElement?
        guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &element) == .success,
              let element else { throw ComputerUseClickRefusal.targetElementCouldNotBeVerified }
        if let refusal = refusalForElement(element) { throw refusal }
        var positionValue: CFTypeRef?
        var sizeValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success,
              let positionValue, let sizeValue,
              CFGetTypeID(positionValue) == AXValueGetTypeID(),
              CFGetTypeID(sizeValue) == AXValueGetTypeID() else {
            throw ComputerUseClickRefusal.targetElementCouldNotBeVerified
        }
        var position = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &position),
              AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else {
            throw ComputerUseClickRefusal.targetElementCouldNotBeVerified
        }
        return VerifiedTarget(element: element, position: position, size: size)
    }


    /// Short pauses between synthetic events. Some apps ignore a mouse-down
    /// that arrives in the same instant as the move, and double-clicks need
    /// two distinct click pairs.
    private static let delayAfterMovingCursorInNanoseconds: UInt64 = 60_000_000
    private static let delayBetweenDoubleClickPairsInNanoseconds: UInt64 = 40_000_000

    /// How long to wait after taking Coach's overlay windows off screen
    /// before the Accessibility hit test. AppKit can batch window ordering
    /// until the run loop turns, so this gives the window server time to
    /// actually remove the overlay.
    private static let delayForOverlayToLeaveScreenInNanoseconds: UInt64 = 50_000_000

    /// How long one Accessibility request may wait for the target app to
    /// answer. The default is about six seconds, and these calls run on the
    /// main actor, so a beach-balling app would otherwise freeze Coach.
    /// A timed-out request refuses the click.
    private static let accessibilityMessagingTimeoutInSeconds: Float = 1.0

    /// Moves the real mouse cursor to the target and performs the click.
    /// Throws a ComputerUseClickRefusal (without clicking) if any safety check fails.
    static func performClick(
        clickKind: ComputerUseClickKind,
        atAppKitGlobalLocation appKitGlobalLocation: CGPoint,
        overlayWindowManager: OverlayWindowManager,
        expectedTarget: VerifiedTarget
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

        let eventSource = CGEventSource(stateID: .hidSystemState)

        try postMouseEvent(type: .mouseMoved, button: .left, clickState: 0, at: coreGraphicsLocation, eventSource: eventSource)
        try await Task.sleep(nanoseconds: delayAfterMovingCursorInNanoseconds)

        let currentTarget = try await captureVerifiedTarget(
            at: appKitGlobalLocation, overlayWindowManager: overlayWindowManager
        )
        guard CFEqual(expectedTarget.element, currentTarget.element),
              expectedTarget.position == currentTarget.position,
              expectedTarget.size == currentTarget.size else {
            throw ComputerUseClickRefusal.targetElementCouldNotBeVerified
        }

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
    /// Fails closed: whenever the element under the point can't be
    /// identified, the click is refused instead of performed unchecked.
    private static func refusalForElement(_ elementAtTarget: AXUIElement) -> ComputerUseClickRefusal? {
        var targetProcessIdentifier: pid_t = 0
        let processIdentifierLookupResult = AXUIElementGetPid(elementAtTarget, &targetProcessIdentifier)
        guard processIdentifierLookupResult == .success, targetProcessIdentifier != 0 else {
            return .targetElementCouldNotBeVerified
        }

        // If the hit test still landed on one of Coach's own windows (the
        // overlay, or the menu bar panel), the real element underneath was
        // never checked. Never treat that as safe. This is checked before
        // reading any attribute, because asking our own process for its
        // attributes while the main actor is busy here would only time out.
        guard targetProcessIdentifier != ProcessInfo.processInfo.processIdentifier else {
            return .targetElementCouldNotBeVerified
        }

        _ = AXUIElementSetMessagingTimeout(elementAtTarget, accessibilityMessagingTimeoutInSeconds)
        var subroleValue: CFTypeRef?
        let subroleLookupResult = AXUIElementCopyAttributeValue(
            elementAtTarget,
            kAXSubroleAttribute as CFString,
            &subroleValue
        )
        switch subroleLookupResult {
        case .success:
            if let subrole = subroleValue as? String, subrole == kAXSecureTextFieldSubrole {
                return .secureTextFieldAtTarget
            }
        case .noValue, .attributeUnsupported:
            // Most elements have no subrole. That is a definite answer, not a failure.
            break
        default:
            // A timeout or any other error: we don't know whether it's a password field.
            return .targetElementCouldNotBeVerified
        }

        guard let targetApplication = NSRunningApplication(processIdentifier: targetProcessIdentifier) else {
            return .targetElementCouldNotBeVerified
        }

        if let targetBundleIdentifier = targetApplication.bundleIdentifier,
           ComputerUseSensitiveApplications.isSensitive(bundleIdentifier: targetBundleIdentifier) {
            let applicationName = targetApplication.localizedName ?? "that app"
            return .sensitiveApplicationAtTarget(applicationName: applicationName)
        }

        return nil
    }
}
