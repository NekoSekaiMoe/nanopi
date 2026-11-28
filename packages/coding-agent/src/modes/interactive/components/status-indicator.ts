import { type Component, Loader, type TUI, truncateToWidth } from "@nanopi/pi-tui";
import type {
	WorkingIndicatorKind,
	WorkingIndicatorOptions,
	WorkingIndicatorRenderer,
} from "../../../core/modules/index.ts";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { keyText } from "./keybinding-hints.ts";

export type StatusIndicatorKind = WorkingIndicatorKind;

/** Frame interval for an animated row: 30fps, the cadence the shimmer is tuned for. */
const ANIMATION_FRAME_MS = 1000 / 30;

export class StatusIndicator extends Loader {
	readonly kind: StatusIndicatorKind;
	private rowRenderer: WorkingIndicatorRenderer | undefined;
	private startedAt = Date.now();
	/** Wall time of the last frame handed to the row renderer. */
	private lastFrameAt: number | undefined;
	private frameTimer: ReturnType<typeof setInterval> | undefined;
	/** Loader owns a private `ui`; keep the repaint target under its own name. */
	private readonly repaintTarget: TUI;

	constructor(
		kind: StatusIndicatorKind,
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: (str: string) => string,
		message: string,
		indicator?: WorkingIndicatorOptions,
	) {
		super(ui, spinnerColorFn, messageColorFn, message, indicator);
		this.kind = kind;
		this.repaintTarget = ui;
	}

	/** Whether a registered renderer owns this row instead of the default Loader. */
	hasRowRenderer(): boolean {
		return this.rowRenderer !== undefined;
	}

	/** Install a `registerWorkingIndicator` renderer; undefined restores the default row. */
	setRowRenderer(renderer: WorkingIndicatorRenderer | undefined): void {
		// `dtMs` is the gap since the previous frame; a new renderer has no previous
		// frame, so leaving `lastFrameAt` stale reports the idle time before the
		// install as one huge step.
		this.rowRenderer = renderer;
		this.lastFrameAt = undefined;
		if (renderer) this.startFrameLoop();
		else this.stopFrameLoop();
		this.invalidate();
	}

	/**
	 * A row renderer paints every frame (the shimmer moves with the clock), so the
	 * host has to keep rendering while the row is up. The spinner's own interval
	 * repaints far too slowly for that and would freeze the elapsed text anyway.
	 */
	private startFrameLoop(): void {
		if (this.frameTimer) return;
		this.frameTimer = setInterval(() => this.repaintTarget.requestRender(), ANIMATION_FRAME_MS);
	}

	private stopFrameLoop(): void {
		if (!this.frameTimer) return;
		clearInterval(this.frameTimer);
		this.frameTimer = undefined;
	}

	dispose(): void {
		this.stopFrameLoop();
		this.stop();
	}

	/**
	 * A registered row renderer draws the line instead of the spinner-plus-message
	 * pair. Returning undefined for a frame keeps the host text, and `hidden`
	 * suppresses the row.
	 */
	override render(width: number): string[] {
		const renderer = this.rowRenderer;
		if (!renderer) return super.render(width);
		let result: { text: string; hidden?: boolean } | undefined;
		try {
			const now = Date.now();
			const dtMs = this.lastFrameAt === undefined ? 0 : Math.max(0, now - this.lastFrameAt);
			this.lastFrameAt = now;
			result = renderer(
				{
					elapsedMs: now - this.startedAt,
					dtMs,
					message: this.getMessage(),
					placement: "statusRow",
					columns: width,
					kind: this.kind,
				},
				theme,
			);
		} catch {
			// Keep the default row when a renderer trips over an unknown state.
			return super.render(width);
		}
		if (!result) return super.render(width);
		if (result.hidden) return [];
		return ["", truncateToWidth(result.text, width, "")];
	}

	renderInBorder(width: number): string {
		// `render`, not `super.render`: a subclass that draws its own row has to
		// be asked, or the embedded border shows a row the host already replaced.
		const line = this.render(width + 2)[1] ?? "";
		// Renderers own their column: strip only the default Loader's leading
		// spacer, never a registered row's own dot.
		return truncateToWidth(
			this.rowRenderer ? line.trimEnd() : line.startsWith(" ") ? line.slice(1).trimEnd() : line.trimEnd(),
			width,
			"",
		);
	}

	renderSpinnerInBorder(width: number): string {
		return truncateToWidth(this.getRenderedIndicator(), width, "");
	}
}

export class WorkingStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, message: string, indicator?: WorkingIndicatorOptions, colorFn?: (text: string) => string) {
		super(
			"working",
			ui,
			colorFn ?? ((text) => theme.fg("accent", text)),
			colorFn ?? ((text) => theme.fg("muted", text)),
			message,
			indicator,
		);
	}
}

export class RetryStatusIndicator extends StatusIndicator {
	private countdown: CountdownTimer | undefined;

	constructor(ui: TUI, attempt: number, maxAttempts: number, delayMs: number) {
		const retryMessage = (seconds: number) =>
			`Retrying (${attempt}/${maxAttempts}) in ${seconds}s... (${keyText("app.interrupt")} to cancel)`;
		super(
			"retry",
			ui,
			(spinner) => theme.fg("warning", spinner),
			(text) => theme.fg("muted", text),
			retryMessage(Math.ceil(delayMs / 1000)),
		);
		this.countdown = new CountdownTimer(
			delayMs,
			ui,
			(seconds) => {
				this.setMessage(retryMessage(seconds));
			},
			() => {
				this.countdown = undefined;
			},
		);
	}

	dispose(): void {
		this.countdown?.dispose();
		this.countdown = undefined;
		super.dispose();
	}
}

export type CompactionStatusReason = "manual" | "threshold" | "overflow";

export class CompactionStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, reason: CompactionStatusReason) {
		const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
		const label =
			reason === "manual"
				? `Compacting context... ${cancelHint}`
				: `${reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... ${cancelHint}`;
		super(
			"compaction",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			label,
		);
	}
}

export class BranchSummaryStatusIndicator extends StatusIndicator {
	constructor(ui: TUI) {
		super(
			"branchSummary",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			`Summarizing branch... (${keyText("app.interrupt")} to cancel)`,
		);
	}
}

export class IdleStatus implements Component {
	invalidate(): void {
		// No cached state to invalidate.
	}

	render(width: number): string[] {
		const emptyLine = " ".repeat(width);
		return [emptyLine, emptyLine];
	}
}
