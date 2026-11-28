import { setKeybindings, TuiMainScreen } from "@nanopi/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

function editorWithFollowUp() {
	const keybindings = new KeybindingsManager({ "app.message.followUp": "alt+enter" });
	setKeybindings(keybindings);
	const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
	const followUps: string[] = [];
	editor.onAction("app.message.followUp", () => {
		followUps.push(editor.getText().trim());
		editor.setText("");
	});
	return { editor, followUps };
}

describe("CustomEditor follow-up autocomplete confirmation", () => {
	it("completes a suggested slash command before running follow-up on Alt+Enter", async () => {
		const { editor, followUps } = editorWithFollowUp();
		editor.setAutocompleteProvider({
			getSuggestions: async (lines, cursorLine, cursorCol) => {
				const prefix = (lines[cursorLine] ?? "").slice(0, cursorCol);
				if (!prefix.startsWith("/")) return null;
				return { items: [{ value: "proof", label: "proof" }], prefix };
			},
			applyCompletion: (lines, cursorLine, _cursorCol, item) => ({
				lines: lines.map((line, index) => (index === cursorLine ? `/${item.value} ` : line)),
				cursorLine,
				cursorCol: item.value.length + 2,
			}),
		});

		for (const ch of "/pro") editor.handleInput(ch);
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		editor.handleInput("\x1b\r"); // Alt+Enter

		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(followUps).toEqual(["/proof"]);
	});

	it("applies non-command autocomplete without submitting follow-up on Alt+Enter", async () => {
		const { editor, followUps } = editorWithFollowUp();
		editor.setAutocompleteProvider({
			getSuggestions: async (lines, cursorLine, cursorCol) => {
				const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
				const match = beforeCursor.match(/@\S*$/);
				if (!match) return null;
				return { items: [{ value: "@src/foo.ts", label: "src/foo.ts" }], prefix: match[0] };
			},
			applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
				const line = lines[cursorLine] ?? "";
				const next = `${line.slice(0, cursorCol - prefix.length)}${item.value} ${line.slice(cursorCol)}`;
				return {
					lines: lines.map((entry, index) => (index === cursorLine ? next : entry)),
					cursorLine,
					cursorCol: cursorCol - prefix.length + item.value.length + 1,
				};
			},
		});

		for (const ch of "check @src/fo") editor.handleInput(ch);
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		editor.handleInput("\x1b\r");

		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(editor.getText()).toBe("check @src/foo.ts ");
		expect(followUps).toEqual([]);

		editor.handleInput("\x1b\r");
		expect(followUps).toEqual(["check @src/foo.ts"]);
	});
});
