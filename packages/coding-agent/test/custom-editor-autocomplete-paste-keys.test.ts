import type { AutocompleteProvider } from "@nanopi/pi-tui";
import { setKeybindings, TuiMainScreen } from "@nanopi/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

const commands = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];

/** A slash-command menu that stays open until a completion is applied, so paging is observable. */
const menu: AutocompleteProvider = {
	async getSuggestions(_lines, _line, col) {
		if (col !== 1) return null;
		return { items: commands.map((name) => ({ value: name, label: name })), prefix: "/" };
	},
	applyCompletion(lines, line, _col, item) {
		return { lines, cursorLine: line, cursorCol: 1 + item.value.length };
	},
};

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

describe("CustomEditor paste keybinding and an open autocomplete menu", () => {
	// The paste action returns before any other handling, so a user who binds
	// `app.clipboard.pasteImage` to a key the menu also uses could no longer page it (#634).
	it("still pages the menu when the paste action shares its key", async () => {
		const keybindings = new KeybindingsManager({ "app.clipboard.pasteImage": "pageUp" });
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		editor.setAutocompleteProvider(menu);
		let pastes = 0;
		editor.onPasteImage = () => {
			pastes++;
		};

		editor.handleInput("/");
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(editor.isShowingAutocomplete()).toBe(true);

		editor.handleInput("\x1b[5~"); // PageUp
		expect(pastes).toBe(0);
	});

	it("pastes when the menu is closed", () => {
		const keybindings = new KeybindingsManager({ "app.clipboard.pasteImage": "pageUp" });
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		let pastes = 0;
		editor.onPasteImage = () => {
			pastes++;
		};

		editor.handleInput("\x1b[5~"); // PageUp
		expect(pastes).toBe(1);
	});
});
