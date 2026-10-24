import type { Component, TUI } from "@nanopi/pi-tui";
import { describe, expect, test } from "vitest";
import type {
	ModuleWidgetChannel,
	ModuleWidgetChannelContext,
	ModuleWidgetChannelTransform,
} from "../src/core/modules/types.ts";
import { WidgetChannelHost } from "../src/core/modules/widget-channels.ts";
import { SUBAGENT_CHANNEL } from "../src/extras/shared-channels.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";
import { createTestUiContext } from "./suite/harness.ts";

interface Rows {
	label: "rows";
	kind: "rows";
	rows: readonly string[];
}

const ROWS: ModuleWidgetChannel<Rows> = {
	name: "test-rows",
	is(value): value is Rows {
		if (!value || typeof value !== "object") return false;
		const record = value as Record<string, unknown>;
		return record.kind === "rows" && Array.isArray(record.rows);
	},
};

function setup() {
	const writes: Array<{ key: string; content: unknown }> = [];
	const base = createTestUiContext({
		setWidget: (key: string, content: unknown) => {
			writes.push({ key, content });
		},
	});
	const host = new WidgetChannelHost();
	host.bind(base);
	return { writes, ui: host.forContext(base), host };
}

describe("widget channels", () => {
	test("writes to a namespaced key, so a producer never picks the widget key", () => {
		const { writes, ui, host } = setup();
		const channel: ModuleWidgetChannelContext<Rows> = host.context(ROWS);
		ui.channel(ROWS).update({ label: "rows", kind: "rows", rows: ["a"] });
		expect(writes.at(-1)?.key).toBe("channel:test-rows");
		expect(channel).toBeDefined();
	});

	test("an unowned channel renders its label instead of guessing at the payload", () => {
		const { writes, host } = setup();
		host.context(ROWS).update({ label: "rows", kind: "rows", rows: ["a"] });
		expect(writes.at(-1)?.content).toEqual(["[rows]"]);
	});

	test("the last transform owns the drawing", () => {
		const { writes, host } = setup();
		const channel = host.context(ROWS);
		const first: ModuleWidgetChannelTransform<Rows> = (content) => ({ lines: [`first ${content.rows.length}`] });
		const second: ModuleWidgetChannelTransform<Rows> = (content) => ({ lines: [`second ${content.rows.length}`] });
		channel.transform(first);
		channel.transform(second);
		channel.update({ label: "rows", kind: "rows", rows: ["a", "b"] });
		expect(writes.at(-1)?.content).toEqual(["second 2"]);
	});

	test("a transform that arrives after the first write still sees it", () => {
		const { writes, host } = setup();
		const channel = host.context(ROWS);
		channel.update({ label: "rows", kind: "rows", rows: ["a"] });
		channel.transform((content) => ({ lines: [`seen ${content.rows.length}`] }));
		expect(writes.at(-1)?.content).toEqual(["seen 1"]);
	});

	test("a component transform reaches setWidget as a factory", () => {
		const { writes, host } = setup();
		const channel = host.context(ROWS);
		const component = (): Component => ({ invalidate: () => {}, render: () => [] });
		channel.transform(() => ({ component: (_tui: TUI, _theme: Theme) => component() }));
		channel.update({ label: "rows", kind: "rows", rows: ["a"] }, { placement: "belowEditor" });
		expect(typeof writes.at(-1)?.content).toBe("function");
	});

	test("clearing the channel clears the widget", () => {
		const { writes, host } = setup();
		const channel = host.context(ROWS);
		channel.transform(() => ({ lines: ["x"] }));
		channel.update({ label: "rows", kind: "rows", rows: ["a"] });
		channel.update(undefined);
		expect(writes.at(-1)?.content).toBeUndefined();
	});

	test("unsubscribing the last transform falls back to the label", () => {
		const { writes, host } = setup();
		const channel = host.context(ROWS);
		const unsubscribe = channel.transform(() => ({ lines: ["owned"] }));
		channel.update({ label: "rows", kind: "rows", rows: ["a"] });
		expect(writes.at(-1)?.content).toEqual(["owned"]);
		unsubscribe();
		expect(writes.at(-1)?.content).toEqual(["[rows]"]);
	});

	test("rejects content the channel does not accept", () => {
		const { host } = setup();
		// A producer that skips TypeScript still has to fail loudly, not render nothing.
		expect(() => host.context(ROWS).update({ label: "rows", kind: "rows" } as unknown as Rows)).toThrow(
			'Invalid content for widget channel "test-rows"',
		);
	});

	test("the subagent channel accepts pi-subagent-mini rows and nothing else", () => {
		expect(SUBAGENT_CHANNEL.is({ label: "subagent jobs", kind: "rows", rows: ["● 1 subagent running"] })).toBe(true);
		expect(SUBAGENT_CHANNEL.is({ label: "subagent jobs", kind: "rows", rows: [1] })).toBe(false);
		expect(SUBAGENT_CHANNEL.is({ label: "other", kind: "rows", rows: [] })).toBe(false);
	});
});
