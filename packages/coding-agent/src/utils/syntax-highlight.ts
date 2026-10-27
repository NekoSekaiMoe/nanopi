import type { LanguageFn } from "highlight.js";
import hljs from "highlight.js/lib/core";
import { decodeHtmlEntityAt } from "./html.ts";

/**
 * The language tags that name a bundled grammar, six per line to keep the table
 * scannable. Nothing is imported until a code block in one of them is rendered:
 * loading every grammar up front costs ~75 ms and ~4.6 MiB of heap that a
 * session reading shell and TypeScript never spends. An unlisted tag is not an
 * error, only a plain render, and `xml` also answers to its `html` alias.
 */
const BUNDLED_LANGUAGES = new Set(
	[
		"1c abnf accesslog actionscript ada angelscript",
		"apache applescript arcade arduino armasm xml",
		"asciidoc aspectj autohotkey autoit avrasm awk",
		"axapta bash basic bnf brainfuck c",
		"c cal capnproto ceylon clean clojure",
		"clojure-repl cmake coffeescript coq cos cpp",
		"crmsh crystal csharp csp css d",
		"markdown dart delphi diff django dns",
		"dockerfile dos dsconfig dts dust ebnf",
		"elixir elm ruby erb erlang-repl erlang",
		"excel fix flix fortran fsharp gams",
		"gauss gcode gherkin glsl gml go",
		"golo gradle groovy haml handlebars haskell",
		"haxe hsp http hy inform7",
		"ini irpf90 isbl java javascript jboss-cli",
		"json julia julia-repl kotlin lasso latex",
		"ldif leaf less lisp livecodeserver livescript",
		"llvm lsl lua makefile mathematica matlab",
		"maxima mel mercury mipsasm mizar perl",
		"mojolicious monkey moonscript n1ql nginx nim",
		"nix node-repl nsis objectivec ocaml openscad",
		"oxygene parser3 pf pgsql php php-template",
		"plaintext pony powershell processing profile prolog",
		"properties protobuf puppet purebasic python python-repl",
		"q qml r reasonml rib roboconf",
		"routeros rsl ruleslanguage rust sas scala",
		"scheme scilab scss shell smali smalltalk",
		"sml sqf sql stan stata",
		"step21 stylus subunit swift taggerscript yaml",
		"tap tcl thrift tp twig typescript",
		"vala vbnet vbscript vbscript-html verilog vhdl",
		"vim x86asm xl xquery zephir",
	]
		.join(" ")
		.split(" "),
);

const grammarLoads = new Map<string, Promise<void>>();

/**
 * Grammar loads started so far, for a caller that wants to repaint once a
 * render settled. The promises resolve, never reject: a failed load leaves the
 * block plain, which is what a missing language renders as anyway.
 */
export function pendingHighlightLanguages(): Promise<void>[] {
	return [...grammarLoads.values()];
}

/**
 * Loads the grammar behind a language tag in the background, so the next render
 * of that language is colored. Module specifiers are matched as written by the
 * bundler, so every call site spells the same one, extension included.
 */
function preloadLanguage(name: string): void {
	if (grammarLoads.has(name)) return;
	const load = (): Promise<unknown> => {
		switch (name) {
			case "1c":
				return import("highlight.js/lib/languages/1c");
			case "abnf":
				return import("highlight.js/lib/languages/abnf");
			case "accesslog":
				return import("highlight.js/lib/languages/accesslog");
			case "actionscript":
				return import("highlight.js/lib/languages/actionscript");
			case "ada":
				return import("highlight.js/lib/languages/ada");
			case "angelscript":
				return import("highlight.js/lib/languages/angelscript");
			case "apache":
				return import("highlight.js/lib/languages/apache");
			case "applescript":
				return import("highlight.js/lib/languages/applescript");
			case "arcade":
				return import("highlight.js/lib/languages/arcade");
			case "arduino":
				return import("highlight.js/lib/languages/arduino");
			case "armasm":
				return import("highlight.js/lib/languages/armasm");
			case "xml":
				return import("highlight.js/lib/languages/xml");
			case "asciidoc":
				return import("highlight.js/lib/languages/asciidoc");
			case "aspectj":
				return import("highlight.js/lib/languages/aspectj");
			case "autohotkey":
				return import("highlight.js/lib/languages/autohotkey");
			case "autoit":
				return import("highlight.js/lib/languages/autoit");
			case "avrasm":
				return import("highlight.js/lib/languages/avrasm");
			case "awk":
				return import("highlight.js/lib/languages/awk");
			case "axapta":
				return import("highlight.js/lib/languages/axapta");
			case "bash":
				return import("highlight.js/lib/languages/bash");
			case "basic":
				return import("highlight.js/lib/languages/basic");
			case "bnf":
				return import("highlight.js/lib/languages/bnf");
			case "brainfuck":
				return import("highlight.js/lib/languages/brainfuck");
			case "c":
				return import("highlight.js/lib/languages/c");
			case "cal":
				return import("highlight.js/lib/languages/cal");
			case "capnproto":
				return import("highlight.js/lib/languages/capnproto");
			case "ceylon":
				return import("highlight.js/lib/languages/ceylon");
			case "clean":
				return import("highlight.js/lib/languages/clean");
			case "clojure":
				return import("highlight.js/lib/languages/clojure");
			case "clojure-repl":
				return import("highlight.js/lib/languages/clojure-repl");
			case "cmake":
				return import("highlight.js/lib/languages/cmake");
			case "coffeescript":
				return import("highlight.js/lib/languages/coffeescript");
			case "coq":
				return import("highlight.js/lib/languages/coq");
			case "cos":
				return import("highlight.js/lib/languages/cos");
			case "cpp":
				return import("highlight.js/lib/languages/cpp");
			case "crmsh":
				return import("highlight.js/lib/languages/crmsh");
			case "crystal":
				return import("highlight.js/lib/languages/crystal");
			case "csharp":
				return import("highlight.js/lib/languages/csharp");
			case "csp":
				return import("highlight.js/lib/languages/csp");
			case "css":
				return import("highlight.js/lib/languages/css");
			case "d":
				return import("highlight.js/lib/languages/d");
			case "markdown":
				return import("highlight.js/lib/languages/markdown");
			case "dart":
				return import("highlight.js/lib/languages/dart");
			case "delphi":
				return import("highlight.js/lib/languages/delphi");
			case "diff":
				return import("highlight.js/lib/languages/diff");
			case "django":
				return import("highlight.js/lib/languages/django");
			case "dns":
				return import("highlight.js/lib/languages/dns");
			case "dockerfile":
				return import("highlight.js/lib/languages/dockerfile");
			case "dos":
				return import("highlight.js/lib/languages/dos");
			case "dsconfig":
				return import("highlight.js/lib/languages/dsconfig");
			case "dts":
				return import("highlight.js/lib/languages/dts");
			case "dust":
				return import("highlight.js/lib/languages/dust");
			case "ebnf":
				return import("highlight.js/lib/languages/ebnf");
			case "elixir":
				return import("highlight.js/lib/languages/elixir");
			case "elm":
				return import("highlight.js/lib/languages/elm");
			case "ruby":
				return import("highlight.js/lib/languages/ruby");
			case "erb":
				return import("highlight.js/lib/languages/erb");
			case "erlang-repl":
				return import("highlight.js/lib/languages/erlang-repl");
			case "erlang":
				return import("highlight.js/lib/languages/erlang");
			case "excel":
				return import("highlight.js/lib/languages/excel");
			case "fix":
				return import("highlight.js/lib/languages/fix");
			case "flix":
				return import("highlight.js/lib/languages/flix");
			case "fortran":
				return import("highlight.js/lib/languages/fortran");
			case "fsharp":
				return import("highlight.js/lib/languages/fsharp");
			case "gams":
				return import("highlight.js/lib/languages/gams");
			case "gauss":
				return import("highlight.js/lib/languages/gauss");
			case "gcode":
				return import("highlight.js/lib/languages/gcode");
			case "gherkin":
				return import("highlight.js/lib/languages/gherkin");
			case "glsl":
				return import("highlight.js/lib/languages/glsl");
			case "gml":
				return import("highlight.js/lib/languages/gml");
			case "go":
				return import("highlight.js/lib/languages/go");
			case "golo":
				return import("highlight.js/lib/languages/golo");
			case "gradle":
				return import("highlight.js/lib/languages/gradle");
			case "groovy":
				return import("highlight.js/lib/languages/groovy");
			case "haml":
				return import("highlight.js/lib/languages/haml");
			case "handlebars":
				return import("highlight.js/lib/languages/handlebars");
			case "haskell":
				return import("highlight.js/lib/languages/haskell");
			case "haxe":
				return import("highlight.js/lib/languages/haxe");
			case "hsp":
				return import("highlight.js/lib/languages/hsp");
			case "http":
				return import("highlight.js/lib/languages/http");
			case "hy":
				return import("highlight.js/lib/languages/hy");
			case "inform7":
				return import("highlight.js/lib/languages/inform7");
			case "ini":
				return import("highlight.js/lib/languages/ini");
			case "irpf90":
				return import("highlight.js/lib/languages/irpf90");
			case "isbl":
				return import("highlight.js/lib/languages/isbl");
			case "java":
				return import("highlight.js/lib/languages/java");
			case "javascript":
				return import("highlight.js/lib/languages/javascript");
			case "jboss-cli":
				return import("highlight.js/lib/languages/jboss-cli");
			case "json":
				return import("highlight.js/lib/languages/json");
			case "julia":
				return import("highlight.js/lib/languages/julia");
			case "julia-repl":
				return import("highlight.js/lib/languages/julia-repl");
			case "kotlin":
				return import("highlight.js/lib/languages/kotlin");
			case "lasso":
				return import("highlight.js/lib/languages/lasso");
			case "latex":
				return import("highlight.js/lib/languages/latex");
			case "ldif":
				return import("highlight.js/lib/languages/ldif");
			case "leaf":
				return import("highlight.js/lib/languages/leaf");
			case "less":
				return import("highlight.js/lib/languages/less");
			case "lisp":
				return import("highlight.js/lib/languages/lisp");
			case "livecodeserver":
				return import("highlight.js/lib/languages/livecodeserver");
			case "livescript":
				return import("highlight.js/lib/languages/livescript");
			case "llvm":
				return import("highlight.js/lib/languages/llvm");
			case "lsl":
				return import("highlight.js/lib/languages/lsl");
			case "lua":
				return import("highlight.js/lib/languages/lua");
			case "makefile":
				return import("highlight.js/lib/languages/makefile");
			case "mathematica":
				return import("highlight.js/lib/languages/mathematica");
			case "matlab":
				return import("highlight.js/lib/languages/matlab");
			case "maxima":
				return import("highlight.js/lib/languages/maxima");
			case "mel":
				return import("highlight.js/lib/languages/mel");
			case "mercury":
				return import("highlight.js/lib/languages/mercury");
			case "mipsasm":
				return import("highlight.js/lib/languages/mipsasm");
			case "mizar":
				return import("highlight.js/lib/languages/mizar");
			case "perl":
				return import("highlight.js/lib/languages/perl");
			case "mojolicious":
				return import("highlight.js/lib/languages/mojolicious");
			case "monkey":
				return import("highlight.js/lib/languages/monkey");
			case "moonscript":
				return import("highlight.js/lib/languages/moonscript");
			case "n1ql":
				return import("highlight.js/lib/languages/n1ql");
			case "nginx":
				return import("highlight.js/lib/languages/nginx");
			case "nim":
				return import("highlight.js/lib/languages/nim");
			case "nix":
				return import("highlight.js/lib/languages/nix");
			case "node-repl":
				return import("highlight.js/lib/languages/node-repl");
			case "nsis":
				return import("highlight.js/lib/languages/nsis");
			case "objectivec":
				return import("highlight.js/lib/languages/objectivec");
			case "ocaml":
				return import("highlight.js/lib/languages/ocaml");
			case "openscad":
				return import("highlight.js/lib/languages/openscad");
			case "oxygene":
				return import("highlight.js/lib/languages/oxygene");
			case "parser3":
				return import("highlight.js/lib/languages/parser3");
			case "pf":
				return import("highlight.js/lib/languages/pf");
			case "pgsql":
				return import("highlight.js/lib/languages/pgsql");
			case "php":
				return import("highlight.js/lib/languages/php");
			case "php-template":
				return import("highlight.js/lib/languages/php-template");
			case "plaintext":
				return import("highlight.js/lib/languages/plaintext");
			case "pony":
				return import("highlight.js/lib/languages/pony");
			case "powershell":
				return import("highlight.js/lib/languages/powershell");
			case "processing":
				return import("highlight.js/lib/languages/processing");
			case "profile":
				return import("highlight.js/lib/languages/profile");
			case "prolog":
				return import("highlight.js/lib/languages/prolog");
			case "properties":
				return import("highlight.js/lib/languages/properties");
			case "protobuf":
				return import("highlight.js/lib/languages/protobuf");
			case "puppet":
				return import("highlight.js/lib/languages/puppet");
			case "purebasic":
				return import("highlight.js/lib/languages/purebasic");
			case "python":
				return import("highlight.js/lib/languages/python");
			case "python-repl":
				return import("highlight.js/lib/languages/python-repl");
			case "q":
				return import("highlight.js/lib/languages/q");
			case "qml":
				return import("highlight.js/lib/languages/qml");
			case "r":
				return import("highlight.js/lib/languages/r");
			case "reasonml":
				return import("highlight.js/lib/languages/reasonml");
			case "rib":
				return import("highlight.js/lib/languages/rib");
			case "roboconf":
				return import("highlight.js/lib/languages/roboconf");
			case "routeros":
				return import("highlight.js/lib/languages/routeros");
			case "rsl":
				return import("highlight.js/lib/languages/rsl");
			case "ruleslanguage":
				return import("highlight.js/lib/languages/ruleslanguage");
			case "rust":
				return import("highlight.js/lib/languages/rust");
			case "sas":
				return import("highlight.js/lib/languages/sas");
			case "scala":
				return import("highlight.js/lib/languages/scala");
			case "scheme":
				return import("highlight.js/lib/languages/scheme");
			case "scilab":
				return import("highlight.js/lib/languages/scilab");
			case "scss":
				return import("highlight.js/lib/languages/scss");
			case "shell":
				return import("highlight.js/lib/languages/shell");
			case "smali":
				return import("highlight.js/lib/languages/smali");
			case "smalltalk":
				return import("highlight.js/lib/languages/smalltalk");
			case "sml":
				return import("highlight.js/lib/languages/sml");
			case "sqf":
				return import("highlight.js/lib/languages/sqf");
			case "sql":
				return import("highlight.js/lib/languages/sql");
			case "stan":
				return import("highlight.js/lib/languages/stan");
			case "stata":
				return import("highlight.js/lib/languages/stata");
			case "step21":
				return import("highlight.js/lib/languages/step21");
			case "stylus":
				return import("highlight.js/lib/languages/stylus");
			case "subunit":
				return import("highlight.js/lib/languages/subunit");
			case "swift":
				return import("highlight.js/lib/languages/swift");
			case "taggerscript":
				return import("highlight.js/lib/languages/taggerscript");
			case "yaml":
				return import("highlight.js/lib/languages/yaml");
			case "tap":
				return import("highlight.js/lib/languages/tap");
			case "tcl":
				return import("highlight.js/lib/languages/tcl");
			case "thrift":
				return import("highlight.js/lib/languages/thrift");
			case "tp":
				return import("highlight.js/lib/languages/tp");
			case "twig":
				return import("highlight.js/lib/languages/twig");
			case "typescript":
				return import("highlight.js/lib/languages/typescript");
			case "vala":
				return import("highlight.js/lib/languages/vala");
			case "vbnet":
				return import("highlight.js/lib/languages/vbnet");
			case "vbscript":
				return import("highlight.js/lib/languages/vbscript");
			case "vbscript-html":
				return import("highlight.js/lib/languages/vbscript-html");
			case "verilog":
				return import("highlight.js/lib/languages/verilog");
			case "vhdl":
				return import("highlight.js/lib/languages/vhdl");
			case "vim":
				return import("highlight.js/lib/languages/vim");
			case "x86asm":
				return import("highlight.js/lib/languages/x86asm");
			case "xl":
				return import("highlight.js/lib/languages/xl");
			case "xquery":
				return import("highlight.js/lib/languages/xquery");
			case "zephir":
				return import("highlight.js/lib/languages/zephir");
			default:
				return import("highlight.js/lib/common");
		}
	};
	grammarLoads.set(
		name,
		load()
			.then((module) => {
				// A CommonJS grammar arrives as its `default` through esbuild and as the
				// module itself through a runner that resolves it: unwrap, then require a
				// function before handing it to highlight.js.
				const grammar: unknown = (module as { default?: unknown }).default ?? module;
				if (typeof grammar === "function") hljs.registerLanguage(name, grammar as LanguageFn);
			})
			.catch(() => {
				// A grammar that will not load renders plain, like an unknown language.
			}),
	);
}
export type HighlightFormatter = (text: string) => string;
export type HighlightTheme = Partial<Record<string, HighlightFormatter>>;

export interface HighlightOptions {
	language?: string;
	ignoreIllegals?: boolean;
	languageSubset?: string[];
	theme?: HighlightTheme;
}

const SPAN_CLOSE = "</span>";
const HIGHLIGHT_CLASS_PREFIX = "hljs-";

function getScopeFromSpanTag(tag: string): string | undefined {
	const match = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
	const classValue = match?.[1] ?? match?.[2];
	if (!classValue) {
		return undefined;
	}

	for (const className of classValue.split(/\s+/)) {
		if (className.startsWith(HIGHLIGHT_CLASS_PREFIX)) {
			return className.slice(HIGHLIGHT_CLASS_PREFIX.length);
		}
	}

	return undefined;
}

function getScopeFormatter(scope: string, theme: HighlightTheme): HighlightFormatter | undefined {
	const exact = theme[scope];
	if (exact) {
		return exact;
	}

	const dotIndex = scope.indexOf(".");
	if (dotIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dotIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	const dashIndex = scope.indexOf("-");
	if (dashIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dashIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	return undefined;
}

function getActiveFormatter(scopes: Array<string | undefined>, theme: HighlightTheme): HighlightFormatter | undefined {
	for (let i = scopes.length - 1; i >= 0; i--) {
		const scope = scopes[i];
		if (!scope) {
			continue;
		}
		const formatter = getScopeFormatter(scope, theme);
		if (formatter) {
			return formatter;
		}
	}
	return theme.default;
}

function isSpanOpenTagStart(html: string, index: number): boolean {
	if (!html.startsWith("<span", index)) {
		return false;
	}
	const nextChar = html[index + "<span".length];
	return nextChar === ">" || nextChar === " " || nextChar === "\t" || nextChar === "\n" || nextChar === "\r";
}

export function renderHighlightedHtml(html: string, theme: HighlightTheme = {}): string {
	let output = "";
	let textBuffer = "";
	const scopes: Array<string | undefined> = [];

	const flushText = () => {
		if (!textBuffer) {
			return;
		}
		const formatter = getActiveFormatter(scopes, theme);
		output += formatter
			? textBuffer
					.split("\n")
					.map((line) => (line ? formatter(line) : line))
					.join("\n")
			: textBuffer;
		textBuffer = "";
	};

	let index = 0;
	while (index < html.length) {
		if (isSpanOpenTagStart(html, index)) {
			const tagEndIndex = html.indexOf(">", index + 5);
			if (tagEndIndex !== -1) {
				flushText();
				const tag = html.slice(index, tagEndIndex + 1);
				const scope = getScopeFromSpanTag(tag);
				scopes.push(scope);
				index = tagEndIndex + 1;
				continue;
			}
		}

		if (html.startsWith(SPAN_CLOSE, index)) {
			flushText();
			if (scopes.length > 0) {
				scopes.pop();
			}
			index += SPAN_CLOSE.length;
			continue;
		}

		if (html[index] === "&") {
			const decoded = decodeHtmlEntityAt(html, index);
			if (decoded) {
				textBuffer += decoded.text;
				index += decoded.length;
				continue;
			}
		}

		textBuffer += html[index];
		index++;
	}

	flushText();
	return output;
}

export function highlight(code: string, options: HighlightOptions = {}): string {
	const html = options.language
		? hljs.highlight(code, {
				language: options.language,
				ignoreIllegals: options.ignoreIllegals,
			}).value
		: hljs.highlightAuto(code, options.languageSubset).value;
	return renderHighlightedHtml(html, options.theme);
}

/**
 * Whether a code block in `name` would be colored. A grammar that has not been
 * loaded yet is still supported: it starts loading here, and a caller that
 * renders again once `pendingHighlightLanguages()` settles picks the color up.
 * Checking a tag must never import anything, or a session that only lists code
 * block languages pays the bundler entry for all 191 grammars.
 */
export function supportsLanguage(name: string): boolean {
	if (hljs.getLanguage(name)) return true;
	if (!BUNDLED_LANGUAGES.has(name)) return false;
	preloadLanguage(name);
	return true;
}
