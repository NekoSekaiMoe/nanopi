import assert from "node:assert";
import { describe, it } from "node:test";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";

/** PageUp/PageDown as the terminal sends them (xterm CSI 5~/6~). */
const PAGE_UP = "\u001b[5~";
const PAGE_DOWN = "\u001b[6~";

const testTheme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "> ",
	hint: (text) => text,
};

const items = [
	{
		id: "tui-mode",
		label: "TUI mode",
		currentValue: "regular",
		values: ["regular", "fullscreen"],
	},
];

describe("SettingsList", () => {
	it("includes spaces in an active search instead of changing the selected setting", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
			{ enableSearch: true },
		);

		for (const character of "TUI mode") list.handleInput(character);

		assert.deepStrictEqual(changes, []);
		assert.match(list.render(80)[0] ?? "", /TUI mode/);

		list.handleInput("\r");
		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});

	it("keeps Space as a change shortcut before a search query is entered", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
			{ enableSearch: true },
		);

		list.handleInput(" ");

		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});

	it("moves the selection by a window on PageUp/PageDown", () => {
		const many = Array.from({ length: 20 }, (_, index) => ({
			id: `setting-${index}`,
			label: `Setting ${index}`,
			currentValue: "off",
			values: ["off", "on"],
		}));
		const changes: string[] = [];
		const list = new SettingsList(
			many,
			5,
			testTheme,
			(id) => changes.push(id),
			() => {},
		);

		list.handleInput(PAGE_DOWN);
		list.handleInput("\r");
		assert.deepStrictEqual(changes, ["setting-5"]);

		list.handleInput(PAGE_UP);
		list.handleInput("\r");
		assert.deepStrictEqual(changes, ["setting-5", "setting-0"]);
	});

	it("falls back to the list when PageUp/PageDown arrive inside a search", () => {
		const many = Array.from({ length: 20 }, (_, index) => ({
			id: `setting-${index}`,
			label: `Setting ${index}`,
			currentValue: "off",
			values: ["off", "on"],
		}));
		const list = new SettingsList(
			many,
			5,
			testTheme,
			() => {},
			() => {},
			{ enableSearch: true },
		);

		list.handleInput(PAGE_DOWN);

		// The paged list renders the row five below the first one.
		assert.match(list.render(80).join("\n"), /Setting 5/);
	});
});
