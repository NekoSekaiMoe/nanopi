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
 *
 * `textDocument/documentSymbol` reports every identifier of the file as a
 * function symbol, `textDocument/hover` echoes the identifier under the cursor,
 * and `textDocument/definition` points at the first line of the file - enough
 * for a test to tell which cursor the client resolved.
 *
 * FAKE_LSP_NO_SYMBOLS=1 makes documentSymbol fail with an error, which is how a
 * test covers a server that does not implement it.
 *
 * `textDocument/references` answers one usage of the identifier under the
 * cursor per line of the file, on that line. FAKE_LSP_NO_CALL_HIERARCHY=1 drops
 * callHierarchyProvider from the capabilities, which is how a test covers a
 * server that only knows references.
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
const noSymbols = process.env.FAKE_LSP_NO_SYMBOLS === "1";
const noCallHierarchy = process.env.FAKE_LSP_NO_CALL_HIERARCHY === "1";

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

/** Every identifier on its own line, as a function symbol. */
function documentSymbols(uri, text) {
	const lines = text.split(/\r?\n/);
	const symbols = [];
	lines.forEach((line, index) => {
		for (const match of line.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
			const start = { line: index, character: match.index };
			const end = { line: index, character: match.index + match[0].length };
			symbols.push({ name: match[0], kind: 12, range: { start, end }, selectionRange: { start, end } });
		}
	});
	return symbols;
}

/** The identifier at the cursor, so a test can read back which position was resolved. */
function wordAt(uri, position) {
	const text = documents.get(uri) ?? "";
	const line = text.split(/\r?\n/)[Number(position.line)] ?? "";
	const match = /[A-Za-z_$][A-Za-z0-9_$]*/g;
	for (const token of line.matchAll(match)) {
		const end = token.index + token[0].length;
		if (position.character >= token.index && position.character <= end) return token[0];
	}
	return "";
}

function dispatch(message) {
	const { id, method, params } = message;
	if (method === "$/cancelRequest") {
		record(`cancel ${params?.id}`);
		return;
	}
	if (method === "initialize") {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				capabilities: {
					textDocumentSync: 1,
					...(noCallHierarchy ? {} : { callHierarchyProvider: true }),
					hoverProvider: true,
					definitionProvider: true,
					...(noSymbols ? {} : { documentSymbolProvider: true }),
				},
			},
		});
		return;
	}
	if (method === "textDocument/documentSymbol") {
		if (noSymbols) {
			send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
			return;
		}
		send({ jsonrpc: "2.0", id, result: documentSymbols(params.textDocument.uri, documents.get(params.textDocument.uri) ?? "") });
		return;
	}
	if (method === "textDocument/hover") {
		const word = wordAt(params.textDocument.uri, params.position);
		send({ jsonrpc: "2.0", id, result: word ? { contents: { kind: "markdown", value: `hover: ${word}` } } : null });
		return;
	}
	if (method === "textDocument/definition") {
		const word = wordAt(params.textDocument.uri, params.position);
		const range = { start: { line: 0, character: 0 }, end: { line: 0, character: word.length } };
		send({ jsonrpc: "2.0", id, result: word ? [{ uri: params.textDocument.uri, range }] : null });
		return;
	}
	if (method === "textDocument/references") {
		const word = wordAt(params.textDocument.uri, params.position);
		const text = documents.get(params.textDocument.uri) ?? "";
		const usages = [];
		text.split(/\r?\n/).forEach((line, index) => {
			if (!word) return;
			const column = line.indexOf(word);
			if (column < 0) return;
			usages.push({
				uri: params.textDocument.uri,
				range: { start: { line: index, character: column }, end: { line: index, character: column + word.length } },
			});
		});
		send({ jsonrpc: "2.0", id, result: usages });
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
