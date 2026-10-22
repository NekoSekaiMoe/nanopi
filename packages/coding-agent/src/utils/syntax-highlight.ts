import hljs from "highlight.js/lib/core.js";
import abnf from "highlight.js/lib/languages/abnf.js";
import accesslog from "highlight.js/lib/languages/accesslog.js";
import actionscript from "highlight.js/lib/languages/actionscript.js";
import ada from "highlight.js/lib/languages/ada.js";
import angelscript from "highlight.js/lib/languages/angelscript.js";
import apache from "highlight.js/lib/languages/apache.js";
import applescript from "highlight.js/lib/languages/applescript.js";
import arcade from "highlight.js/lib/languages/arcade.js";
import armasm from "highlight.js/lib/languages/armasm.js";
import asciidoc from "highlight.js/lib/languages/asciidoc.js";
import autohotkey from "highlight.js/lib/languages/autohotkey.js";
import awk from "highlight.js/lib/languages/awk.js";
import bash from "highlight.js/lib/languages/bash.js";
import basic from "highlight.js/lib/languages/basic.js";
import bnf from "highlight.js/lib/languages/bnf.js";
import c from "highlight.js/lib/languages/c.js";
import cal from "highlight.js/lib/languages/cal.js";
import capnproto from "highlight.js/lib/languages/capnproto.js";
import clean from "highlight.js/lib/languages/clean.js";
import clojure from "highlight.js/lib/languages/clojure.js";
import cmake from "highlight.js/lib/languages/cmake.js";
import coffeescript from "highlight.js/lib/languages/coffeescript.js";
import coq from "highlight.js/lib/languages/coq.js";
import cpp from "highlight.js/lib/languages/cpp.js";
import crystal from "highlight.js/lib/languages/crystal.js";
import csharp from "highlight.js/lib/languages/csharp.js";
import csp from "highlight.js/lib/languages/csp.js";
import css from "highlight.js/lib/languages/css.js";
import d from "highlight.js/lib/languages/d.js";
import dart from "highlight.js/lib/languages/dart.js";
import diff from "highlight.js/lib/languages/diff.js";
import dns from "highlight.js/lib/languages/dns.js";
import dockerfile from "highlight.js/lib/languages/dockerfile.js";
import dos from "highlight.js/lib/languages/dos.js";
import ebnf from "highlight.js/lib/languages/ebnf.js";
import elixir from "highlight.js/lib/languages/elixir.js";
import elm from "highlight.js/lib/languages/elm.js";
import erlang from "highlight.js/lib/languages/erlang.js";
import fortran from "highlight.js/lib/languages/fortran.js";
import fsharp from "highlight.js/lib/languages/fsharp.js";
import gherkin from "highlight.js/lib/languages/gherkin.js";
import glsl from "highlight.js/lib/languages/glsl.js";
import go from "highlight.js/lib/languages/go.js";
import gradle from "highlight.js/lib/languages/gradle.js";
import groovy from "highlight.js/lib/languages/groovy.js";
import haml from "highlight.js/lib/languages/haml.js";
import handlebars from "highlight.js/lib/languages/handlebars.js";
import haskell from "highlight.js/lib/languages/haskell.js";
import haxe from "highlight.js/lib/languages/haxe.js";
import http from "highlight.js/lib/languages/http.js";
import hy from "highlight.js/lib/languages/hy.js";
import ini from "highlight.js/lib/languages/ini.js";
import java from "highlight.js/lib/languages/java.js";
import javascript from "highlight.js/lib/languages/javascript.js";
import json from "highlight.js/lib/languages/json.js";
import julia from "highlight.js/lib/languages/julia.js";
import kotlin from "highlight.js/lib/languages/kotlin.js";
import latex from "highlight.js/lib/languages/latex.js";
import ldif from "highlight.js/lib/languages/ldif.js";
import less from "highlight.js/lib/languages/less.js";
import lisp from "highlight.js/lib/languages/lisp.js";
import livescript from "highlight.js/lib/languages/livescript.js";
import llvm from "highlight.js/lib/languages/llvm.js";
import lua from "highlight.js/lib/languages/lua.js";
import makefile from "highlight.js/lib/languages/makefile.js";
import markdown from "highlight.js/lib/languages/markdown.js";
import matlab from "highlight.js/lib/languages/matlab.js";
import mizar from "highlight.js/lib/languages/mizar.js";
import mojolicious from "highlight.js/lib/languages/mojolicious.js";
import n1ql from "highlight.js/lib/languages/n1ql.js";
import nginx from "highlight.js/lib/languages/nginx.js";
import nim from "highlight.js/lib/languages/nim.js";
import nix from "highlight.js/lib/languages/nix.js";
import nsis from "highlight.js/lib/languages/nsis.js";
import objectivec from "highlight.js/lib/languages/objectivec.js";
import ocaml from "highlight.js/lib/languages/ocaml.js";
import openscad from "highlight.js/lib/languages/openscad.js";
import oxygene from "highlight.js/lib/languages/oxygene.js";
import perl from "highlight.js/lib/languages/perl.js";
import pf from "highlight.js/lib/languages/pf.js";
import pgsql from "highlight.js/lib/languages/pgsql.js";
import php from "highlight.js/lib/languages/php.js";
import plaintext from "highlight.js/lib/languages/plaintext.js";
import pony from "highlight.js/lib/languages/pony.js";
import powershell from "highlight.js/lib/languages/powershell.js";
import processing from "highlight.js/lib/languages/processing.js";
import profile from "highlight.js/lib/languages/profile.js";
import prolog from "highlight.js/lib/languages/prolog.js";
import properties from "highlight.js/lib/languages/properties.js";
import protobuf from "highlight.js/lib/languages/protobuf.js";
import purebasic from "highlight.js/lib/languages/purebasic.js";
import python from "highlight.js/lib/languages/python.js";
import q from "highlight.js/lib/languages/q.js";
import qml from "highlight.js/lib/languages/qml.js";
import r from "highlight.js/lib/languages/r.js";
import reasonml from "highlight.js/lib/languages/reasonml.js";
import ruby from "highlight.js/lib/languages/ruby.js";
import rust from "highlight.js/lib/languages/rust.js";
import sas from "highlight.js/lib/languages/sas.js";
import scala from "highlight.js/lib/languages/scala.js";
import scheme from "highlight.js/lib/languages/scheme.js";
import scss from "highlight.js/lib/languages/scss.js";
import shell from "highlight.js/lib/languages/shell.js";
import smali from "highlight.js/lib/languages/smali.js";
import smalltalk from "highlight.js/lib/languages/smalltalk.js";
import sml from "highlight.js/lib/languages/sml.js";
import sql from "highlight.js/lib/languages/sql.js";
import stata from "highlight.js/lib/languages/stata.js";
import stylus from "highlight.js/lib/languages/stylus.js";
import subunit from "highlight.js/lib/languages/subunit.js";
import swift from "highlight.js/lib/languages/swift.js";
import tap from "highlight.js/lib/languages/tap.js";
import tcl from "highlight.js/lib/languages/tcl.js";
import thrift from "highlight.js/lib/languages/thrift.js";
import tp from "highlight.js/lib/languages/tp.js";
import twig from "highlight.js/lib/languages/twig.js";
import typescript from "highlight.js/lib/languages/typescript.js";
import vala from "highlight.js/lib/languages/vala.js";
import vbnet from "highlight.js/lib/languages/vbnet.js";
import vbscript from "highlight.js/lib/languages/vbscript.js";
import verilog from "highlight.js/lib/languages/verilog.js";
import vhdl from "highlight.js/lib/languages/vhdl.js";
import vim from "highlight.js/lib/languages/vim.js";
import x86asm from "highlight.js/lib/languages/x86asm.js";
import xml from "highlight.js/lib/languages/xml.js";
import xquery from "highlight.js/lib/languages/xquery.js";
import yaml from "highlight.js/lib/languages/yaml.js";
import zephir from "highlight.js/lib/languages/zephir.js";
import { decodeHtmlEntityAt } from "./html.ts";

/**
 * The grammars every build registers, in table order. Every one is a static
 * import the bundler follows: a downloaded highlight.js is 1.3 MiB of grammars,
 * and shipping all of them costs ~1.0 MiB over the set below, so the table is
 * the whole story about which languages highlight.
 *
 * The set is deliberate: the languages an agent session actually reads and
 * writes (shell, the mainstream languages, config and markup formats, query
 * languages, the esoteric ones that show up in a changelog diff). Adding a
 * language is one import plus one table entry; leaving one out costs a plain
 * render, never an error (`highlight()` falls back to the plain text).
 *
 * The build's `syntax-highlight` component decides whether this table is
 * registered at all: a build that drops the component aliases this module to
 * `syntax-highlight-disabled.ts` (see scripts/build-components.mjs), so the
 * grammars and highlight.js itself never reach the bundle. A source checkout
 * and npm install always carry them.
 */
const EAGER_LANGUAGES = {
	python,
	java,
	go,
	javascript,
	json,
	cpp,
	typescript,
	php,
	ruby,
	c,
	csharp,
	nix,
	bash,
	rust,
	scala,
	kotlin,
	swift,
	dart,
	groovy,
	perl,
	lua,
	xml,
	css,
	scss,
	less,
	yaml,
	ini,
	markdown,
	dockerfile,
	makefile,
	nginx,
	sql,
	pgsql,
	n1ql,
	powershell,
	objectivec,
	erlang,
	elixir,
	haskell,
	clojure,
	fsharp,
	ocaml,
	r,
	julia,
	fortran,
	lisp,
	scheme,
	vim,
	protobuf,
	cmake,
	vbnet,
	coffeescript,
	elm,
	crystal,
	nim,
	diff,
	http,
	awk,
	matlab,
	armasm,
	x86asm,
	llvm,
	reasonml,
	latex,
	haxe,
	properties,
	prolog,
	qml,
	tcl,
	twig,
	verilog,
	vhdl,
	xquery,
	glsl,
	d,
	basic,
	ada,
	applescript,
	asciidoc,
	autohotkey,
	bnf,
	abnf,
	ebnf,
	capnproto,
	clean,
	coq,
	csp,
	cal,
	dns,
	dos,
	gherkin,
	gradle,
	haml,
	handlebars,
	hy,
	ldif,
	livescript,
	mojolicious,
	mizar,
	nsis,
	openscad,
	oxygene,
	pf,
	plaintext,
	pony,
	processing,
	profile,
	purebasic,
	q,
	sas,
	shell,
	smali,
	smalltalk,
	sml,
	stata,
	stylus,
	subunit,
	tap,
	thrift,
	tp,
	vala,
	vbscript,
	zephir,
	angelscript,
	apache,
	accesslog,
	arcade,
	actionscript,
};

for (const [name, language] of Object.entries(EAGER_LANGUAGES)) {
	hljs.registerLanguage(name, language);
}

/**
 * Grammars the eager table cannot carry, still reachable through
 * `highlight.js/lib/index.js` for a session that asks for one of them.
 */
let allLanguagesPromise: Promise<void> | undefined;

/** Loads the grammars outside `EAGER_LANGUAGES` on demand. A no-op in most sessions. */
export function loadAllHighlightLanguages(): Promise<void> {
	if (!allLanguagesPromise) {
		allLanguagesPromise = new Promise((resolve) => {
			setImmediate(() => {
				void import("highlight.js/lib/index.js").then(
					() => resolve(),
					() => {
						// Eager languages and plaintext fallback remain available.
						resolve();
					},
				);
			});
		});
	}
	return allLanguagesPromise;
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

export function supportsLanguage(name: string): boolean {
	return hljs.getLanguage(name) !== undefined;
}
