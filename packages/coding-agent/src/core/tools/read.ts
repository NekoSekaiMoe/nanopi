import type { AgentTool } from "@nanopi/pi-agent-core";
import type { Api, ImageContent, Model, ModelImageResizeOptions, TextContent } from "@nanopi/pi-ai";
import { constants, type Stats } from "fs";
import { access as fsAccess, readFile as fsReadFile, stat as fsStat } from "fs/promises";
import { type Static, Type } from "typebox";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import type { ModuleContext, ToolDefinition } from "../modules/types.ts";
import { readLinePage } from "./line-reader.ts";
import { resolveReadPathAsync } from "./path-utils.ts";
import { recordRead } from "./read-snapshot.ts";
import { readRenderers } from "./renderers/read.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export const readToolSystemPromptContribution = {
	snippet: "Read file contents",
	guidelines: [],
} as const;

export type ReadToolInput = Static<typeof readSchema>;

/**
 * Result for programmatic callers such as codemode scripts: the text for text files, and an image
 * block for images that codemode's `image()` accepts. `note` is the text that goes with the image,
 * such as resize hints. Property descriptions are left out so the type stays on one line in tool
 * descriptions.
 */
const readOutputSchema = Type.Union([
	Type.String(),
	Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String(), note: Type.String() }),
]);

export type ReadToolOutput = Static<typeof readOutputSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
	/** Stat the file so `edit` can tell later whether it changed. Omitted means "no snapshot". */
	stat?: (absolutePath: string) => Promise<{ size: number; mtimeMs: number }>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
	stat: (path) => fsStat(path),
};

export interface ReadToolOptions {
	/** Whether to auto-resize images. Default: true */
	autoResizeImages?: boolean;
	/** Fallback resize profile when the execution context has no model metadata. */
	resizeOptions?: ModelImageResizeOptions;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
}

/** The image block and its note, or the text for text files and images that could not be processed. */
function toReadOutput(content: (TextContent | ImageContent)[]): ReadToolOutput {
	const text = content.find((block) => block.type === "text")?.text ?? "";
	const image = content.find((block) => block.type === "image");
	return image ? { type: "image", data: image.data, mimeType: image.mimeType, note: text } : text;
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

/** What the path is, for the guard's error message. */
function describeKind(stats: Stats): string {
	if (stats.isDirectory()) return "a directory";
	if (stats.isFIFO()) return "a named pipe (FIFO)";
	if (stats.isSocket()) return "a socket";
	if (stats.isCharacterDevice()) return "a character device";
	if (stats.isBlockDevice()) return "a block device";
	return "not a regular file";
}

/**
 * Refuses anything that is not a regular file.
 *
 * Opening a FIFO or a character device blocks until a writer shows up: `read` on
 * a shell-created FIFO, on `/dev/tty`, or on a stale socket never returns, and
 * the agent loop hangs with no way out. The type check is the only thing that
 * stops the open from happening at all, so it runs before any read.
 */
function assertRegularFile(absolutePath: string, stats: Stats): void {
	if (stats.isFile()) return;
	throw new Error(`${absolutePath} is ${describeKind(stats)}, not a regular file. Use bash if you need its content.`);
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const fallbackResizeOptions = options?.resizeOptions;
	const ops = options?.operations ?? defaultReadOperations;
	return {
		name: "read",
		label: "read",
		description: `Read a file. Text is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB; page large files with offset/limit. Images (jpg, png, gif, webp, bmp) are sent as attachments.`,
		promptSnippet: readToolSystemPromptContribution.snippet,
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		parameters: readSchema,
		outputSchema: readOutputSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ModuleContext,
		) {
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							const absolutePath = await resolveReadPathAsync(path, ctx?.cwd || cwd);
							if (aborted) return;
							// Check if file exists and is readable.
							await ops.access(absolutePath);
							if (aborted) return;
							const stats = await fsStat(absolutePath);
							assertRegularFile(absolutePath, stats);
							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;
							const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
							if (mimeType) {
								// Read image as binary.
								const buffer = await ops.readFile(absolutePath);
								const processed = await processImage(buffer, mimeType, {
									autoResizeImages,
									resizeOptions: ctx?.model?.inputLimits?.images?.resize ?? fallbackResizeOptions,
								});
								if (!processed.ok) {
									let textNote = `Read image file [${mimeType}]\n${processed.message}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [{ type: "text", text: textNote }];
								} else {
									let textNote = `Read image file [${processed.mimeType}]`;
									if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: processed.data, mimeType: processed.mimeType },
									];
								}
							} else {
								// Snapshot the state this text came from, so a later edit can say
								// whether the model is working from an outdated view of the file.
								recordRead(absolutePath, { mtimeMs: stats.mtimeMs, size: stats.size });
								// Stream the file: only the page that will be shown is held in memory,
								// so offset/limit on a huge log no longer reads the whole log first.
								// Apply offset if specified. Convert from 1-indexed input to 0-based.
								const startLine = offset ? Math.max(0, offset - 1) : 0;
								const startLineDisplay = startLine + 1;
								// The reader stops once the page is full, so a `limit` read does not touch
								// the rest of the file. That leaves the file's line count unknowable here
								// (`totalFileLines === undefined`), and every notice below has to read
								// without it rather than claim a total it never counted.
								const page = await readLinePage(absolutePath, { startLine, lineLimit: limit, signal });
								const totalFileLines = page.totalLines;
								// Check if offset is out of bounds.
								if (totalFileLines !== undefined && startLine >= totalFileLines) {
									throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
								}
								const pageLines = page.content.split("\n");
								// Apply truncation, respecting both line and byte limits.
								const truncation = truncateHead(page.content);
								let outputText: string;
								if (truncation.firstLineExceedsLimit) {
									// First line alone exceeds the byte limit, and truncateHead never
									// returns part of a line, so there is no cheap way to show it. Say
									// which line it is and let the model decide (grep for a pattern
									// inside it, or edit around it) instead of handing out a shell
									// one-liner for what the read tool should have done.
									const firstLineSize = formatSize(Buffer.byteLength(pageLines[0] ?? "", "utf-8"));
									outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds the ${formatSize(DEFAULT_MAX_BYTES)} read limit, so it cannot be shown in full. Search for a pattern inside it with the grep tool, or edit around it with offset=${startLineDisplay}.]`;
									details = { truncation };
								} else if (truncation.truncated) {
									// Truncation occurred. Build an actionable continuation notice.
									const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
									const nextOffset = endLineDisplay + 1;
									const shown = `Showing lines ${startLineDisplay}-${endLineDisplay}`;
									outputText = truncation.content;
									if (truncation.truncatedBy === "lines") {
										outputText += `\n\n[${shown}${totalFileLines === undefined ? "" : ` of ${totalFileLines}`}. Use offset=${nextOffset} to continue.]`;
									} else {
										outputText += `\n\n[${shown}${totalFileLines === undefined ? "" : ` of ${totalFileLines}`} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
									}
									details = { truncation };
								} else if (totalFileLines === undefined) {
									// The read stopped at the requested limit instead of reaching the end of
									// the file, so there is more to read. `totalFileLines` is undefined
									// exactly in that case.
									const nextOffset = startLine + page.lineCount + 1;
									outputText = `${truncation.content}\n\n[Stopped after ${page.lineCount} line(s) at the requested limit. Use offset=${nextOffset} to continue.]`;
								} else {
									// No truncation and no remaining user-limited content.
									outputText = truncation.content;
								}
								content = [{ type: "text", text: outputText }];
							}

							if (aborted) return;
							signal?.removeEventListener("abort", onAbort);
							resolve({ content, details });
						} catch (error: any) {
							signal?.removeEventListener("abort", onAbort);
							if (!aborted) reject(error);
						}
					})();
				},
			).then((result) => ({ ...result, structuredContent: toReadOutput(result.content) }));
		},
		...readRenderers,
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
