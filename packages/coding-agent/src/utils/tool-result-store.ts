/**
 * Persistent store for tool output too large to keep in the model context.
 *
 * Files are private to the user: output can contain secrets, and a predictable
 * name in a shared temp dir would let another local user pre-create the path.
 */

import { randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

/** All stored files live under `<agentDir>/tool-results`. */
export const TOOL_RESULT_STORE_DIR = "tool-results";

/** Output can carry private data, so only the user may read these files. */
const STORE_FILE_MODE = 0o600;

export interface StoredToolResult {
	ref: string;
	path: string;
}

/** A ref is a lowercase name plus hex, so it cannot contain separators or `..`. */
export function isToolResultRef(ref: string): boolean {
	return /^[a-z0-9]{1,16}-[0-9a-f]{16}$/.test(ref);
}

export function getToolResultStoreDir(agentDir: string): string {
	return join(agentDir, TOOL_RESULT_STORE_DIR);
}

export function getToolResultPath(agentDir: string, ref: string): string {
	if (!isToolResultRef(ref)) throw new Error(`Invalid tool result ref: ${ref}`);
	return join(getToolResultStoreDir(agentDir), `${ref}.txt`);
}

/** Store one result and return the ref used to recall it. */
export async function storeToolResult(agentDir: string, text: string, prefix: string): Promise<StoredToolResult> {
	const dir = getToolResultStoreDir(agentDir);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const ref =
		prefix
			.replace(/[^a-z0-9]/gi, "")
			.slice(0, 16)
			.toLowerCase() || "tool";
	const unique = `${ref}-${randomBytes(8).toString("hex")}`;
	const path = getToolResultPath(agentDir, unique);
	const handle = await open(path, "wx", STORE_FILE_MODE);
	try {
		await handle.writeFile(text, "utf-8");
	} finally {
		await handle.close();
	}
	return { ref: unique, path };
}

export interface ToolResultPage {
	text: string;
	totalBytes: number;
	startByte: number;
	endByte: number;
	truncated: boolean;
}

/**
 * Read a bounded UTF-8 slice of a stored result.
 *
 * The cut lands on a character boundary: a UTF-8 continuation byte at either
 * edge would otherwise produce U+FFFD in the model's context.
 */
export async function readToolResult(
	agentDir: string,
	ref: string,
	offset = 0,
	maxBytes = 50 * 1024,
): Promise<ToolResultPage> {
	const path = getToolResultPath(agentDir, ref);
	const buffer = await readFile(path);
	const start = Math.min(Math.max(0, Math.floor(offset)), buffer.length);
	const rawEnd = Math.min(start + Math.max(1, Math.floor(maxBytes)), buffer.length);
	let end = rawEnd;
	while (end > start && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
	return {
		text: buffer.subarray(start, end).toString("utf-8"),
		totalBytes: buffer.length,
		startByte: start,
		endByte: end,
		truncated: end < buffer.length,
	};
}
