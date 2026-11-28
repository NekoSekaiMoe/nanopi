import { setKeybindings } from "@nanopi/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SelectSubmenu } from "../src/modes/interactive/components/settings-submenu.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("select submenu hint", () => {
	beforeAll(() => initTheme());
	afterEach(() => setKeybindings(new KeybindingsManager()));

	it("names the configured select keys", () => {
		setKeybindings(new KeybindingsManager({ "tui.select.confirm": "ctrl+y", "tui.select.cancel": "ctrl+q" }));
		const submenu = new SelectSubmenu(
			"Theme",
			"",
			[{ value: "dark", label: "dark" }],
			"dark",
			() => {},
			() => {},
		);
		const output = submenu
			.render(120)
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");
		expect(output).toContain("ctrl+y to select \u00b7 ctrl+q to go back");
	});
});
