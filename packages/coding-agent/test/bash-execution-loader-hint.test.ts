/**
 * The `Running...` hint of a bash execution has to name the key that actually
 * cancels the command. `tui.select.cancel` and `app.interrupt` are different
 * bindings that only share their `escape` default, so a user who remaps the
 * interrupt key was told to press a key that does nothing (or worse, one bound
 * to clear/quit).
 */
import { setKeybindings } from "@nanopi/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

/** Minimal TUI stub: the loader only asks for intervals and renders. */
function createTuiStub(): { stub: any } {
	const stub = {
		terminal: {
			get columns() {
				return 80;
			},
			get rows() {
				return 24;
			},
		},
		addInterval: () => ({ dispose: () => {} }),
		removeInterval: () => {},
		requestRender: () => {},
	};
	return { stub };
}

function renderLoaderHint(): string {
	const { stub } = createTuiStub();
	const component = new BashExecutionComponent("sleep 30", stub);
	return component.render(80).join("\n");
}

describe("bash execution cancel hint", () => {
	beforeAll(() => {
		initTheme();
	});

	afterEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("names the interrupt key, not the select-cancel key", () => {
		setKeybindings(new KeybindingsManager({ "app.interrupt": "ctrl+x" }));

		const rendered = renderLoaderHint();

		expect(rendered).toContain("ctrl+x to cancel");
		// `tui.select.cancel` still defaults to escape plus ctrl+c; the hint must not
		// come from that binding.
		expect(rendered).not.toContain("ctrl+c to cancel");
	});
});
