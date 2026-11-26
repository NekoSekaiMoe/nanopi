import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { attachJsonlLineReader, serializeJsonLine } from "../src/modes/rpc/jsonl.ts";

describe("RPC JSONL framing", () => {
	test("serializes strict JSONL records without escaping Unicode separators", () => {
		const line = serializeJsonLine({ text: "a\u2028b\u2029c" });

		expect(line).toContain("a\u2028b\u2029c");
		expect(line.endsWith("\n")).toBe(true);
		expect(JSON.parse(line.trim())).toEqual({ text: "a\u2028b\u2029c" });
	});

	test("splits on LF only and preserves U+2028/U+2029 inside payloads", async () => {
		const lines: string[] = [];
		const stream = Readable.from([serializeJsonLine({ text: "a\u2028b\u2029c" })]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toEqual({ text: "a\u2028b\u2029c" });
	});

	test("handles CRLF-delimited input", async () => {
		const lines: string[] = [];
		const stream = Readable.from([Buffer.from('{"a":1}\r\n{"b":2}\r\n')]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
	});

	test("keeps the next line separate when a handler throws", async () => {
		// A handler that throws must not leave its line in the pending buffer and prepend it to the next one.
		const lines: string[] = [];
		const stream = new Readable({ read() {} });
		// `data` listeners that throw surface as uncaught exceptions; count instead of failing the run.
		const uncaught: Error[] = [];
		const onUncaught = (error: Error) => uncaught.push(error);
		process.on("uncaughtException", onUncaught);

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
			if (lines.length === 1) throw new Error("handler failed");
		});

		stream.push(Buffer.from('{"a":1}\n'));
		stream.push(Buffer.from('{"b":2}\n'));
		stream.push(null);

		await new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		process.off("uncaughtException", onUncaught);
		expect(uncaught.map((error) => error.message)).toEqual(["handler failed"]);
		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
	});

	test("emits a final line without trailing LF", async () => {
		const lines: string[] = [];
		const stream = Readable.from([Buffer.from('{"a":1}')]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toEqual(['{"a":1}']);
	});
});
