/**
 * Read-only viewer for subagent jobs.
 *
 * The live block under the editor shows a one-line scope per running job. That
 * is enough to notice work, not to read it: a truncated line cannot say what a
 * child is doing now or what it concluded. This component is the other half —
 * it renders a snapshot of every job the session has seen: a job list on the
 * left and the selected job's report on the right. There is no edit or action
 * surface; the transcript is left untouched.
 *
 * The component is deliberately pure: it receives a theme, a key matcher
 * (through `matchesKey` on raw data) and callbacks instead of reaching for a
 * module context. The host owns focus and dispatch; tests render the same lines
 * without a terminal.
 */

import { matchesKey, truncateToWidth, visibleWidth } from "@nanopi/pi-tui";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@nanopi/pi-tui";
import type { Theme, ThemeColor } from "@nanopi/pi-coding-agent";
import { type SubagentViewEntry, SUBAGENT_VIEW_CHANNEL } from "../../shared-channels.ts";

const HEADER_ROWS = 4;
const FOOTER_ROWS = 2;

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function pad(text: string, width: number): string {
	const size = visibleWidth(text);
	return size >= width ? text : `${text}${" ".repeat(width - size)}`;
}

/** Parse a channel value as a view snapshot. Anything else renders the empty state. */
export function viewEntries(value: unknown): readonly SubagentViewEntry[] {
	if (!SUBAGENT_VIEW_CHANNEL.is(value)) return [];
	return value.jobs;
}

/** Colour for a job status. Pure, so tests and the renderer agree. */
export function statusColor(status: string): ThemeColor {
	if (status === "completed") return "success";
	if (["failed", "killed", "timeout", "blocked", "interrupted"].includes(status)) return "error";
	if (status === "running") return "accent";
	return "muted";
}

export interface SubagentViewerOptions {
	theme: Theme;
	/** Re-render after the selection changes. The host's requestRender is enough. */
	invalidate?: () => void;
	/** Called when Esc is pressed. */
	onClose: () => void;
	/** Called when Enter confirms the selected job. */
	onOpen?: (job: SubagentViewEntry) => void;
}

export class SubagentViewerComponent implements Component {
	private readonly theme: Theme;
	private readonly jobs: readonly SubagentViewEntry[];
	private readonly onClose: () => void;
	private readonly onOpen?: (job: SubagentViewEntry) => void;
	private readonly repaint?: () => void;
	private selectedIndex = 0;
	private scrollTop = 0;
	private height = 24;

	constructor(jobs: readonly SubagentViewEntry[], options: SubagentViewerOptions) {
		this.jobs = jobs;
		this.theme = options.theme;
		this.onClose = options.onClose;
		this.onOpen = options.onOpen;
		this.repaint = options.invalidate;
		// The newest job is what the user just saw in the live block.
		if (jobs.length > 1) this.selectedIndex = jobs.length - 1;
	}

	invalidate(): void {
		// No cache: render() reads the theme and selection on every pass.
	}

	/** Index currently selected; exposed for tests and the host. */
	get selected(): number {
		return this.selectedIndex;
	}

	/** Job currently selected; exposed for tests and the host. */
	get selectedJob(): SubagentViewEntry | undefined {
		return this.jobs[this.selectedIndex];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.onClose();
			return;
		}
		if (matchesKey(data, "enter")) {
			const job = this.selectedJob;
			if (job) this.onOpen?.(job);
			return;
		}
		if (matchesKey(data, "up")) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.move(1);
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			this.move(event.wheelDelta && event.wheelDelta < 0 ? -1 : 1);
			return { handled: true };
		}
		if (event.type === "click" && event.y >= HEADER_ROWS && event.y < HEADER_ROWS + this.jobs.length) {
			this.select(event.y - HEADER_ROWS);
			return { handled: true };
		}
		return undefined;
	}

	private move(direction: -1 | 1): void {
		if (this.jobs.length === 0) return;
		this.select((this.selectedIndex + direction + this.jobs.length) % this.jobs.length);
	}

	private select(index: number): void {
		const next = Math.max(0, Math.min(index, this.jobs.length - 1));
		if (next === this.selectedIndex) return;
		this.selectedIndex = next;
		this.repaint?.();
	}

	/** Set the viewport height so short terminals scroll instead of overflowing. */
	setHeight(rows: number): void {
		this.height = Math.max(HEADER_ROWS + FOOTER_ROWS + 1, Math.floor(rows));
	}

	render(width: number): string[] {
		const total = Math.max(1, width);
		const inner = Math.max(1, total - 2);
		const rule = this.theme.fg("border", "─".repeat(inner));
		const listWidth = Math.max(20, Math.min(32, Math.floor(inner * 0.38)));
		const detailWidth = Math.max(1, inner - listWidth - 1);
		const lines = [
			rule,
			this.row(` ${this.theme.bold(this.theme.fg("toolTitle", "Subagents (read-only)"))}`, inner),
			this.row(` ${this.theme.fg("dim", "↑/↓ select · enter view · esc close")}`, inner),
			rule,
		];

		if (this.jobs.length === 0) {
			lines.push(this.row(` ${this.theme.fg("muted", "No subagents in this session.")}`, inner), rule);
			return lines;
		}

		const bodyRows = Math.max(3, this.height - HEADER_ROWS - FOOTER_ROWS);
		while (this.selectedIndex < this.scrollTop) this.scrollTop = this.selectedIndex;
		while (this.selectedIndex >= this.scrollTop + bodyRows) this.scrollTop = this.selectedIndex - bodyRows + 1;

		const page = this.jobs.slice(this.scrollTop, this.scrollTop + bodyRows);
		const list = page.map((job, offset) => this.jobRow(job, this.scrollTop + offset, listWidth));
		while (list.length < bodyRows) list.push(" ".repeat(listWidth));
		const detail = detailLines(this.jobs[this.selectedIndex]!, this.theme, detailWidth, bodyRows);

		for (let index = 0; index < bodyRows; index++) {
			lines.push(this.row(` ${list[index]!} ${detail[index] ?? ""}`, inner));
		}
		lines.push(rule);
		return lines;
	}

	private jobRow(job: SubagentViewEntry, index: number, width: number): string {
		const selected = index === this.selectedIndex;
		const cursor = selected ? this.theme.fg("accent", "›") : " ";
		const status = this.theme.fg(statusColor(job.status), job.status.slice(0, 10));
		const elapsed = pad(job.elapsed, 5);
		const summaryWidth = Math.max(1, width - 24);
		const summary = truncateToWidth(job.scope || job.id, summaryWidth, "…");
		const line = `${cursor} ${pad(job.id, 6)} ${elapsed} ${pad(status, 10)} ${pad(summary, summaryWidth)}`;
		return truncateToWidth(selected ? this.theme.bg("selectedBg", pad(line, width)) : pad(line, width), width, "…");
	}

	private row(text: string, width: number): string {
		return pad(truncateToWidth(text, width, "…"), width);
	}
}

/** Right-hand pane: the selected job's brief and report, wrapped to fit. */
export function detailLines(
	job: SubagentViewEntry,
	theme: Theme,
	width: number,
	rows: number,
): string[] {
	const heading = theme.bold(theme.fg("toolTitle", `${job.id} · ${job.status}`));
	const hasReport = job.report.trim().length > 0;
	const source = hasReport ? job.report : `${job.detail}\n(no report yet; still running or no output)`;
	const prefix = " ";
	const contentWidth = Math.max(1, width - prefix.length);
	const raw: string[] = [];
	const push = (text: string, color: (value: string) => string): void => {
		for (const chunk of wrapPlain(text, contentWidth)) raw.push(`${prefix}${color(chunk)}`);
	};
	push(stripAnsi(heading), (value) => theme.bold(theme.fg("toolTitle", value)));
	push(job.scope, (value) => theme.fg("dim", value));
	push(`${job.status} · ${job.elapsed}`, (value) => theme.fg("dim", value));
	raw.push("");
	for (const line of source.split("\n")) push(line, (value) => theme.fg("toolOutput", value));
	return raw.slice(0, Math.max(1, rows)).map((line) => pad(line, width));
}

/** Wrap plain text into visible-width chunks. */
function wrapPlain(text: string, width: number): string[] {
	if (visibleWidth(text) <= width) return [text];
	const chunks: string[] = [];
	for (let start = 0; start < text.length; start += width) chunks.push(text.slice(start, start + width));
	return chunks;
}

/** Full-screen read-only report for one job. Esc returns to the list or exits. */
export class SubagentReportComponent implements Component {
	private readonly job: SubagentViewEntry;
	private readonly theme: Theme;
	private readonly onClose: () => void;
	private scrollTop = 0;
	private height = 24;

	constructor(job: SubagentViewEntry, theme: Theme, onClose: () => void) {
		this.job = job;
		this.theme = theme;
		this.onClose = onClose;
	}

	invalidate(): void {
		// No cache.
	}

	setHeight(rows: number): void {
		this.height = Math.max(8, Math.floor(rows));
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) this.onClose();
		else if (matchesKey(data, "up") || matchesKey(data, "pageUp")) this.scrollTop = Math.max(0, this.scrollTop - 1);
		else if (matchesKey(data, "down") || matchesKey(data, "pageDown")) this.scrollTop += 1;
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 2);
		const rule = this.theme.fg("border", "─".repeat(inner));
		const heading = this.theme.bold(this.theme.fg("toolTitle", `${this.job.id} · ${this.job.status} · ${this.job.elapsed}`));
		const lines = [
			rule,
			this.pad(` ${heading}`, inner),
			this.pad(` ${this.theme.fg("dim", this.job.scope)}`, inner),
			this.pad(` ${this.theme.fg("dim", this.job.detail)}`, inner),
			rule,
		];
		const body = (this.job.report.trim() ? this.job.report : "(no report yet; still running or no output)")
			.split("\n")
			.flatMap((line) => wrapPlain(line, Math.max(1, inner - 2)));
		const rows = Math.max(1, this.height - HEADER_ROWS - FOOTER_ROWS);
		for (const line of body.slice(this.scrollTop, this.scrollTop + rows)) {
			lines.push(this.pad(` ${this.theme.fg("toolOutput", line)}`, inner));
		}
		lines.push(rule, this.pad(` ${this.theme.fg("dim", "↑/↓ scroll · esc back")}`, inner), rule);
		return lines;
	}

	private pad(text: string, width: number): string {
		return pad(truncateToWidth(text, width, "…"), width);
	}
}

/**
 * Bridge between raw terminal input and the read-only viewer.
 *
 * The editor owns Down when it has text or a selection, so the bridge consumes
 * Down only when the editor is empty. It captures the latest view snapshot
 * through a channel transform, then opens an overlay component owned by the
 * host, which gives Esc and ↑/↓ to the viewer until `done` closes it.
 */
export interface SubagentViewerBridge {
	onInput(data: string): { consume?: boolean } | undefined;
	dispose(): void;
}

export interface SubagentViewerBridgeOptions extends SubagentViewerOptions {
	/** Read the current editor text; a non-empty editor keeps Down for the caret. */
	getEditorText(): string;
	/** Open a focused component. The host restores focus to the editor on close. */
	open(factory: (done: (result: void) => void, terminalRows: number) => Component & { dispose?(): void }): void;
	/** Open the selected job's full report after Enter. */
	showReport(job: SubagentViewEntry): void;
	/** Subscribe to view snapshots; returns an unsubscribe function. */
	subscribe(listener: (jobs: readonly SubagentViewEntry[]) => void): () => void;
}

export function createSubagentViewerBridge(options: SubagentViewerBridgeOptions): SubagentViewerBridge {
	let latest: readonly SubagentViewEntry[] = [];
	let open = false;
	const unsubscribe = options.subscribe((jobs) => {
		latest = jobs;
	});

	return {
		onInput(data) {
			if (open) return undefined;
			if (!matchesKey(data, "down") || options.getEditorText().length > 0 || latest.length === 0) return undefined;
			open = true;
			options.open((done, terminalRows) => {
				const component = new SubagentViewerComponent(latest, {
					theme: options.theme,
					invalidate: () => options.invalidate?.(),
					onClose: () => {
						open = false;
						done();
					},
					onOpen: (job) => {
						open = false;
						done();
						options.showReport(job);
					},
				});
				component.setHeight(terminalRows);
				return component;
			});
			return { consume: true };
		},
		dispose() {
			unsubscribe();
		},
	};
}
