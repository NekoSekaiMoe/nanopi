import type { Component } from "@nanopi/pi-tui";
import { describe, expect, test } from "vitest";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";
import {
	createSubagentViewerBridge,
	detailLines,
	SubagentReportComponent,
	SubagentViewerComponent,
	statusColor,
	viewEntries,
} from "../src/modules/pi-ui/src/subagent-viewer.ts";
import type { SubagentViewContent } from "../src/modules/shared-channels.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const jobs = [
	{
		id: "sa-1",
		status: "completed",
		elapsed: "201s",
		scope: "Audit commits",
		detail: "cwd /workspace · tools read",
		report: "Result: found 3 issues",
	},
	{
		id: "sa-2",
		status: "running",
		elapsed: "183s",
		scope: "Search tasks",
		detail: "cwd /workspace · tools read",
		report: "",
	},
];

describe("pi-ui subagent viewer", () => {
	test("reads only a valid view snapshot", () => {
		const content: SubagentViewContent = { label: "subagent views", kind: "view", jobs };
		expect(viewEntries(content)).toEqual(jobs);
		expect(viewEntries({ label: "subagent views", kind: "view", jobs: [{ id: "x" }] })).toEqual([]);
		expect(viewEntries(undefined)).toEqual([]);
	});

	test("renders a read-only list and the selected job's report", () => {
		const viewer = new SubagentViewerComponent(jobs, { theme, onClose: () => undefined });
		const lines = viewer.render(80).join("\n");
		expect(lines).toContain("Subagents (read-only)");
		expect(lines).toContain("sa-2");
		expect(lines).toContain("running");
		expect(viewer.selected).toBe(1);
		expect(detailLines(jobs[0]!, theme, 40, 8).join("\n")).toContain("Audit commits");
		expect(detailLines(jobs[0]!, theme, 40, 8).join("\n")).toContain("found 3 issues");
	});

	test("down and up move selection, escape closes", () => {
		let closed = false;
		const viewer = new SubagentViewerComponent(jobs, {
			theme,
			onClose: () => {
				closed = true;
			},
		});
		viewer.handleInput("\x1b[B");
		expect(viewer.selected).toBe(0);
		viewer.handleInput("\x1b[A");
		expect(viewer.selected).toBe(1);
		viewer.handleInput("\x1b");
		expect(closed).toBe(true);
	});

	test("enter opens the selected job's read-only report", () => {
		let opened: (typeof jobs)[number] | undefined;
		const viewer = new SubagentViewerComponent(jobs, {
			theme,
			onClose: () => undefined,
			onOpen: (job) => {
				opened = job;
			},
		});
		viewer.handleInput("\r");
		expect(opened).toEqual(jobs[1]);
		let closed = false;
		const report = new SubagentReportComponent(jobs[0]!, theme, () => {
			closed = true;
		});
		expect(report.render(80).join("\n")).toContain("found 3 issues");
		report.handleInput("\x1b");
		expect(closed).toBe(true);
	});

	test("status colours stay visible for every state", () => {
		expect(statusColor("completed")).toBe("success");
		expect(statusColor("running")).toBe("accent");
		expect(statusColor("failed")).toBe("error");
		expect(statusColor("queued")).toBe("muted");
	});

	test("bridge opens the viewer and closes it on escape", () => {
		let latest: readonly (typeof jobs)[number][] = [];
		let overlay: Component | undefined;
		let close: (() => void) | undefined;
		const bridge = createSubagentViewerBridge({
			theme,
			onClose: () => undefined,
			getEditorText: () => "",
			subscribe: (listener) => {
				listener(jobs);
				latest = jobs;
				return () => undefined;
			},
			showReport: () => undefined,
			open: (factory) => {
				overlay = factory(() => undefined, 24);
				close = () => {
					// Escape calls done() through the component's onClose.
					(overlay as unknown as { handleInput(data: string): void }).handleInput("\x1b");
				};
			},
		});
		expect(latest.length).toBe(2);
		expect(bridge.onInput("\x1b[B")).toEqual({ consume: true });
		expect(overlay).toBeDefined();
		expect(overlay?.render(80).join("\n")).toContain("Subagents (read-only)");
		close?.();
		bridge.dispose();
	});

	test("bridge consumes Down only with an empty editor and jobs to view", () => {
		let latest: readonly (typeof jobs)[number][] = [];
		let openFactory: ((done: () => void, terminalRows: number) => Component) | undefined;
		const bridge = createSubagentViewerBridge({
			theme,
			onClose: () => undefined,
			getEditorText: () => "",
			subscribe: (listener) => {
				listener(jobs);
				latest = jobs;
				return () => undefined;
			},
			showReport: () => undefined,
			open: (factory) => {
				openFactory = factory;
			},
		});
		expect(bridge.onInput("\x1b[B")).toEqual({ consume: true });
		expect(openFactory).toBeDefined();
		expect(latest.length).toBe(2);
		bridge.dispose();
	});
});
