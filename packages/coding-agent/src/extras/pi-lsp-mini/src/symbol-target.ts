import fs from "node:fs/promises";
import { delay } from "./manager.ts";
import type { LspClient } from "./client.ts";
import type { DocumentSymbol, SymbolInformation } from "./lsp-types.ts";
import type { Budget } from "./budget.ts";

/**
 * Finding the position a request is about.
 *
 * A hover or a definition needs a cursor, but a model asking "what does
 * `parseConfig` take" knows the name, not the column. Requiring a line/column
 * would only push the model back to reading the file, which is the cost these
 * tools exist to remove.
 *
 * So a name is answered by the server's own document symbols: fast, and
 * language-aware (it does not match the word inside a string literal or a
 * comment). The text scan is the fallback for servers that do not implement
 * `textDocument/documentSymbol` at all.
 */

export interface Cursor {
	line: number;
	character: number;
}

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** Maps a 1-based line/column to the 0-based cursor, snapping onto an identifier. */
export function snapToIdentifier(lines: string[], line: number, character: number): Cursor {
	const index = Math.min(Math.max(1, Math.trunc(line)) - 1, Math.max(0, lines.length - 1));
	const text = lines[index] ?? "";
	const isWord = (c: string | undefined): boolean => !!c && /[A-Za-z0-9_$]/.test(c);
	const wanted = Math.min(Math.max(1, Math.trunc(character)) - 1, text.length);
	if (isWord(text[wanted])) return { line: index, character: wanted };
	for (let c = wanted + 1; c < text.length; c++) if (isWord(text[c])) return { line: index, character: c };
	for (let c = wanted - 1; c >= 0; c--) if (isWord(text[c])) return { line: index, character: c };
	return { line: index, character: wanted };
}

/** Position of `symbol` as an identifier in the file text; undefined when the text does not contain it. */
export function locateInText(lines: string[], symbol: string): Cursor | undefined {
	for (let index = 0; index < lines.length; index++) {
		const text = lines[index] ?? "";
		IDENTIFIER.lastIndex = 0;
		for (let match = IDENTIFIER.exec(text); match; match = IDENTIFIER.exec(text)) {
			if (match[0] === symbol) return { line: index, character: match.index };
		}
	}
	return undefined;
}

export interface SymbolMatch {
	name: string;
	line: number;
	character: number;
	/** Empty when the position came from the file text rather than from the server. */
	container: string;
}

/**
 * First symbol whose name equals `symbol`, depth-first, so a nested method is
 * found before the class of the same name. Names may be qualified
 * (`Class.method`); the last segment is what a document symbol reports.
 */
export function findByName(
	symbols: DocumentSymbol[] | SymbolInformation[] | null,
	symbol: string,
): SymbolMatch | undefined {
	const segments = symbol.split(/[.#:]/).filter(Boolean);
	const wanted = segments.at(-1) ?? symbol;
	let found: SymbolMatch | undefined;
	const visit = (node: DocumentSymbol, container: string): void => {
		if (found) return;
		if (node.name === wanted) {
			found = {
				name: node.name,
				line: node.selectionRange.start.line,
				character: node.selectionRange.start.character,
				container,
			};
			return;
		}
		for (const child of node.children ?? []) visit(child, container ? `${container}.${node.name}` : node.name);
	};
	const list = symbols ?? [];
	if (list.length > 0 && "location" in list[0]) {
		for (const info of list as SymbolInformation[]) {
			if (found) break;
			if (info.name !== wanted) continue;
			found = {
				name: info.name,
				line: info.location.range.start.line,
				character: info.location.range.start.character,
				container: info.containerName ?? "",
			};
		}
	} else {
		for (const documentSymbol of list as DocumentSymbol[]) {
			if (found) break;
			visit(documentSymbol, "");
		}
	}
	return found;
}

/** A cursor on a declaration, and what was found there, for the report header. */
export interface ResolvedTarget {
	cursor: Cursor;
	/** How the cursor was obtained, for the report: `12:5`, `symbol 'foo' (12:5)`, `text 'foo' (12:5)`. */
	label: string;
	match?: SymbolMatch;
}

/**
 * Resolves `line`/`character` or `symbol` to a cursor on `file`.
 *
 * A named symbol that no source of truth can place is an empty string: the
 * caller turns that into "not found" instead of guessing a position, because a
 * hover answered for the wrong symbol costs more than no answer.
 */
export async function resolveTarget(
	client: LspClient,
	file: string,
	params: { line?: number; character?: number; symbol?: string },
	budget: Budget | undefined,
): Promise<ResolvedTarget | undefined> {
	const lines = (await fs.readFile(file, "utf8")).split(/\r?\n/);
	if (params.line !== undefined) {
		const cursor = snapToIdentifier(lines, params.line, params.character ?? 1);
		return { cursor, label: `${cursor.line + 1}:${cursor.character + 1}` };
	}
	const symbol = params.symbol?.trim();
	if (!symbol) return undefined;

	let symbols: DocumentSymbol[] | SymbolInformation[] | null = null;
	try {
		symbols = await client.documentSymbol(file, budget);
	} catch {
		// A server that does not implement documentSymbol still answers by text.
	}
	const match = findByName(symbols, symbol);
	if (match) {
		const label = match.container ? `${match.container}.${match.name}` : match.name;
		return { cursor: { line: match.line, character: match.character }, label: `'${label}'`, match };
	}
	const cursor = locateInText(lines, symbol);
	return cursor ? { cursor, label: `'${symbol}'`, match: undefined } : undefined;
}

