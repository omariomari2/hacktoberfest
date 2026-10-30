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
    static func parseClickRequest(from responseText: String) -> ClickTagParseResult {
        let pattern = #"\[CLICK:(left|double|right):(\d+)\s*,\s*(\d+)(?::([^\]:]+?))?(?::screen(\d+))?\]\s*$"#

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
    /// Coordinates outside the screenshot are clamped to its edges.
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
        return CGPoint(
            x: displayLocalX + displayFrame.origin.x,
            y: appKitY + displayFrame.origin.y
        )
    }

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
