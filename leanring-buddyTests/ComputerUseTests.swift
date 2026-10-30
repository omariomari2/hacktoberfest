//
//  ComputerUseTests.swift
//  leanring-buddyTests
//
//  Tests for the side-effect-free parts of computer use: [CLICK:...] tag
//  parsing, spoken confirmation matching, and coordinate conversion.
//

import CoreGraphics
import Foundation
import Testing
@testable import leanring_buddy

@MainActor
struct ComputerUseTests {

    // MARK: - Click tag parsing

    @Test func parsesLeftClickWithLabel() {
        let parseResult = ComputerUseTagParser.parseClickRequest(
            from: "i'll open your downloads folder. [CLICK:left:88,214:downloads]"
        )

        #expect(parseResult.remainingText == "i'll open your downloads folder.")
        #expect(parseResult.clickRequest == ComputerUseClickRequest(
            clickKind: .left,
            screenshotCoordinate: CGPoint(x: 88, y: 214),
            elementLabel: "downloads",
            screenNumber: nil
        ))
    }

    @Test func parsesDoubleClickOnAnotherScreen() {
        let parseResult = ComputerUseTagParser.parseClickRequest(
            from: "opening it now [CLICK:double:640, 388:report pdf:screen2]"
        )

        #expect(parseResult.remainingText == "opening it now")
        #expect(parseResult.clickRequest?.clickKind == .double)
        #expect(parseResult.clickRequest?.screenshotCoordinate == CGPoint(x: 640, y: 388))
        #expect(parseResult.clickRequest?.elementLabel == "report pdf")
        #expect(parseResult.clickRequest?.screenNumber == 2)
    }

    @Test func parsesRightClickWithoutLabelButWithScreen() {
        let parseResult = ComputerUseTagParser.parseClickRequest(from: "here [CLICK:right:10,20:screen3]")

        #expect(parseResult.clickRequest?.clickKind == .right)
        #expect(parseResult.clickRequest?.elementLabel == nil)
        #expect(parseResult.clickRequest?.screenNumber == 3)
    }

    @Test func parsesClickKindCaseInsensitively() {
        let parseResult = ComputerUseTagParser.parseClickRequest(from: "ok [CLICK:Double:1,2:file]")
        #expect(parseResult.clickRequest?.clickKind == .double)
    }

    @Test func ignoresClickTagThatIsNotAtTheEnd() {
        let responseText = "the tag looks like [CLICK:left:1,2:x] but i'm only explaining it"
        let parseResult = ComputerUseTagParser.parseClickRequest(from: responseText)

        #expect(parseResult.clickRequest == nil)
        #expect(parseResult.remainingText == responseText)
    }

    @Test func ignoresUnknownClickKinds() {
        let parseResult = ComputerUseTagParser.parseClickRequest(from: "drag it [CLICK:drag:1,2:file]")
        #expect(parseResult.clickRequest == nil)
    }

    @Test func pointTagStillParsesAfterClickTagIsAbsent() {
        let responseText = "it's up top. [POINT:285,11:source control]"
        let clickParseResult = ComputerUseTagParser.parseClickRequest(from: responseText)
        let pointParseResult = CompanionManager.parsePointingCoordinates(from: clickParseResult.remainingText)

        #expect(clickParseResult.clickRequest == nil)
        #expect(pointParseResult.coordinate == CGPoint(x: 285, y: 11))
        #expect(pointParseResult.spokenText == "it's up top.")
    }

    // MARK: - Spoken confirmation

    @Test func acceptsPlainConfirmations() {
        for confirmation in ["yes", "Yes.", "yeah!", "do it", "Go ahead.", "click it", "okay", "Let's do it"] {
            #expect(ComputerUseConfirmation.isConfirmation(confirmation), "\(confirmation)")
        }
    }

    @Test func acceptsConfirmationsWrappedInWakeWordsAndPoliteness() {
        for confirmation in ["hey coach, yes please", "Coach do it", "yes please", "go ahead, thanks"] {
            #expect(ComputerUseConfirmation.isConfirmation(confirmation), "\(confirmation)")
        }
    }

    @Test func rejectsQuestionsAndRefusals() {
        for utterance in ["no", "wait", "yes but what does it do", "what is that button", "", "don't do it"] {
            #expect(!ComputerUseConfirmation.isConfirmation(utterance), "\(utterance)")
        }
    }

    // MARK: - Pending click expiry

    @Test func pendingClickExpiresAfterConfirmationWindow() {
        let createdDate = Date(timeIntervalSince1970: 1_000)
        let pendingClick = ComputerUsePendingClick(
            clickKind: .left,
            elementLabel: "save",
            appKitGlobalLocation: .zero,
            createdDate: createdDate
        )

        #expect(!pendingClick.hasExpired(asOf: createdDate.addingTimeInterval(5)))
        #expect(pendingClick.hasExpired(asOf: createdDate.addingTimeInterval(ComputerUsePendingClick.confirmationWindowInSeconds + 1)))
    }

    // MARK: - Coordinate conversion

    @Test func convertsScreenshotPixelsToAppKitOnPrimaryDisplay() {
        // 1280x800 screenshot of a 1440x900-point primary display at the origin.
        let appKitLocation = ScreenCoordinateConversion.appKitGlobalLocation(
            screenshotCoordinate: CGPoint(x: 640, y: 100),
            screenshotWidthInPixels: 1280,
            screenshotHeightInPixels: 800,
            displayWidthInPoints: 1440,
            displayHeightInPoints: 900,
            displayFrame: CGRect(x: 0, y: 0, width: 1440, height: 900)
        )

        // x: 640 * 1440/1280 = 720. y: 100px from top = 112.5pt from top = 787.5 from bottom.
        #expect(appKitLocation == CGPoint(x: 720, y: 787.5))
    }

    @Test func convertsScreenshotPixelsOnASecondaryDisplay() {
        // Secondary 1920x1080 display placed to the right of the primary, 180pt higher.
        let appKitLocation = ScreenCoordinateConversion.appKitGlobalLocation(
            screenshotCoordinate: CGPoint(x: 0, y: 0),
            screenshotWidthInPixels: 1280,
            screenshotHeightInPixels: 720,
            displayWidthInPoints: 1920,
            displayHeightInPoints: 1080,
            displayFrame: CGRect(x: 1440, y: 180, width: 1920, height: 1080)
        )

        // Top-left corner of that display in AppKit coordinates.
        #expect(appKitLocation == CGPoint(x: 1440, y: 1260))
    }

    @Test func clampsCoordinatesOutsideTheScreenshot() {
        let appKitLocation = ScreenCoordinateConversion.appKitGlobalLocation(
            screenshotCoordinate: CGPoint(x: 5000, y: -50),
            screenshotWidthInPixels: 1280,
            screenshotHeightInPixels: 800,
            displayWidthInPoints: 1280,
            displayHeightInPoints: 800,
            displayFrame: CGRect(x: 0, y: 0, width: 1280, height: 800)
        )

        #expect(appKitLocation == CGPoint(x: 1280, y: 800))
    }

    @Test func convertsAppKitToCoreGraphicsByFlippingAgainstPrimaryDisplay() {
        // A point 787.5pt above the bottom of a 900pt-tall primary display is 112.5pt from the top.
        let coreGraphicsLocation = ScreenCoordinateConversion.coreGraphicsGlobalLocation(
            fromAppKitGlobalLocation: CGPoint(x: 720, y: 787.5),
            primaryDisplayHeightInPoints: 900
        )
        #expect(coreGraphicsLocation == CGPoint(x: 720, y: 112.5))

        // Secondary display above the primary: AppKit y > primary height becomes negative CG y.
        let pointAbovePrimaryDisplay = ScreenCoordinateConversion.coreGraphicsGlobalLocation(
            fromAppKitGlobalLocation: CGPoint(x: 100, y: 1000),
            primaryDisplayHeightInPoints: 900
        )
        #expect(pointAbovePrimaryDisplay == CGPoint(x: 100, y: -100))
    }

    @Test func spokenDescriptionsReadNaturallyInPastTense() {
        #expect("\(ComputerUseClickKind.left.spokenDescription)ed" == "clicked")
        #expect("\(ComputerUseClickKind.double.spokenDescription)ed" == "double-clicked")
        #expect("\(ComputerUseClickKind.right.spokenDescription)ed" == "right-clicked")
    }
}
