//
//  TextInputPanelManager.swift
//  leanring-buddy
//
//  A Spotlight-style text box for typing an instruction to Coach instead of
//  speaking it. Opened and closed with the text-input hotkey (option + space).
//  Enter sends the text through the same pipeline as a voice transcript,
//  Esc or clicking elsewhere closes it.
//
//  The panel is non-activating, like the menu bar panel: it can take
//  keyboard focus without activating Coach, so the user's app stays
//  frontmost and gets focus back as soon as the box closes. That matters
//  for screenshots and pointing, which should describe the user's app.
//

import AppKit
import SwiftUI

/// Borderless panels can't become key by default, which would leave the
/// text field unable to receive typing.
private class TextInputKeyablePanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

@MainActor
final class TextInputPanelManager {
    private let companionManager: CompanionManager
    private var textInputHotKeyMonitor: TextInputHotKeyMonitor?
    private var textInputPanel: NSPanel?
    private var clickOutsideMonitor: Any?
    private var localClickOutsideMonitor: Any?
    private var dismissPanelObserver: NSObjectProtocol?

    private let textInputPanelWidth: CGFloat = 560
    private let textInputPanelHeight: CGFloat = 56

    init(companionManager: CompanionManager) {
        self.companionManager = companionManager
        dismissPanelObserver = NotificationCenter.default.addObserver(
            forName: .clickyDismissPanel, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.hideTextInputPanel(isSubmitting: true)
            }
        }
        self.textInputHotKeyMonitor = TextInputHotKeyMonitor { [weak self] in
            self?.toggleTextInputPanel()
        }
    }

    func stop() {
        hideTextInputPanel(isSubmitting: true)
        textInputHotKeyMonitor = nil
        if let dismissPanelObserver {
            NotificationCenter.default.removeObserver(dismissPanelObserver)
            self.dismissPanelObserver = nil
        }
    }

    func startListeningForHotKey() {
        textInputHotKeyMonitor?.start()
    }

    // MARK: - Panel Lifecycle

    private func toggleTextInputPanel() {
        if let textInputPanel, textInputPanel.isVisible {
            hideTextInputPanel()
        } else {
            showTextInputPanel()
        }
    }

    private func showTextInputPanel() {
        guard companionManager.canAcceptTypedInstruction else {
            print("⌨️ Text input hotkey ignored: finish onboarding/permissions, or wait for recording to end")
            NSSound.beep()
            return
        }

        companionManager.prepareForTypedInstruction()

        if textInputPanel == nil {
            createTextInputPanel()
        }

        // A fresh SwiftUI view each time the box opens, so the field starts
        // empty and onAppear runs again to give it keyboard focus.
        let textInputBarView = TextInputBarView(
            placeholderText: "ask coach anything",
            onSubmitTypedInstruction: { [weak self] typedInstruction in
                self?.submitTypedInstruction(typedInstruction)
            },
            onCancel: { [weak self] in
                self?.hideTextInputPanel()
            }
        )
        let hostingView = NSHostingView(rootView: textInputBarView)
        hostingView.frame = NSRect(x: 0, y: 0, width: textInputPanelWidth, height: textInputPanelHeight)
        hostingView.wantsLayer = true
        hostingView.layer?.backgroundColor = .clear
        textInputPanel?.contentView = hostingView

        positionTextInputPanelOnScreenWithMouse()
        textInputPanel?.makeKeyAndOrderFront(nil)
        textInputPanel?.orderFrontRegardless()
        installClickOutsideMonitor()
    }

    private func hideTextInputPanel(isSubmitting: Bool = false) {
        textInputPanel?.orderOut(nil)
        removeClickOutsideMonitor()
        if !isSubmitting {
            companionManager.cancelTypedInstruction()
        }
    }

    /// Hides the box before sending, so it isn't in the screenshot and
    /// doesn't cover anything Coach might point at.
    private func submitTypedInstruction(_ typedInstruction: String) {
        hideTextInputPanel(isSubmitting: true)
        companionManager.submitTypedInstruction(typedInstruction)
    }

    private func createTextInputPanel() {
        let panel = TextInputKeyablePanel(
            contentRect: NSRect(x: 0, y: 0, width: textInputPanelWidth, height: textInputPanelHeight),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )

        panel.isFloatingPanel = true
        // Above normal and floating windows (including the menu bar panel)
        // but below the cursor overlay, which sits at screen-saver level.
        panel.level = .modalPanel
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isExcludedFromWindowsMenu = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isMovableByWindowBackground = false

        textInputPanel = panel
    }

    /// Centers the box horizontally on whichever screen the mouse is on,
    /// a little above the middle — where Spotlight appears.
    private func positionTextInputPanelOnScreenWithMouse() {
        guard let textInputPanel else { return }

        let mouseLocation = NSEvent.mouseLocation
        let screenWithMouse = NSScreen.screens.first { screen in
            screen.frame.contains(mouseLocation)
        } ?? NSScreen.main ?? NSScreen.screens.first
        guard let visibleFrame = screenWithMouse?.visibleFrame else { return }

        let panelOriginX = visibleFrame.midX - (textInputPanelWidth / 2)
        let distanceFromTopOfScreen = visibleFrame.height * 0.25
        let panelOriginY = visibleFrame.maxY - distanceFromTopOfScreen - textInputPanelHeight

        textInputPanel.setFrame(
            NSRect(x: panelOriginX, y: panelOriginY, width: textInputPanelWidth, height: textInputPanelHeight),
            display: true
        )
    }

    // MARK: - Click Outside Dismissal

    /// A global monitor only sees clicks in other apps, so any click it
    /// reports is outside the box and closes it, like Spotlight.
    private func installClickOutsideMonitor() {
        removeClickOutsideMonitor()

        localClickOutsideMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown]
        ) { [weak self] event in
            if let self, event.window !== self.textInputPanel {
                self.hideTextInputPanel()
            }
            return event
        }

        clickOutsideMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown]
        ) { [weak self] _ in
            self?.hideTextInputPanel()
        }
    }

    private func removeClickOutsideMonitor() {
        if let localClickOutsideMonitor {
            NSEvent.removeMonitor(localClickOutsideMonitor)
            self.localClickOutsideMonitor = nil
        }
        if let clickOutsideMonitor {
            NSEvent.removeMonitor(clickOutsideMonitor)
            self.clickOutsideMonitor = nil
        }
    }
}

// MARK: - Text Input Bar View

/// The single-line text field shown inside the text-input panel.
private struct TextInputBarView: View {
    let placeholderText: String
    let onSubmitTypedInstruction: (String) -> Void
    let onCancel: () -> Void

    @State private var typedInstruction: String = ""
    @FocusState private var isInstructionFieldFocused: Bool

    var body: some View {
        HStack(spacing: DS.Spacing.md) {
            Image(systemName: "text.bubble")
                .font(.system(size: 16, weight: .medium))
                .foregroundColor(DS.Colors.overlayCursorBlue)

            TextField(placeholderText, text: $typedInstruction)
                .textFieldStyle(.plain)
                .font(.system(size: 16))
                .foregroundColor(DS.Colors.textPrimary)
                .focused($isInstructionFieldFocused)
                .onSubmit {
                    onSubmitTypedInstruction(typedInstruction)
                }
                .onExitCommand {
                    onCancel()
                }

            Text("enter to send · esc to close")
                .font(.system(size: 11))
                .foregroundColor(DS.Colors.textTertiary)
                .fixedSize()
        }
        .padding(.horizontal, DS.Spacing.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            RoundedRectangle(cornerRadius: DS.CornerRadius.extraLarge, style: .continuous)
                .fill(DS.Colors.background)
        )
        .overlay(
            RoundedRectangle(cornerRadius: DS.CornerRadius.extraLarge, style: .continuous)
                .stroke(DS.Colors.borderSubtle, lineWidth: 1)
        )
        .onAppear {
            // Wait one run-loop turn so the panel is key before focusing,
            // otherwise the focus request is dropped.
            DispatchQueue.main.async {
                isInstructionFieldFocused = true
            }
        }
    }
}
