/**
 * Streaming line reads for the read tool, which shows a slice of a possibly huge file.
 *
 * `readFile()` returns the whole file as one string, so `read` with `offset`/`limit` on a
 * multi-gigabyte log still parsed every byte to print twenty lines, and the OOM came before
 * any output. The reader here walks the stream instead: it keeps only the requested lines and
 * counts the rest, so memory follows the page rather than the file.
 */

import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";

/** How to decode the file as text. */
export type FileTextEncoding = "utf8" | "utf16le";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);

/**
 * Detect the encoding from a leading BOM, or null for a plain UTF-8 file.
 *
 * Only a BOM is trusted. Decoded as UTF-8 a UTF-16 file is a wall of `\0` with no visible line
 * breaks, so the guess has to happen before the read; guessing from content instead would turn
 * binary files into mojibake.
 */
export function detectTextEncoding(head: Buffer): FileTextEncoding | null {
	if (head.length >= 3 && head.subarray(0, 3).equals(UTF8_BOM)) return "utf8";
	if (head.length >= 2 && head.subarray(0, 2).equals(UTF16LE_BOM)) return "utf16le";
	return null;
}

/** The leading bytes of a file, so encoding detection does not read the whole thing. */
async function readHead(absolutePath: string): Promise<Buffer> {
	const handle = await open(absolutePath, "r");
	try {
		const head = Buffer.alloc(UTF8_BOM.length);
		const { bytesRead } = await handle.read(head, 0, UTF8_BOM.length, 0);
		return head.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

export interface LinePage {
	/** The requested lines joined with `\n`, including the file's own trailing newline. */
	content: string;
	/** Lines in `content`, counted the way `"a\nb".split("\n")` counts them. */
	lineCount: number;
	/**
	 * Total lines in the file, counting the ones after the page. Undefined when the page filled a
	 * `lineLimit` before the file ended: the read stopped there, so the count is unknown.
	 */
	totalLines: number | undefined;
	/** Decoding used for the text, after BOM detection. */
	encoding: FileTextEncoding;
}

export interface LinePageOptions {
	/** 0-based line to start at. */
	startLine: number;
	/** Lines to keep from `startLine`. Omitted reads to the end of the file. */
	lineLimit?: number;
	/** Stops the read when the tool is cancelled. */
	signal?: AbortSignal;
}

/**
 * Read `lineLimit` lines from `startLine`.
 *
 * Every line is counted so the caller can report "of N lines" and how many are left, but only
 * the page is held in memory. Splitting happens on decoded chunks rather than through
 * `readline`, because `readline` drops the distinction between "ends with a newline" and "does
 * not": a file's trailing `\n` has to survive a read, or the model sees text the file does not
 * contain.
 */
export async function readLinePage(absolutePath: string, options: LinePageOptions): Promise<LinePage> {
	const { startLine, lineLimit, signal } = options;
	const encoding = detectTextEncoding(await readHead(absolutePath)) ?? "utf8";
	const stopAt = lineLimit === undefined ? Number.POSITIVE_INFINITY : startLine + lineLimit;
	const kept: string[] = [];
	let lineCount = 0;
	let partial = "";
	// Whether the page reaching the end of the file should carry the file's trailing newline.
	let endsWithNewline = true;
	// A page boundary keeps the `\r` of a `\r\n` only long enough to see the `\n` after it, so
	// every line the tool prints holds a plain `\n`.
	const dropTrailingCarriageReturn = (line: string): string => (line.endsWith("\r") ? line.slice(0, -1) : line);

	/** Newlines seen past the page, which keeps the file's trailing newline visible to it. */
	let newlinesBeyondPage = 0;

	const consume = (chunk: string): void => {
		partial += chunk;
		let newline = partial.indexOf("\n");
		while (newline !== -1) {
			if (lineCount >= startLine && lineCount < stopAt) {
				kept.push(dropTrailingCarriageReturn(partial.slice(0, newline)));
			} else if (lineCount >= stopAt) {
				newlinesBeyondPage++;
			}
			lineCount++;
			partial = partial.slice(newline + 1);
			newline = partial.indexOf("\n");
		}
	};

	// The stream does not take the signal: a signal aborted before the iterator attaches leaves the
	// stream destroyed inside its constructor, and the `'error'` that follows has no listener yet, so
	// the process dies on an uncaught `AbortError`. The loop checks the signal instead and owns
	// ending the stream. A file handle closes on `close` either way, including after an early return.
	const stream = createReadStream(absolutePath, { encoding });
	let complete = false;
	try {
		for await (const chunk of stream) {
			signal?.throwIfAborted();
			consume(chunk as string);
			// A page that already filled its `lineLimit` does not need the rest of the file. Stopping
			// here is what keeps `limit` cheap on a huge file; the line count stays undefined because
			// the remaining lines were never counted. The last chunk is read whole, so anything it
			// carried past the page is the file's own tail.
			if (lineCount >= stopAt) {
				complete = true;
				break;
			}
		}
	} finally {
		stream.destroy();
	}
	if (complete) {
		// The chunk that ended the page may also have carried the file's end, and the page keeps the
		// trailing newline only when it reaches that end: without it the page would end here anyway.
		endsWithNewline = partial.length === 0 && newlinesBeyondPage === 1;
	} else {
		// Text after the last newline is still a line, unless it is the empty string after a
		// trailing newline, which belongs to the newline itself.
		if (partial.length > 0) {
			if (lineCount >= startLine && lineCount < stopAt) kept.push(dropTrailingCarriageReturn(partial));
			lineCount++;
			endsWithNewline = false;
		}
	}

	// A BOM survives as U+FEFF once decoded; it is metadata, not part of line 1.
	let content = kept.join("\n").replace(/^\uFEFF/, "");
	// The page reproduces the file's own text, trailing newline included, whenever it reaches
	// the end of the file: dropping it would show the model content the file does not have.
	if (endsWithNewline && kept.length > 0) content += "\n";
	return { content, lineCount: kept.length, totalLines: complete ? undefined : lineCount, encoding };
}
