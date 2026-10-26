#!/usr/bin/env node
/**
 * Minimal LSP server for tests.
 *
 * Behavior is driven by the file content so a test can steer the server
 * without restarting it:
 *   - every publishDiagnostics reports `SEEN <n>`, where <n> counts the
 *     didOpen/didChange notifications received so far;
 *   - a line `UP TO N` reports one error per didChange version <= N, so a
 *     pre-edit publish can be told apart from a post-edit one.
 *
 * FAKE_LSP_STALE=1 makes the server publish a stale error on didOpen only,
 * and stay silent afterwards - the shape of a server that lags behind.
 *
 * FAKE_LSP_SLOW_MS=<n> delays every incoming message by n ms before handling it
 * (except `exit`), which is how a test sees the client-side request deadline: a
 * server that answers slower than the deadline must fail, and one that answers
 * faster must not.
 *
 * Every `$/cancelRequest` received is appended to the file named by
 * FAKE_LSP_LOG if set, one line per cancelled id. A test uses it to assert the
 * client actually withdrew a request it gave up on, instead of leaving the
 * server computing an answer nobody reads.
 *
 * `textDocument/prepareCallHierarchy` / `callHierarchy/incomingCalls` answer
 * FAKE_LSP_FANOUT callers (default 0), so a call-graph walk can be steered.
 */
import { Buffer } from "node:buffer";
import { appendFileSync } from "node:fs";

let buffer = Buffer.alloc(0);
let version = 0;
let publishSeq = 0;
const documents = new Map();

const stale = process.env.FAKE_LSP_STALE === "1";
const delayMs = Number(process.env.FAKE_LSP_DELAY_MS ?? 0);
const slowMs = Number(process.env.FAKE_LSP_SLOW_MS ?? 0);
const logFile = process.env.FAKE_LSP_LOG;
const fanout = Number(process.env.FAKE_LSP_FANOUT ?? 0);

function send(payload) {
	const body = Buffer.from(JSON.stringify(payload), "utf8");
	process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
	process.stdout.write(body);
}

function publish(uri, diagnostics) {
	publishSeq += 1;
	send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics, version: publishSeq } });
}

function toDiagnostics(text) {
	const limit = /UP TO (\d+)/.exec(text)?.[1];
	const diagnostics = [];
	if (limit !== undefined) {
		for (let i = 1; i <= Number(limit) && i <= version; i++) {
			diagnostics.push({
				range: { start: { line: i - 1, character: 2 }, end: { line: i - 1, character: 7 } },
				severity: 1,
				message: `error from version ${i}`,
				source: "fake",
			});
		}
	}
	return diagnostics;
}

function record(line) {
	if (!logFile) return;
	try {
		appendFileSync(logFile, `${line}\n`);
	} catch {
		// the test only reads this file; a logging failure must not change behavior
	}
}

function hierarchyItem(uri, name, line) {
	const range = { start: { line, character: 0 }, end: { line, character: 10 } };
	return { name, kind: 12, uri, range, selectionRange: range };
}

function dispatch(message) {
	const { id, method, params } = message;
	if (method === "$/cancelRequest") {
		record(`cancel ${params?.id}`);
		return;
	}
	if (method === "initialize") {
		send({ jsonrpc: "2.0", id, result: { capabilities: { textDocumentSync: 1, callHierarchyProvider: true } } });
		return;
	}
	if (method === "textDocument/prepareCallHierarchy") {
		send({ jsonrpc: "2.0", id, result: [hierarchyItem(params.textDocument.uri, "root", 0)] });
		return;
	}
	if (method === "callHierarchy/incomingCalls" || method === "callHierarchy/outgoingCalls") {
		const key = method === "callHierarchy/incomingCalls" ? "from" : "to";
		const children = [];
		for (let i = 0; i < fanout; i++) {
			children.push({
				[key]: hierarchyItem(`${params.item.uri}#${i}`, `child${i}`, i),
				fromRanges: [{ uri: params.item.uri, range: { start: { line: i, character: 0 }, end: { line: i, character: 4 } } }],
			});
		}
		send({ jsonrpc: "2.0", id, result: children });
		return;
	}
	if (method === "textDocument/didOpen") {
		version += 1;
		documents.set(params.textDocument.uri, params.textDocument.text);
		void schedulePublish(params.textDocument.uri, params.textDocument.text);
		return;
	}
	if (method === "textDocument/didChange") {
		version += 1;
		const text = params.contentChanges.at(-1)?.text ?? "";
		documents.set(params.textDocument.uri, text);
		if (!stale) void schedulePublish(params.textDocument.uri, text);
		return;
	}
	if (id !== undefined) send({ jsonrpc: "2.0", id, result: null });
}

function schedulePublish(uri, text) {
	const run = () => {
		publish(uri, toDiagnostics(text));
	};
	if (delayMs > 0) setTimeout(run, delayMs);
	else run();
}

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd < 0) return;
		const header = buffer.subarray(0, headerEnd).toString("utf8");
		const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1] ?? 0);
		const start = headerEnd + 4;
		if (buffer.length < start + length) return;
		const body = buffer.subarray(start, start + length).toString("utf8");
		buffer = buffer.subarray(start + length);
		const message = JSON.parse(body);
		if (message.method === "exit") dispatch(message);
		else if (slowMs > 0) setTimeout(() => dispatch(message), slowMs);
		else dispatch(message);
	}
});

process.stdin.on("end", () => process.exit(0));
