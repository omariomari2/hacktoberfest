//
//  ComputerUseActions.swift
//  leanring-buddy
//
//  Pure (no side effects) pieces of the computer-use feature: parsing the
//  [CLICK:...] tag the model appends to its answer, recognizing a spoken
//  "yes" that confirms a pending click, and converting screenshot pixel
//  coordinates into the coordinate spaces AppKit and CoreGraphics use.
//  The side-effecting part (actually clicking) lives in
//  ComputerUseClickExecutor.swift.
//

import CoreGraphics
import Foundation

/// The kinds of mouse click the model is allowed to request.
nonisolated enum ComputerUseClickKind: String, Equatable {
    case left
    case double
    case right

    /// How the click is described when asking the user to confirm it out loud.
    var spokenDescription: String {
        switch self {
        case .left: return "click"
        case .double: return "double-click"
        case .right: return "right-click"
        }
    }
}

/// A click the model asked for, still in the screenshot's pixel coordinates.
nonisolated struct ComputerUseClickRequest: Equatable {
    let clickKind: ComputerUseClickKind
    /// Top-left-origin pixel coordinate inside the screenshot the model saw.
    let screenshotCoordinate: CGPoint
    /// Short description of the target, e.g. "save button". Nil if the model omitted it.
    let elementLabel: String?
    /// 1-based screen number from the screenshot label, or nil for the cursor's screen.
    let screenNumber: Int?
}

/// A click that has been shown to the user and is waiting for a spoken "yes".
nonisolated struct ComputerUsePendingClick {
    let clickKind: ComputerUseClickKind
    let elementLabel: String?
    /// Where to click, in global AppKit coordinates (bottom-left origin).
    let appKitGlobalLocation: CGPoint
    let createdDate: Date

    /// How long the user has to confirm before the pending click is discarded.
    /// Long enough to hear the spoken question and answer, short enough that
    /// the screen is unlikely to have changed underneath the target.
    static let confirmationWindowInSeconds: TimeInterval = 20

    func hasExpired(asOf currentDate: Date) -> Bool {
        currentDate.timeIntervalSince(createdDate) > Self.confirmationWindowInSeconds
    }

    /// The same click with its confirmation window starting over at
    /// `restartDate`. Used once Coach finishes speaking the question, so a
    /// long spoken answer doesn't eat into the time the user has to say "yes".
    func restartingConfirmationWindow(at restartDate: Date) -> ComputerUsePendingClick {
        ComputerUsePendingClick(
            clickKind: clickKind,
            elementLabel: elementLabel,
            appKitGlobalLocation: appKitGlobalLocation,
            createdDate: restartDate
        )
    }
}

/// Apps where an accidental click could change security or privacy
/// settings, reveal credentials, or approve an authentication prompt.
nonisolated enum ComputerUseSensitiveApplications {

    static let exactBundleIdentifiers: Set<String> = [
        "com.apple.systempreferences",      // System Settings
        "com.apple.keychainaccess",         // Keychain Access
        "com.apple.Passwords",              // Passwords (macOS 15+)
        "com.apple.SecurityAgent",          // System authentication dialogs
        "com.1password.1password",
        "com.agilebits.onepassword7",
        "com.bitwarden.desktop",
    ]

    /// System Settings panes run in their own extension processes (for
    /// example "com.apple.settings.PrivacySecurity.extension"), so the
    /// element under the click can belong to a process whose bundle
    /// identifier is not "com.apple.systempreferences" itself.
    static let bundleIdentifierPrefixes: [String] = [
        "com.apple.systempreferences.",
        "com.apple.settings.",
    ]

    static func isSensitive(bundleIdentifier: String) -> Bool {
        if exactBundleIdentifiers.contains(bundleIdentifier) {
            return true
        }
        let lowercasedBundleIdentifier = bundleIdentifier.lowercased()
        return bundleIdentifierPrefixes.contains { bundleIdentifierPrefix in
            lowercasedBundleIdentifier.hasPrefix(bundleIdentifierPrefix)
        }
    }
}

nonisolated enum ComputerUseTagParser {

    struct ClickTagParseResult: Equatable {
        /// The response text with the [CLICK:...] tag removed.
        let remainingText: String
        /// The parsed click, or nil if the response had no valid [CLICK:...] tag.
        let clickRequest: ComputerUseClickRequest?
    }

    /// Parses a trailing [CLICK:kind:x,y:label:screenN] tag, where kind is
    /// left, double or right, and both the label and :screenN are optional.
    /// Only a tag at the very end of the response counts, matching how
    /// [POINT:...] tags are parsed, so a tag quoted mid-sentence is never acted on.
    /// The one exception is a [POINT:...] tag right after the click tag: the
    /// base prompt tells the model to always end with a point tag, so it
    /// sometimes writes "[CLICK:...] [POINT:none]". That trailing point tag
    /// is removed together with the click tag.
    static func parseClickRequest(from responseText: String) -> ClickTagParseResult {
        let pattern = #"\[CLICK:(left|double|right):(\d+)\s*,\s*(\d+)(?::([^\]:]+?))?(?::screen(\d+))?\](?:\s*\[POINT:[^\]]*\])?\s*$"#

        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let match = regex.firstMatch(in: responseText, range: NSRange(responseText.startIndex..., in: responseText)),
              let tagRange = Range(match.range, in: responseText),
              let clickKindRange = Range(match.range(at: 1), in: responseText),
              let xRange = Range(match.range(at: 2), in: responseText),
              let yRange = Range(match.range(at: 3), in: responseText),
              let clickKind = ComputerUseClickKind(rawValue: responseText[clickKindRange].lowercased()),
              let x = Double(responseText[xRange]),
              let y = Double(responseText[yRange]) else {
            return ClickTagParseResult(remainingText: responseText, clickRequest: nil)
        }

        let remainingText = String(responseText[..<tagRange.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)

        var elementLabel: String? = nil
        if let labelRange = Range(match.range(at: 4), in: responseText) {
            elementLabel = String(responseText[labelRange]).trimmingCharacters(in: .whitespaces)
        }

        var screenNumber: Int? = nil
        if let screenRange = Range(match.range(at: 5), in: responseText) {
            screenNumber = Int(responseText[screenRange])
        }

        // "[CLICK:left:10,20:screen2]" (no label) is captured by the optional
        // label group as the label "screen2". Treat it as the screen number.
        if screenNumber == nil,
           let possibleScreenLabel = elementLabel,
           possibleScreenLabel.lowercased().hasPrefix("screen"),
           let screenNumberFromLabel = Int(possibleScreenLabel.dropFirst("screen".count)) {
            screenNumber = screenNumberFromLabel
            elementLabel = nil
        }

        return ClickTagParseResult(
            remainingText: remainingText,
            clickRequest: ComputerUseClickRequest(
                clickKind: clickKind,
                screenshotCoordinate: CGPoint(x: x, y: y),
                elementLabel: elementLabel,
                screenNumber: screenNumber
            )
        )
    }

    /// Removes any [CLICK:...] or [POINT:...] tag text still left after the
    /// trailing tags were parsed, for example a tag the model wrote
    /// mid-sentence. Tag syntax should never be read aloud or saved to the
    /// conversation history. This only cleans the text; a stray tag is
    /// never acted on.
    static func removingStrayCoordinateTags(from responseText: String) -> String {
        // [ \t]* also removes the space before the tag, so "like [POINT:none] this"
        // becomes "like this" rather than "like  this".
        let strayTagPattern = #"[ \t]*\[(?:CLICK|POINT):[^\]]*\]"#
        guard let strayTagRegex = try? NSRegularExpression(pattern: strayTagPattern, options: [.caseInsensitive]) else {
            return responseText
        }
        let textWithoutStrayTags = strayTagRegex.stringByReplacingMatches(
            in: responseText,
            options: [],
            range: NSRange(responseText.startIndex..., in: responseText),
            withTemplate: ""
        )
        return textWithoutStrayTags.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

nonisolated enum ComputerUseConfirmation {

    /// Whole utterances that confirm a pending click. The entire transcript
    /// must be one of these (after normalization) — "yes but what does it do"
    /// is a new question, not a confirmation.
    private static let confirmationPhrases: Set<String> = [
        "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "confirm",
        "do it", "go ahead", "click it", "go for it", "lets do it",
        "yes do it", "yes go ahead", "yes click it", "yes confirm",
    ]

    static func isConfirmation(_ transcript: String) -> Bool {
        confirmationPhrases.contains(normalizedUtterance(transcript))
    }

    /// Lowercases, removes punctuation, collapses whitespace, and strips the
    /// wake words and politeness the user might wrap around a confirmation.
    static func normalizedUtterance(_ transcript: String) -> String {
        let lettersAndSpacesOnly = transcript.lowercased().unicodeScalars.filter { unicodeScalar in
            CharacterSet.letters.contains(unicodeScalar) || CharacterSet.whitespaces.contains(unicodeScalar)
        }
        var normalizedWords = String(lettersAndSpacesOnly)
            .split(whereSeparator: { $0.isWhitespace })
            .map(String.init)

        let leadingWakeWords: [[String]] = [["hey", "coach"], ["coach"]]
        for wakeWords in leadingWakeWords where normalizedWords.starts(with: wakeWords) {
            normalizedWords.removeFirst(wakeWords.count)
            break
        }

        let trailingPoliteWords: Set<String> = ["please", "coach", "thanks"]
        while let lastWord = normalizedWords.last, trailingPoliteWords.contains(lastWord) {
            normalizedWords.removeLast()
        }

        return normalizedWords.joined(separator: " ")
    }
}

nonisolated enum ScreenCoordinateConversion {

    /// Converts a coordinate in a screenshot's pixel space (top-left origin,
    /// e.g. 1280x831) into global AppKit coordinates (bottom-left origin of
    /// the primary display, in points) for the display that screenshot shows.
    /// Coordinates outside the screenshot are clamped to its edges, and the
    /// result always lies strictly inside `displayFrame`.
    static func appKitGlobalLocation(
        screenshotCoordinate: CGPoint,
        screenshotWidthInPixels: CGFloat,
        screenshotHeightInPixels: CGFloat,
        displayWidthInPoints: CGFloat,
        displayHeightInPoints: CGFloat,
        displayFrame: CGRect
    ) -> CGPoint {
        let clampedX = max(0, min(screenshotCoordinate.x, screenshotWidthInPixels))
        let clampedY = max(0, min(screenshotCoordinate.y, screenshotHeightInPixels))

        // Scale from screenshot pixels to display points
        let displayLocalX = clampedX * (displayWidthInPoints / screenshotWidthInPixels)
        let displayLocalY = clampedY * (displayHeightInPoints / screenshotHeightInPixels)

        // Convert from top-left origin (screenshot) to bottom-left origin (AppKit)
        let appKitY = displayHeightInPoints - displayLocalY

        // Convert display-local coords to global screen coords
        let globalX = displayLocalX + displayFrame.origin.x
        let globalY = appKitY + displayFrame.origin.y

        // NSScreen.frame.contains (CGRect.contains) treats the maxX and maxY
        // edges as outside the display. The top row of the screenshot
        // (y = 0, where the menu bar is) lands exactly on maxY, so without
        // this a menu-bar click would be refused as off-screen. Keep the
        // point one point inside those two edges.
        let largestGlobalXInsideDisplay = displayFrame.maxX - Self.insetFromMaxEdgesInPoints
        let largestGlobalYInsideDisplay = displayFrame.maxY - Self.insetFromMaxEdgesInPoints
        return CGPoint(
            x: min(globalX, largestGlobalXInsideDisplay),
            y: min(globalY, largestGlobalYInsideDisplay)
        )
    }

    /// How far inside the display's right and top edges a converted point is kept.
    private static let insetFromMaxEdgesInPoints: CGFloat = 1

    /// Converts global AppKit coordinates (bottom-left origin) into global
    /// CoreGraphics coordinates (top-left origin of the primary display),
    /// which is what CGEvent and the Accessibility API expect.
    static func coreGraphicsGlobalLocation(
        fromAppKitGlobalLocation appKitGlobalLocation: CGPoint,
        primaryDisplayHeightInPoints: CGFloat
    ) -> CGPoint {
        CGPoint(x: appKitGlobalLocation.x, y: primaryDisplayHeightInPoints - appKitGlobalLocation.y)
    }
}
