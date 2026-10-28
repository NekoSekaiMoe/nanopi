import { t } from "@/lib/i18n";

/**
 * What the composer can attach. Images travel as `ImageContent` (the only
 * binary the model API takes); everything else is read as text in the browser
 * and spliced into the prompt. Nothing in between: the wire has no attachment
 * type, and inventing one would mean a base64 blob the model cannot read.
 *
 * PDF is text extraction, not rendering, so a scanned page comes back empty and
 * the composer says so instead of sending an empty attachment.
 */

export type AttachmentKind = "image" | "text" | "pdf" | "docx" | "xlsx";

export interface TextAttachment {
	/** File name, carried into the prompt so the model can cite it. */
	name: string;
	kind: Exclude<AttachmentKind, "image">;
	text: string;
	/** Text was cut at MAX_ATTACHMENT_CHARS. */
	truncated?: boolean;
}

export interface AttachmentDraft {
	images: { media_type: string; data: string }[];
	files: TextAttachment[];
	/** One line per rejected file, in the order they were picked. */
	problems: string[];
}

export const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** One turn's worth of extracted text. Past this the prompt costs more than the file is worth. */
const MAX_ATTACHMENT_CHARS = 60_000;
/** A docx/xlsx is a zip; anything far past this is not a document a chat should swallow. */
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 8;
/** Fence for a quoted attachment; four backticks so a Markdown file cannot close it. */
const FENCE = "````";

export const ACCEPTED_FILES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"text/*",
	"application/json",
	"application/xml",
	"application/x-yaml",
	"application/javascript",
	"application/typescript",
	"application/pdf",
	".md",
	".markdown",
	".txt",
	".log",
	".csv",
	".tsv",
	".json",
	".jsonl",
	".yaml",
	".yml",
	".toml",
	".ini",
	".conf",
	".xml",
	".html",
	".css",
	".js",
	".mjs",
	".cjs",
	".ts",
	".tsx",
	".jsx",
	".py",
	".go",
	".rs",
	".java",
	".c",
	".h",
	".cpp",
	".hpp",
	".sh",
	".sql",
	".docx",
	".xlsx",
	".pdf",
].join(",");

/** Text decoded as UTF-8 when the bytes do not open with a BOM. */
const TEXT_DECODER = new TextDecoder("utf-8");
const LATIN1_DECODER = new TextDecoder("latin1");

export function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * How a file will be handled, from its name and MIME type. The extension wins:
 * a `.csv` served as `application/octet-stream` is still a table, and a `.docx`
 * arriving as `application/zip` is still a document.
 */
export function kindOf(file: { name: string; type: string }): AttachmentKind | "unsupported" {
	const ext = extensionOf(file.name);
	if (IMAGE_MIME.has(file.type) || ["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return "image";
	if (ext === "pdf" || file.type === "application/pdf") return "pdf";
	if (ext === "docx") return "docx";
	if (ext === "xlsx") return "xlsx";
	if (file.type.startsWith("text/")) return "text";
	if (["md", "markdown", "txt", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "conf", "xml", "html", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "go", "rs", "java", "c", "h", "cpp", "hpp", "sh", "sql"].includes(ext)) {
		return "text";
	}
	return "unsupported";
}

/** Read the picked files into image payloads and extracted text. */
export async function readAttachments(files: File[], existingImages: number): Promise<AttachmentDraft> {
	const draft: AttachmentDraft = { images: [], files: [], problems: [] };
	for (const file of files) {
		const kind = kindOf(file);
		if (kind === "unsupported") {
			draft.problems.push(`${file.name}: ${t("不支持这种文件")}`);
			continue;
		}
		if (kind === "image") {
			if (existingImages + draft.images.length >= MAX_IMAGES) {
				draft.problems.push(`${file.name}: ${t("最多 8 张图片")}`);
				continue;
			}
			if (file.size > MAX_IMAGE_BYTES) {
				draft.problems.push(`${file.name}: ${t("图片过大，请压缩后再上传")}`);
				continue;
			}
			try {
				draft.images.push(await readImage(file));
			} catch (cause) {
				draft.problems.push(`${file.name}: ${cause instanceof Error ? cause.message : t("读不了这个文件")}`);
			}
			continue;
		}
		if (file.size > MAX_FILE_BYTES) {
			draft.problems.push(`${file.name}: ${t("文件过大")}`);
			continue;
		}
		try {
			const text = await extractText(file, kind);
			if (!text.trim()) {
				draft.problems.push(`${file.name}: ${t("这个文件里没有可读的文本")}`);
				continue;
			}
			const clipped = text.length > MAX_ATTACHMENT_CHARS ? text.slice(0, MAX_ATTACHMENT_CHARS) : text;
			draft.files.push({ name: file.name, kind, text: clipped, truncated: clipped.length < text.length });
		} catch (cause) {
			draft.problems.push(`${file.name}: ${cause instanceof Error ? cause.message : t("读不了这个文件")}`);
		}
	}
	return draft;
}

function readImage(file: File): Promise<{ media_type: string; data: string }> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = String(reader.result ?? "");
			const comma = result.indexOf(",");
			if (comma < 0) {
				reject(new Error(t("读不了这个文件")));
				return;
			}
			resolve({ media_type: file.type || "image/png", data: result.slice(comma + 1) });
		};
		reader.onerror = () => reject(reader.error ?? new Error(t("读不了这个文件")));
		reader.readAsDataURL(file);
	});
}

async function extractText(file: File, kind: Exclude<AttachmentKind, "image">): Promise<string> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (kind === "docx") return docxText(bytes);
	if (kind === "xlsx") return xlsxText(bytes);
	if (kind === "pdf") return pdfText(bytes);
	// A BOM marks UTF-16; latin1 keeps a GBK log readable-ish instead of turning
	// it into replacement characters. Neither is a promise, both beat dropping it.
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
	const utf8 = TEXT_DECODER.decode(bytes);
	return utf8.includes("\uFFFD") ? LATIN1_DECODER.decode(bytes) : utf8;
}

/**
 * docx: `word/document.xml` inside the zip, paragraphs split on `</w:p>`, runs
 * concatenated. Zip inflation comes from the platform (DecompressionStream),
 * so no zip parser is bundled and nothing is trusted to a library.
 */
async function docxText(bytes: Uint8Array): Promise<string> {
	const xml = await zipEntry(bytes, "word/document.xml");
	if (xml === undefined) throw new Error(t("读不了这个文件"));
	const text = new TextDecoder("utf-8").decode(xml);
	const paragraphs: string[] = [];
	for (const para of text.split("</w:p>")) {
		let line = "";
		for (const match of para.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<\/w:br\s*\/>|<w:tab\s*\/>/g)) {
			if (match[0].startsWith("<w:tab")) line += "\t";
			else if (match[0].startsWith("</w:br")) line += "\n";
			else line += decodeXml(match[1]);
		}
		if (line.trim()) paragraphs.push(line);
	}
	return paragraphs.join("\n\n");
}

/**
 * xlsx: the sheet tables live in `xl/worksheets/sheetN.xml`; cell text is the
 * second-level shared string table plus inline strings. Only values are kept —
 * a model reading a spreadsheet wants the table, not the styling.
 */
async function xlsxText(bytes: Uint8Array): Promise<string> {
	const sharedXml = await zipEntry(bytes, "xl/sharedStrings.xml");
	const shared: string[] = [];
	if (sharedXml) {
		const xml = new TextDecoder("utf-8").decode(sharedXml);
		for (const item of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
			let value = "";
			for (const run of item[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) value += decodeXml(run[1]);
			shared.push(value);
		}
	}
	const entries = zipEntries(bytes);
	const sheets = [...entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort();
	if (sheets.length === 0) throw new Error(t("读不了这个文件"));
	const blocks: string[] = [];
	for (const name of sheets) {
		const raw = entries.get(name);
		if (!raw) continue;
		const inflated = await inflateZipEntry(raw);
		if (!inflated) continue;
		const xml = new TextDecoder("utf-8").decode(inflated);
		const rows: string[] = [];
		for (const row of xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
			const cells: string[] = [];
			for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
				const attrs = cell[1];
				const body = cell[2];
				const type = /t="([^"]+)"/.exec(attrs)?.[1];
				if (type === "inlineStr") {
					let value = "";
					for (const run of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) value += decodeXml(run[1]);
					cells.push(value);
					continue;
				}
				const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
				if (value === undefined) {
					cells.push("");
					continue;
				}
				cells.push(type === "s" ? (shared[Number(value)] ?? "") : decodeXml(value));
			}
			if (cells.some((cell) => cell.trim())) rows.push(cells.join("\t"));
		}
		if (rows.length) blocks.push(`# ${name.split("/").pop()}\n${rows.join("\n")}`);
	}
	return blocks.join("\n\n");
}

/**
 * PDF: text operators only. Content streams are inflated one by one, `Tj` and
 * `TJ` operands decoded, and a line break dropped wherever the text moves down
 * a line. Scanned pages have no `Tj` at all, so the caller reports them empty.
 */
async function pdfText(bytes: Uint8Array): Promise<string> {
	const latin = LATIN1_DECODER.decode(bytes);
	const pieces: string[] = [];
	for (const match of latin.matchAll(/stream\r?\n?/g)) {
		const start = match.index + match[0].length;
		const end = latin.indexOf("endstream", start);
		if (end < 0) continue;
		// The EOL before `endstream` belongs to the keyword, not to the stream: a
		// zlib decoder given that dangling byte reports trailing junk and returns
		// nothing, which reads as a scanned PDF.
		let stop = end;
		if (latin.charCodeAt(stop - 1) === 0x0a) stop -= 1;
		if (latin.charCodeAt(stop - 1) === 0x0d) stop -= 1;
		const chunk = bytes.subarray(start, stop);
		const inflated = await inflate(chunk, "deflate");
		const body = inflated ? LATIN1_DECODER.decode(inflated) : undefined;
		if (body) pieces.push(body);
	}
	const lines: string[] = [];
	for (const content of pieces) {
		let line = "";
		for (const token of content.matchAll(/(?:\[((?:\\.|[^\]\\])*)\]\s*TJ)|(?:\(((?:\\.|[^)\\])*)\)\s*Tj)|(T\*|Td|TD|ET)/g)) {
			if (token[1] !== undefined) {
				for (const str of token[1].matchAll(/\(((?:\\.|[^)\\])*)\)/g)) line += decodePdfString(str[1]);
			} else if (token[2] !== undefined) {
				line += decodePdfString(token[2]);
			} else {
				if (line.trim()) lines.push(line);
				line = "";
			}
		}
		if (line.trim()) lines.push(line);
	}
	return lines.join("\n");
}

function decodePdfString(raw: string): string {
	const decoded = raw.replace(/\\([nrtbf()\\])/g, (_all, char: string) => {
		switch (char) {
			case "n":
				return "\n";
			case "r":
				return "\r";
			case "t":
				return "\t";
			case "b":
				return "\b";
			case "f":
				return "\f";
			default:
				return char;
		}
	});
	// UTF-16BE text (PDF 1.5+ with a FE FF BOM) already decodes as latin1 above,
	// so re-encode the code units and reinterpret them.
	if (raw.includes("\\376\\377")) {
		const units: number[] = [];
		for (let index = 0; index < decoded.length; index += 1) units.push(decoded.charCodeAt(index));
		if (units[0] === 0xfe && units[1] === 0xff) return new TextDecoder("utf-16be").decode(new Uint8Array(units));
	}
	return decoded;
}

function decodeXml(raw: string): string {
	return raw
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_all, code: string) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_all, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
		.replace(/&amp;/g, "&");
}

interface ZipEntry {
	compress: number;
	bytes: Uint8Array;
}

/** Central directory parse: names, compression method, and the raw entry bytes. */
export function zipEntries(zip: Uint8Array): Map<string, ZipEntry> {
	const entries = new Map<string, ZipEntry>();
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	// End of central directory: scan backwards for the signature (0x06054b50).
	let eocd = -1;
	for (let index = zip.length - 22; index >= 0 && index >= zip.length - 65_557; index -= 1) {
		if (view.getUint32(index, true) === 0x06054b50) {
			eocd = index;
			break;
		}
	}
	if (eocd < 0) return entries;
	const count = view.getUint16(eocd + 10, true);
	let offset = view.getUint32(eocd + 16, true);
	for (let index = 0; index < count; index += 1) {
		if (offset + 46 > zip.length || view.getUint32(offset, true) !== 0x02014b50) break;
		const compress = view.getUint16(offset + 10, true);
		const size = view.getUint32(offset + 20, true);
		const nameLength = view.getUint16(offset + 28, true);
		const extraLength = view.getUint16(offset + 30, true);
		const commentLength = view.getUint16(offset + 32, true);
		const localOffset = view.getUint32(offset + 42, true);
		const name = new TextDecoder("utf-8").decode(zip.subarray(offset + 46, offset + 46 + nameLength));
		if (localOffset + 30 <= zip.length && view.getUint32(localOffset, true) === 0x04034b50) {
			const localName = view.getUint16(localOffset + 26, true);
			const localExtra = view.getUint16(localOffset + 28, true);
			const start = localOffset + 30 + localName + localExtra;
			entries.set(name, { compress, bytes: zip.subarray(start, start + size) });
		}
		offset += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

async function zipEntry(zip: Uint8Array, name: string): Promise<Uint8Array | undefined> {
	const entry = zipEntries(zip).get(name);
	if (!entry) return undefined;
	return inflateZipEntry(entry);
}

/** One zip entry: method 0 is stored, 8 is raw deflate, anything else is skipped. */
function inflateZipEntry(entry: ZipEntry): Promise<Uint8Array | undefined> {
	if (entry.compress === 0) return Promise.resolve(entry.bytes);
	if (entry.compress !== 8) return Promise.resolve(undefined);
	return inflate(entry.bytes, "deflate-raw");
}

/**
 * Inflate one blob and give up quietly on a bad one.
 *
 * The two callers need different formats and neither is negotiable: a zip entry
 * is raw deflate (`deflate-raw`), while a PDF content stream goes through zlib
 * and keeps its header (`deflate`). Getting it wrong throws
 * "invalid stored block lengths", which is exactly why the format is a
 * parameter instead of a guess.
 */
async function inflate(entry: Uint8Array, format: "deflate" | "deflate-raw"): Promise<Uint8Array | undefined> {
	try {
		const stream = new DecompressionStream(format);
		// A subarray of the zip keeps the parent buffer's type, which `write`
		// rejects; copy into a plain buffer first.
		const chunk = new Uint8Array(entry);
		void (async () => {
			const writer = stream.writable.getWriter();
			await writer.write(chunk);
			await writer.close();
		})().catch(() => {});
		return new Uint8Array(await new Response(stream.readable).arrayBuffer());
	} catch {
		return undefined;
	}
}

/**
 * The prompt text for a turn: the typed message first, then each file body in
 * a fenced block tagged with its name, so the model can tell a quoted file from
 * the request and can point at a line.
 */
export function promptWithAttachments(message: string, files: TextAttachment[]): string {
	if (files.length === 0) return message;
	const body = files
		.map((file) => {
			// Four backticks: pasted code and Markdown files routinely carry three.
			const note = file.truncated ? ` (${t("内容过长，已截断")})` : "";
			return `${FENCE}${file.name}${note}\n${file.text}\n${FENCE}`;
		})
		.join("\n\n");
	const head = message.trim() ? `${message.trim()}\n\n` : "";
	return `${head}${t("附件")}:\n${body}`;
}
