import { resetCapabilitiesCache, setCapabilities } from "@nanopi/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMarkdownTheme, highlightCode, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import {
	highlight,
	pendingHighlightLanguages,
	renderHighlightedHtml,
	supportsLanguage,
} from "../src/utils/syntax-highlight.ts";

const bundledLanguages = ["python", "typescript", "bash", "rust", "xml", "coq", "sql_more"];
const bundledLanguagesReportedAtStartup = bundledLanguages.every(supportsLanguage);

describe("syntax highlight renderer", () => {
	// #252: every grammar is deferred, so no language is loadable at startup and
	// asking for one only starts the load. `notalanguage` is not bundled at all
	// and must not trigger one.
	it("defers every grammar until a code block asks for it", async () => {
		expect(bundledLanguagesReportedAtStartup).toBe(true);
		expect(supportsLanguage("notalanguage")).toBe(false);
		await Promise.all(pendingHighlightLanguages());
		for (const language of bundledLanguages) {
			expect(highlight("const value = 1", { language, ignoreIllegals: true })).toBeTruthy();
		}
	});

	it("renders highlighted spans with the provided theme", () => {
		const rendered = renderHighlightedHtml('<span class="hljs-keyword">const</span> value', {
			keyword: (text) => `[keyword:${text}]`,
		});
		expect(rendered).toBe("[keyword:const] value");
	});

	it("decodes HTML entities emitted by highlight.js", () => {
		const rendered = renderHighlightedHtml("&lt;tag attr=&quot;value&quot;&gt;&amp;#x41;&#65;&lt;/tag&gt;");
		expect(rendered).toBe('<tag attr="value">&#x41;A</tag>');
	});

	it("inherits parent formatting for unmapped nested scopes", () => {
		const interpolation = "$" + "{x}";
		const rendered = renderHighlightedHtml(
			`<span class="hljs-string">a<span class="hljs-subst">${interpolation}</span>b</span>`,
			{
				string: (text) => `[string:${text}]`,
			},
		);
		expect(rendered).toBe(`[string:a][string:${interpolation}][string:b]`);
	});

	it("keeps parent formatting across unscoped nested spans", () => {
		const rendered = renderHighlightedHtml('<span class="hljs-string">a<span class="language-xml">b</span>c</span>', {
			string: (text) => `[string:${text}]`,
		});
		expect(rendered).toBe("[string:a][string:b][string:c]");
	});

	it("highlights code through highlight.js", () => {
		expect(supportsLanguage("typescript")).toBe(true);
		const rendered = highlight("const value = 1", {
			language: "typescript",
			ignoreIllegals: true,
			theme: {
				keyword: (text) => `[keyword:${text}]`,
				number: (text) => `[number:${text}]`,
			},
		});
		expect(rendered).toContain("[keyword:const]");
		expect(rendered).toContain("[number:1]");
	});
});

describe("theme syntax highlighting", () => {
	beforeEach(async () => {
		// A grammar only becomes colorable once its load settled, and every test here
		// renders its first block synchronously.
		await Promise.all(["typescript", "python", "diff", "javascript"].map((language) => supportsLanguage(language)));
		await Promise.all(pendingHighlightLanguages());
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme();
	});

	afterEach(() => {
		resetCapabilitiesCache();
	});

	// #10143
	it("colors each line of Python docstrings independently", () => {
		const code = '"""\nline one\n\nline two\n"""\nafter';
		const ansi = theme.getFgAnsi("syntaxString");
		const expected = [
			`${ansi}"""\x1b[39m`,
			`${ansi}line one\x1b[39m`,
			"",
			`${ansi}line two\x1b[39m`,
			`${ansi}"""\x1b[39m`,
			"after",
		];

		expect(highlightCode(code, "python")).toEqual(expected);
		expect(getMarkdownTheme().highlightCode?.(code, "python")).toEqual(expected);
	});

	it("colors diff additions and deletions in fenced diff blocks", () => {
		const lines = highlightCode("-old\n+new\n", "diff");

		expect(lines[0]).toBe(`${theme.getFgAnsi("toolDiffRemoved")}-old\x1b[39m`);
		expect(lines[1]).toBe(`${theme.getFgAnsi("toolDiffAdded")}+new\x1b[39m`);
	});

	it("keeps cli-highlight default styled scopes mapped to theme styles", () => {
		expect(highlightCode("const re = /foo+/gi;", "javascript")[0]).toContain(
			`${theme.getFgAnsi("syntaxString")}/foo+/gi\x1b[39m`,
		);
		expect(highlightCode("@decorator", "python")[0]).toBe(theme.fg("muted", "@decorator"));
		expect(highlightCode("<div></div>", "html")[0]).toContain(`${theme.getFgAnsi("syntaxKeyword")}div\x1b[39m`);
	});
});
