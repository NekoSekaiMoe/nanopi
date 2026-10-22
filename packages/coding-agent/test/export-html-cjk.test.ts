import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

function loadVendor(file: string, context: vm.Context): void {
	vm.runInContext(readFileSync(new URL(file, import.meta.url), "utf-8"), context);
}

// Ported from earendil-works/pi#10730: the TUI uses marked-cjk-friendly so "**注意：**后面"
// is bold; the export template must ship the same tokenizer.
describe("export HTML CJK emphasis", () => {
	function createMarked() {
		const context = vm.createContext({ console });
		loadVendor("../src/core/export-html/vendor/marked.min.js", context);
		loadVendor("../src/core/export-html/vendor/marked-cjk-friendly.min.js", context);
		const marked = (context as { marked: { use: (options: unknown) => void; parse: (text: string) => string } })
			.marked;
		const cjk = (context as { markedCjkFriendly: () => { tokenizer: { emStrong: unknown } } }).markedCjkFriendly;
		marked.use({ breaks: true, gfm: true, tokenizer: { emStrong: cjk().tokenizer.emStrong } });
		return marked;
	}

	it("renders emphasis delimited next to CJK punctuation", () => {
		const marked = createMarked();
		expect(marked.parse("**这是测试。**后面").trim()).toBe("<p><strong>这是测试。</strong>后面</p>");
		expect(marked.parse("**一句话说清：**一台机器").trim()).toBe("<p><strong>一句话说清：</strong>一台机器</p>");
	});

	it("keeps CommonMark flanking rules for non-CJK text", () => {
		const marked = createMarked();
		expect(marked.parse("**end.**Then next").trim()).toBe("<p>**end.**Then next</p>");
	});

	it("wires the extension into the export template", () => {
		const template = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");
		expect(template).toContain("emStrong: markedCjkFriendly().tokenizer.emStrong");
	});
});
