import type { Hover } from "./lsp-types.ts";

/**
 * Flattens the three shapes `textDocument/hover` returns (MarkupContent, a
 * MarkedString literal, or an array of either) into one string.
 */
export function hoverText(hover: Hover | null): string {
	const contents = hover?.contents;
	if (!contents) return "";
	const one = (part: unknown): string => {
		if (typeof part === "string") return part;
		if (!part || typeof part !== "object") return "";
		const value = (part as { value?: unknown }).value;
		if (typeof value !== "string") return "";
		const language = (part as { language?: unknown }).language;
		// A MarkedString with a language is already a fenced block and stays one;
		// a plain markdown value is passed through, since servers put the doc
		// comment's own markup in it.
		return typeof language === "string" ? `\`\`\`${language}\n${value}\n\`\`\`` : value;
	};
	const parts = Array.isArray(contents) ? contents.map(one) : [one(contents)];
	return parts
		.map((part) => part.trim())
		.filter(Boolean)
		.join("\n\n");
}

const MAX_HOVER_CHARS = 1600;

/**
 * Trims a hover to something worth the tokens.
 *
 * pyright and tsserver both answer with the whole doc comment, and rust-analyzer
 * with the item's attributes; at 4k characters the saving over reading the file
 * disappears. The cut lands on a line boundary so a fenced code block is not
 * left unclosed mid-answer.
 */
export function clampHover(text: string): string {
	if (text.length <= MAX_HOVER_CHARS) return text;
	const head = text.slice(0, MAX_HOVER_CHARS);
	const lastNewline = head.lastIndexOf("\n");
	const kept = lastNewline > MAX_HOVER_CHARS / 2 ? head.slice(0, lastNewline) : head;
	const dropped = text.length - kept.length;
	return `${kept}\n[... ${dropped} more characters]`;
}
