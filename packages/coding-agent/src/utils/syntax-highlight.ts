import hljs from "highlight.js/lib/core.js";
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
		"axapta bash basic bnf brainfuck c-like",
		"c cal capnproto ceylon clean clojure",
		"clojure-repl cmake coffeescript coq cos cpp",
		"crmsh crystal csharp csp css d",
		"markdown dart delphi diff django dns",
		"dockerfile dos dsconfig dts dust ebnf",
		"elixir elm ruby erb erlang-repl erlang",
		"excel fix flix fortran fsharp gams",
		"gauss gcode gherkin glsl gml go",
		"golo gradle groovy haml handlebars haskell",
		"haxe hsp htmlbars http hy inform7",
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
		"sml sqf sql_more sql stan stata",
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
				return import("highlight.js/lib/languages/1c.js");
			case "abnf":
				return import("highlight.js/lib/languages/abnf.js");
			case "accesslog":
				return import("highlight.js/lib/languages/accesslog.js");
			case "actionscript":
				return import("highlight.js/lib/languages/actionscript.js");
			case "ada":
				return import("highlight.js/lib/languages/ada.js");
			case "angelscript":
				return import("highlight.js/lib/languages/angelscript.js");
			case "apache":
				return import("highlight.js/lib/languages/apache.js");
			case "applescript":
				return import("highlight.js/lib/languages/applescript.js");
			case "arcade":
				return import("highlight.js/lib/languages/arcade.js");
			case "arduino":
				return import("highlight.js/lib/languages/arduino.js");
			case "armasm":
				return import("highlight.js/lib/languages/armasm.js");
			case "xml":
				return import("highlight.js/lib/languages/xml.js");
			case "asciidoc":
				return import("highlight.js/lib/languages/asciidoc.js");
			case "aspectj":
				return import("highlight.js/lib/languages/aspectj.js");
			case "autohotkey":
				return import("highlight.js/lib/languages/autohotkey.js");
			case "autoit":
				return import("highlight.js/lib/languages/autoit.js");
			case "avrasm":
				return import("highlight.js/lib/languages/avrasm.js");
			case "awk":
				return import("highlight.js/lib/languages/awk.js");
			case "axapta":
				return import("highlight.js/lib/languages/axapta.js");
			case "bash":
				return import("highlight.js/lib/languages/bash.js");
			case "basic":
				return import("highlight.js/lib/languages/basic.js");
			case "bnf":
				return import("highlight.js/lib/languages/bnf.js");
			case "brainfuck":
				return import("highlight.js/lib/languages/brainfuck.js");
			case "c-like":
				return import("highlight.js/lib/languages/c-like.js");
			case "c":
				return import("highlight.js/lib/languages/c.js");
			case "cal":
				return import("highlight.js/lib/languages/cal.js");
			case "capnproto":
				return import("highlight.js/lib/languages/capnproto.js");
			case "ceylon":
				return import("highlight.js/lib/languages/ceylon.js");
			case "clean":
				return import("highlight.js/lib/languages/clean.js");
			case "clojure":
				return import("highlight.js/lib/languages/clojure.js");
			case "clojure-repl":
				return import("highlight.js/lib/languages/clojure-repl.js");
			case "cmake":
				return import("highlight.js/lib/languages/cmake.js");
			case "coffeescript":
				return import("highlight.js/lib/languages/coffeescript.js");
			case "coq":
				return import("highlight.js/lib/languages/coq.js");
			case "cos":
				return import("highlight.js/lib/languages/cos.js");
			case "cpp":
				return import("highlight.js/lib/languages/cpp.js");
			case "crmsh":
				return import("highlight.js/lib/languages/crmsh.js");
			case "crystal":
				return import("highlight.js/lib/languages/crystal.js");
			case "csharp":
				return import("highlight.js/lib/languages/csharp.js");
			case "csp":
				return import("highlight.js/lib/languages/csp.js");
			case "css":
				return import("highlight.js/lib/languages/css.js");
			case "d":
				return import("highlight.js/lib/languages/d.js");
			case "markdown":
				return import("highlight.js/lib/languages/markdown.js");
			case "dart":
				return import("highlight.js/lib/languages/dart.js");
			case "delphi":
				return import("highlight.js/lib/languages/delphi.js");
			case "diff":
				return import("highlight.js/lib/languages/diff.js");
			case "django":
				return import("highlight.js/lib/languages/django.js");
			case "dns":
				return import("highlight.js/lib/languages/dns.js");
			case "dockerfile":
				return import("highlight.js/lib/languages/dockerfile.js");
			case "dos":
				return import("highlight.js/lib/languages/dos.js");
			case "dsconfig":
				return import("highlight.js/lib/languages/dsconfig.js");
			case "dts":
				return import("highlight.js/lib/languages/dts.js");
			case "dust":
				return import("highlight.js/lib/languages/dust.js");
			case "ebnf":
				return import("highlight.js/lib/languages/ebnf.js");
			case "elixir":
				return import("highlight.js/lib/languages/elixir.js");
			case "elm":
				return import("highlight.js/lib/languages/elm.js");
			case "ruby":
				return import("highlight.js/lib/languages/ruby.js");
			case "erb":
				return import("highlight.js/lib/languages/erb.js");
			case "erlang-repl":
				return import("highlight.js/lib/languages/erlang-repl.js");
			case "erlang":
				return import("highlight.js/lib/languages/erlang.js");
			case "excel":
				return import("highlight.js/lib/languages/excel.js");
			case "fix":
				return import("highlight.js/lib/languages/fix.js");
			case "flix":
				return import("highlight.js/lib/languages/flix.js");
			case "fortran":
				return import("highlight.js/lib/languages/fortran.js");
			case "fsharp":
				return import("highlight.js/lib/languages/fsharp.js");
			case "gams":
				return import("highlight.js/lib/languages/gams.js");
			case "gauss":
				return import("highlight.js/lib/languages/gauss.js");
			case "gcode":
				return import("highlight.js/lib/languages/gcode.js");
			case "gherkin":
				return import("highlight.js/lib/languages/gherkin.js");
			case "glsl":
				return import("highlight.js/lib/languages/glsl.js");
			case "gml":
				return import("highlight.js/lib/languages/gml.js");
			case "go":
				return import("highlight.js/lib/languages/go.js");
			case "golo":
				return import("highlight.js/lib/languages/golo.js");
			case "gradle":
				return import("highlight.js/lib/languages/gradle.js");
			case "groovy":
				return import("highlight.js/lib/languages/groovy.js");
			case "haml":
				return import("highlight.js/lib/languages/haml.js");
			case "handlebars":
				return import("highlight.js/lib/languages/handlebars.js");
			case "haskell":
				return import("highlight.js/lib/languages/haskell.js");
			case "haxe":
				return import("highlight.js/lib/languages/haxe.js");
			case "hsp":
				return import("highlight.js/lib/languages/hsp.js");
			case "htmlbars":
				return import("highlight.js/lib/languages/htmlbars.js");
			case "http":
				return import("highlight.js/lib/languages/http.js");
			case "hy":
				return import("highlight.js/lib/languages/hy.js");
			case "inform7":
				return import("highlight.js/lib/languages/inform7.js");
			case "ini":
				return import("highlight.js/lib/languages/ini.js");
			case "irpf90":
				return import("highlight.js/lib/languages/irpf90.js");
			case "isbl":
				return import("highlight.js/lib/languages/isbl.js");
			case "java":
				return import("highlight.js/lib/languages/java.js");
			case "javascript":
				return import("highlight.js/lib/languages/javascript.js");
			case "jboss-cli":
				return import("highlight.js/lib/languages/jboss-cli.js");
			case "json":
				return import("highlight.js/lib/languages/json.js");
			case "julia":
				return import("highlight.js/lib/languages/julia.js");
			case "julia-repl":
				return import("highlight.js/lib/languages/julia-repl.js");
			case "kotlin":
				return import("highlight.js/lib/languages/kotlin.js");
			case "lasso":
				return import("highlight.js/lib/languages/lasso.js");
			case "latex":
				return import("highlight.js/lib/languages/latex.js");
			case "ldif":
				return import("highlight.js/lib/languages/ldif.js");
			case "leaf":
				return import("highlight.js/lib/languages/leaf.js");
			case "less":
				return import("highlight.js/lib/languages/less.js");
			case "lisp":
				return import("highlight.js/lib/languages/lisp.js");
			case "livecodeserver":
				return import("highlight.js/lib/languages/livecodeserver.js");
			case "livescript":
				return import("highlight.js/lib/languages/livescript.js");
			case "llvm":
				return import("highlight.js/lib/languages/llvm.js");
			case "lsl":
				return import("highlight.js/lib/languages/lsl.js");
			case "lua":
				return import("highlight.js/lib/languages/lua.js");
			case "makefile":
				return import("highlight.js/lib/languages/makefile.js");
			case "mathematica":
				return import("highlight.js/lib/languages/mathematica.js");
			case "matlab":
				return import("highlight.js/lib/languages/matlab.js");
			case "maxima":
				return import("highlight.js/lib/languages/maxima.js");
			case "mel":
				return import("highlight.js/lib/languages/mel.js");
			case "mercury":
				return import("highlight.js/lib/languages/mercury.js");
			case "mipsasm":
				return import("highlight.js/lib/languages/mipsasm.js");
			case "mizar":
				return import("highlight.js/lib/languages/mizar.js");
			case "perl":
				return import("highlight.js/lib/languages/perl.js");
			case "mojolicious":
				return import("highlight.js/lib/languages/mojolicious.js");
			case "monkey":
				return import("highlight.js/lib/languages/monkey.js");
			case "moonscript":
				return import("highlight.js/lib/languages/moonscript.js");
			case "n1ql":
				return import("highlight.js/lib/languages/n1ql.js");
			case "nginx":
				return import("highlight.js/lib/languages/nginx.js");
			case "nim":
				return import("highlight.js/lib/languages/nim.js");
			case "nix":
				return import("highlight.js/lib/languages/nix.js");
			case "node-repl":
				return import("highlight.js/lib/languages/node-repl.js");
			case "nsis":
				return import("highlight.js/lib/languages/nsis.js");
			case "objectivec":
				return import("highlight.js/lib/languages/objectivec.js");
			case "ocaml":
				return import("highlight.js/lib/languages/ocaml.js");
			case "openscad":
				return import("highlight.js/lib/languages/openscad.js");
			case "oxygene":
				return import("highlight.js/lib/languages/oxygene.js");
			case "parser3":
				return import("highlight.js/lib/languages/parser3.js");
			case "pf":
				return import("highlight.js/lib/languages/pf.js");
			case "pgsql":
				return import("highlight.js/lib/languages/pgsql.js");
			case "php":
				return import("highlight.js/lib/languages/php.js");
			case "php-template":
				return import("highlight.js/lib/languages/php-template.js");
			case "plaintext":
				return import("highlight.js/lib/languages/plaintext.js");
			case "pony":
				return import("highlight.js/lib/languages/pony.js");
			case "powershell":
				return import("highlight.js/lib/languages/powershell.js");
			case "processing":
				return import("highlight.js/lib/languages/processing.js");
			case "profile":
				return import("highlight.js/lib/languages/profile.js");
			case "prolog":
				return import("highlight.js/lib/languages/prolog.js");
			case "properties":
				return import("highlight.js/lib/languages/properties.js");
			case "protobuf":
				return import("highlight.js/lib/languages/protobuf.js");
			case "puppet":
				return import("highlight.js/lib/languages/puppet.js");
			case "purebasic":
				return import("highlight.js/lib/languages/purebasic.js");
			case "python":
				return import("highlight.js/lib/languages/python.js");
			case "python-repl":
				return import("highlight.js/lib/languages/python-repl.js");
			case "q":
				return import("highlight.js/lib/languages/q.js");
			case "qml":
				return import("highlight.js/lib/languages/qml.js");
			case "r":
				return import("highlight.js/lib/languages/r.js");
			case "reasonml":
				return import("highlight.js/lib/languages/reasonml.js");
			case "rib":
				return import("highlight.js/lib/languages/rib.js");
			case "roboconf":
				return import("highlight.js/lib/languages/roboconf.js");
			case "routeros":
				return import("highlight.js/lib/languages/routeros.js");
			case "rsl":
				return import("highlight.js/lib/languages/rsl.js");
			case "ruleslanguage":
				return import("highlight.js/lib/languages/ruleslanguage.js");
			case "rust":
				return import("highlight.js/lib/languages/rust.js");
			case "sas":
				return import("highlight.js/lib/languages/sas.js");
			case "scala":
				return import("highlight.js/lib/languages/scala.js");
			case "scheme":
				return import("highlight.js/lib/languages/scheme.js");
			case "scilab":
				return import("highlight.js/lib/languages/scilab.js");
			case "scss":
				return import("highlight.js/lib/languages/scss.js");
			case "shell":
				return import("highlight.js/lib/languages/shell.js");
			case "smali":
				return import("highlight.js/lib/languages/smali.js");
			case "smalltalk":
				return import("highlight.js/lib/languages/smalltalk.js");
			case "sml":
				return import("highlight.js/lib/languages/sml.js");
			case "sqf":
				return import("highlight.js/lib/languages/sqf.js");
			case "sql_more":
				return import("highlight.js/lib/languages/sql_more.js");
			case "sql":
				return import("highlight.js/lib/languages/sql.js");
			case "stan":
				return import("highlight.js/lib/languages/stan.js");
			case "stata":
				return import("highlight.js/lib/languages/stata.js");
			case "step21":
				return import("highlight.js/lib/languages/step21.js");
			case "stylus":
				return import("highlight.js/lib/languages/stylus.js");
			case "subunit":
				return import("highlight.js/lib/languages/subunit.js");
			case "swift":
				return import("highlight.js/lib/languages/swift.js");
			case "taggerscript":
				return import("highlight.js/lib/languages/taggerscript.js");
			case "yaml":
				return import("highlight.js/lib/languages/yaml.js");
			case "tap":
				return import("highlight.js/lib/languages/tap.js");
			case "tcl":
				return import("highlight.js/lib/languages/tcl.js");
			case "thrift":
				return import("highlight.js/lib/languages/thrift.js");
			case "tp":
				return import("highlight.js/lib/languages/tp.js");
			case "twig":
				return import("highlight.js/lib/languages/twig.js");
			case "typescript":
				return import("highlight.js/lib/languages/typescript.js");
			case "vala":
				return import("highlight.js/lib/languages/vala.js");
			case "vbnet":
				return import("highlight.js/lib/languages/vbnet.js");
			case "vbscript":
				return import("highlight.js/lib/languages/vbscript.js");
			case "vbscript-html":
				return import("highlight.js/lib/languages/vbscript-html.js");
			case "verilog":
				return import("highlight.js/lib/languages/verilog.js");
			case "vhdl":
				return import("highlight.js/lib/languages/vhdl.js");
			case "vim":
				return import("highlight.js/lib/languages/vim.js");
			case "x86asm":
				return import("highlight.js/lib/languages/x86asm.js");
			case "xl":
				return import("highlight.js/lib/languages/xl.js");
			case "xquery":
				return import("highlight.js/lib/languages/xquery.js");
			case "zephir":
				return import("highlight.js/lib/languages/zephir.js");
			default:
				return import("highlight.js/lib/index.js");
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
				if (typeof grammar === "function") hljs.registerLanguage(name, grammar as HighlightJsLanguageFactory);
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
