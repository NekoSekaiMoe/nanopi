import { describe, expect, it } from "vitest";
import { kindOf, promptWithAttachments, readAttachments } from "@/lib/attachments";

/** A File stand-in: the parser only reads `name`, `type`, `size`, and the bytes. */
function fakeFile(name: string, type: string, bytes: Uint8Array): File {
	return {
		name,
		type,
		size: bytes.length,
		arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
	} as unknown as File;
}

const encoder = new TextEncoder();

/** Minimal zip writer: stored entries only, which is enough to exercise the directory parse. */
function zip(files: Record<string, string>): Uint8Array {
	const chunks: Uint8Array[] = [];
	const directory: Uint8Array[] = [];
	let offset = 0;
	for (const [name, body] of Object.entries(files)) {
		const nameBytes = encoder.encode(name);
		const data = encoder.encode(body);
		const local = new Uint8Array(30 + nameBytes.length + data.length);
		const view = new DataView(local.buffer);
		view.setUint32(0, 0x04034b50, true);
		view.setUint16(26, nameBytes.length, true);
		view.setUint32(18, data.length, true);
		local.set(nameBytes, 30);
		local.set(data, 30 + nameBytes.length);
		chunks.push(local);

		const entry = new Uint8Array(46 + nameBytes.length);
		const entryView = new DataView(entry.buffer);
		entryView.setUint32(0, 0x02014b50, true);
		entryView.setUint16(10, 0, true);
		entryView.setUint32(20, data.length, true);
		entryView.setUint16(28, nameBytes.length, true);
		entryView.setUint32(42, offset, true);
		entry.set(nameBytes, 46);
		directory.push(entry);

		offset += local.length;
	}
	const body = chunks.reduce((total, chunk) => total + chunk.length, 0);
	const central = directory.reduce((total, chunk) => total + chunk.length, 0);
	const eocd = new Uint8Array(22);
	const eocdView = new DataView(eocd.buffer);
	eocdView.setUint32(0, 0x06054b50, true);
	eocdView.setUint16(8, directory.length, true);
	eocdView.setUint16(10, directory.length, true);
	eocdView.setUint32(12, central, true);
	eocdView.setUint32(16, body, true);

	const out = new Uint8Array(body + central + eocd.length);
	let cursor = 0;
	for (const chunk of [...chunks, ...directory, eocd]) {
		out.set(chunk, cursor);
		cursor += chunk.length;
	}
	return out;
}

describe("attachment kinds", () => {
	it("goes by extension when the browser sends no useful type", () => {
		// A .csv from a file manager arrives as application/octet-stream; the name
		// is the only thing that still says what it is.
		expect(kindOf({ name: "rows.csv", type: "application/octet-stream" })).toBe("text");
		expect(kindOf({ name: "notes.md", type: "" })).toBe("text");
		expect(kindOf({ name: "report.pdf", type: "" })).toBe("pdf");
		expect(kindOf({ name: "spec.docx", type: "" })).toBe("docx");
		expect(kindOf({ name: "sheet.xlsx", type: "" })).toBe("xlsx");
		expect(kindOf({ name: "shot.png", type: "image/png" })).toBe("image");
		expect(kindOf({ name: "archive.zip", type: "application/zip" })).toBe("unsupported");
	});
});

describe("readAttachments", () => {
	it("extracts docx paragraphs", async () => {
		const docx = zip({
			"word/document.xml":
				'<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> world</w:t></w:r></w:p><w:p><w:r><w:t>second</w:t></w:r></w:p></w:body></w:document>',
		});
		const draft = await readAttachments([fakeFile("a.docx", "", docx)], 0);
		expect(draft.problems).toEqual([]);
		expect(draft.files[0]).toMatchObject({ name: "a.docx", kind: "docx" });
		expect(draft.files[0]?.text).toBe("Hello world\n\nsecond");
	});

	it("extracts xlsx cells row by row", async () => {
		const xlsx = zip({
			"xl/sharedStrings.xml": "<sst><si><t>Name</t></si><si><t>Alice</t></si></sst>",
			"xl/worksheets/sheet1.xml":
				'<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row><c><v>42</v></c></row></sheetData></worksheet>',
		});
		const draft = await readAttachments([fakeFile("a.xlsx", "", xlsx)], 0);
		expect(draft.problems).toEqual([]);
		expect(draft.files[0]?.text).toBe("# sheet1.xml\nName\tAlice\n42");
	});

	it("reports a scan instead of sending an empty PDF", async () => {
		// A PDF with no text operators is a picture of a page. Sending it as an
		// empty attachment would look like the model ignored the file.
		const pdf = encoder.encode("%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer\n<<>>\n%%EOF\n");
		const draft = await readAttachments([fakeFile("scan.pdf", "application/pdf", pdf)], 0);
		expect(draft.files).toEqual([]);
		expect(draft.problems[0]).toContain("scan.pdf");
	});

	it("keeps images and text apart in one pick", async () => {
		const draft = await readAttachments(
			[
				fakeFile("notes.txt", "text/plain", encoder.encode("hello")),
				fakeFile("bad.zip", "application/zip", encoder.encode("PK")),
			],
			0,
		);
		expect(draft.files).toHaveLength(1);
		expect(draft.problems).toHaveLength(1);
		expect(draft.problems[0]).toContain("bad.zip");
	});
});

describe("promptWithAttachments", () => {
	it("quotes each file so the model can tell it from the request", () => {
		const prompt = promptWithAttachments("summarise this", [
			{ name: "a.md", kind: "text", text: "# title" },
		]);
		expect(prompt.startsWith("summarise this")).toBe(true);
		expect(prompt).toContain("````a.md");
		expect(prompt).toContain("# title");
	});

	it("leaves a message without attachments untouched", () => {
		expect(promptWithAttachments("hi", [])).toBe("hi");
	});
});
