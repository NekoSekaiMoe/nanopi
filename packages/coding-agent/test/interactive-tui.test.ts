import type { Component, Terminal, TUI } from "@nanopi/pi-tui";
import { Container, setKeybindings, Text } from "@nanopi/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	RetryStatusIndicator,
	type StatusIndicator,
	type StatusIndicatorKind,
	WorkingStatusIndicator,
} from "../src/modes/interactive/components/status-indicator.ts";
import { createInteractiveTui, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const clipboardMocks = vi.hoisted(() => ({
	copyToClipboard: vi.fn<(text: string) => Promise<void>>(),
	readClipboardFilePaths: vi.fn<() => Promise<string[] | null>>(),
	readClipboardText: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("../src/utils/clipboard.ts", () => clipboardMocks);

class RecordingTerminal extends VirtualTerminal implements Terminal {
	readonly writes: string[] = [];
	startCount = 0;
	stopCount = 0;

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.startCount += 1;
		super.start(onInput, onResize);
	}

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	override stop(): void {
		this.stopCount += 1;
		super.stop();
	}
}

describe("createInteractiveTui", () => {
	it("uses the inline main-screen renderer", async () => {
		const terminal = new RecordingTerminal();
		const tui = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		expect(tui.mode).toBe("regular");
		tui.start();
		await terminal.waitForRender();
		expect(terminal.writes.some((write) => write.includes("\x1b[?1049h"))).toBe(false);
		tui.stop();
	});
});

describe("InteractiveMode right-click paste", () => {
	it("feeds clipboard text to the focused component as a bracketed paste", async () => {
		clipboardMocks.readClipboardText.mockResolvedValue("clipboard text");
		const handleInput = vi.fn<(data: string) => void>();
		const target = { render: () => [], invalidate: () => {}, handleInput } satisfies Component;
		const requestRender = vi.fn();
		const context = {
			renderer: { getFocusedComponent: () => target },
			ui: { requestRender },
		};
		const prototype = InteractiveMode.prototype as unknown as {
			handleRightClickPaste(this: typeof context): Promise<void>;
		};

		await prototype.handleRightClickPaste.call(context);

		expect(handleInput).toHaveBeenCalledWith("\x1b[200~clipboard text\x1b[201~");
		expect(requestRender).toHaveBeenCalledOnce();
	});
});

type CopyCommandContext = {
	session: { getLastAssistantText: () => string | undefined };
	ui: TUI;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
};

type CopyCommandOptions = { flashConfirmation?: boolean; preferSelection?: boolean };

type CopyCommandPrototype = {
	handleCopyCommand(this: CopyCommandContext, options?: CopyCommandOptions): Promise<void>;
};

const copyCommandPrototype = InteractiveMode.prototype as unknown as CopyCommandPrototype;

describe("InteractiveMode copy confirmation", () => {
	beforeEach(() => {
		clipboardMocks.copyToClipboard.mockReset();
		clipboardMocks.copyToClipboard.mockResolvedValue(undefined);
	});

	it("copies the last assistant message and confirms via the status line", async () => {
		const ui = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: new RecordingTerminal(),
		});
		const showStatus = vi.fn();
		const showError = vi.fn();
		const context: CopyCommandContext = {
			session: { getLastAssistantText: () => "assistant response" },
			ui,
			showStatus,
			showError,
		};

		await copyCommandPrototype.handleCopyCommand.call(context, { flashConfirmation: true, preferSelection: true });

		expect(clipboardMocks.copyToClipboard).toHaveBeenCalledWith("assistant response");
		expect(showStatus).toHaveBeenCalledWith("Copied last agent message to clipboard");
		expect(showError).not.toHaveBeenCalled();
	});
});

type StatusEditor = {
	embedWorkingStatus: boolean;
	setWorkingStatusIndicator: (indicator: StatusIndicator | undefined) => void;
};

type ClearStatusContext = {
	activeStatusIndicator: { kind: StatusIndicatorKind; dispose: () => void } | undefined;
	activeWorkingIndicatorEmbedded: boolean;
	statusContainer: Container;
	defaultEditor: StatusEditor;
	editor: Partial<StatusEditor>;
	ui: { getClearOnShrink: () => boolean };
	idleStatus: Component;
	setEditorWorkingStatusIndicator(indicator: StatusIndicator | undefined): boolean;
};

type InteractiveModePrototype = {
	showStatusIndicator(this: ClearStatusContext, indicator: StatusIndicator): void;
	clearStatusIndicator(this: ClearStatusContext, kind?: StatusIndicatorKind): void;
	setEditorWorkingStatusIndicator(this: ClearStatusContext, indicator: StatusIndicator | undefined): boolean;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("clear-on-shrink status spacing", () => {
	it.each([true, false])("routes every status through the editor opt-in (%s)", (embedWorkingStatus) => {
		initTheme();
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const editor: StatusEditor = { embedWorkingStatus, setWorkingStatusIndicator: vi.fn() };
		const context: ClearStatusContext = {
			activeStatusIndicator: undefined,
			activeWorkingIndicatorEmbedded: false,
			statusContainer: new Container(),
			defaultEditor: { embedWorkingStatus: true, setWorkingStatusIndicator: vi.fn() },
			editor,
			ui: { getClearOnShrink: () => true },
			idleStatus: new Text("", 0, 0),
			setEditorWorkingStatusIndicator: interactiveModePrototype.setEditorWorkingStatusIndicator,
		};
		const indicators = [
			new WorkingStatusIndicator(tui, "Working"),
			new CompactionStatusIndicator(tui, "manual"),
			new CompactionStatusIndicator(tui, "threshold"),
			new CompactionStatusIndicator(tui, "overflow"),
			new BranchSummaryStatusIndicator(tui),
			new RetryStatusIndicator(tui, 1, 3, 1000),
		];
		try {
			for (const indicator of indicators) {
				interactiveModePrototype.showStatusIndicator.call(context, indicator);
				expect(context.activeStatusIndicator).toBe(indicator);
				expect(context.activeWorkingIndicatorEmbedded).toBe(embedWorkingStatus);
				if (embedWorkingStatus) {
					expect(editor.setWorkingStatusIndicator).toHaveBeenLastCalledWith(indicator);
					expect(context.statusContainer.children).toHaveLength(0);
				} else {
					expect(context.statusContainer.children).toEqual([indicator]);
				}
			}
		} finally {
			for (const indicator of indicators) indicator.dispose();
		}
	});

	it.each<StatusIndicatorKind>(["working", "compaction", "branchSummary", "retry"])(
		"does not reserve separate status height for an embedded %s indicator",
		(kind) => {
			const dispose = vi.fn();
			const editor: StatusEditor = { embedWorkingStatus: true, setWorkingStatusIndicator: vi.fn() };
			const context: ClearStatusContext = {
				activeStatusIndicator: { kind, dispose },
				activeWorkingIndicatorEmbedded: true,
				statusContainer: new Container(),
				defaultEditor: editor,
				editor,
				ui: { getClearOnShrink: () => true },
				idleStatus: new Text("", 0, 0),
				setEditorWorkingStatusIndicator: interactiveModePrototype.setEditorWorkingStatusIndicator,
			};

			interactiveModePrototype.clearStatusIndicator.call(context);

			expect(dispose).toHaveBeenCalledOnce();
			expect(editor.setWorkingStatusIndicator).toHaveBeenCalledWith(undefined);
			expect(context.statusContainer.children).toHaveLength(0);
		},
	);

	it("uses the standalone row for a custom editor that has not opted in", () => {
		const defaultEditor: StatusEditor = { embedWorkingStatus: true, setWorkingStatusIndicator: vi.fn() };
		const customEditor = { embedWorkingStatus: false, setWorkingStatusIndicator: vi.fn() };
		const context: ClearStatusContext = {
			activeStatusIndicator: { kind: "working", dispose: vi.fn() },
			activeWorkingIndicatorEmbedded: false,
			statusContainer: new Container(),
			defaultEditor,
			editor: customEditor,
			ui: { getClearOnShrink: () => true },
			idleStatus: new Text("", 0, 0),
			setEditorWorkingStatusIndicator: interactiveModePrototype.setEditorWorkingStatusIndicator,
		};

		interactiveModePrototype.clearStatusIndicator.call(context);

		expect(defaultEditor.setWorkingStatusIndicator).toHaveBeenCalledWith(undefined);
		expect(customEditor.setWorkingStatusIndicator).not.toHaveBeenCalled();
		expect(context.statusContainer.children).toHaveLength(1);
	});
});

type CtrlCContext = {
	lastSigintTime: number;
	quitReminderTimer: ReturnType<typeof setTimeout> | undefined;
	footer: { setTransientLine: (line: string | undefined) => void };
	ui: { requestRender: () => void };
	clearEditor: () => void;
	shutdown: () => Promise<void>;
};

describe("Ctrl+C quit reminder", () => {
	const prototype = InteractiveMode.prototype as unknown as {
		handleCtrlC(this: CtrlCContext): void;
	};

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows the reminder, expires it after the window, and quits on the second press", () => {
		initTheme();
		setKeybindings(new KeybindingsManager());
		vi.useFakeTimers();
		const shutdown = vi.fn();
		const setTransientLine = vi.fn();
		const requestRender = vi.fn();
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			lastSigintTime: 0,
			quitReminderTimer: undefined,
			footer: { setTransientLine },
			ui: { requestRender },
			clearEditor: vi.fn(),
			shutdown,
		}) as unknown as CtrlCContext;

		prototype.handleCtrlC.call(context);
		expect(setTransientLine).toHaveBeenCalledWith("Ctrl+C again to quit");
		expect(shutdown).not.toHaveBeenCalled();

		// The reminder disappears once the window expires without a second press.
		vi.advanceTimersByTime(1000);
		expect(setTransientLine).toHaveBeenLastCalledWith(undefined);

		// A second press inside the window quits.
		prototype.handleCtrlC.call(context);
		prototype.handleCtrlC.call(context);
		expect(shutdown).toHaveBeenCalledOnce();
	});
});
