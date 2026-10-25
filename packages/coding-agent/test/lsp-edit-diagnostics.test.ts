import { chmodSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectEditDiagnostics } from "../src/extras/pi-lsp-mini/src/edit-diagnostics.ts";
import { LspManager } from "../src/extras/pi-lsp-mini/src/manager.ts";
import { DEFAULT_EDIT_DIAGNOSTICS, loadEditDiagnosticsSettings } from "../src/extras/pi-lsp-mini/src/settings.ts";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Minimal LSP server: publishes one diagnostic per didOpen/didChange whose
 * message carries the document version, so a test can tell which content the
 * report came from.
 */
const FAKE_SERVER = String.raw`#!/usr/bin/env node
const { stdin, stdout } = process;
let buffer = Buffer.alloc(0);
let doctorVersion = 0;
function send(message) {
	const body = JSON.stringify(message);
	stdout.write("Content-Length: " + Buffer.byteLength(body) + "\r\n\r\n" + body);
}
function publish(uri, version) {
	send({
		jsonrpc: "2.0",
		method: "textDocument/publishDiagnostics",
		params: {
			uri,
			diagnostics: version === 0
				? [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "pre-edit snapshot v0" }]
				: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "content v" + version }],
		},
	});
}
stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	while (true) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd === -1) return;
		const lengthMatch = /Content-Length: (\d+)/i.exec(buffer.slice(0, headerEnd).toString());
		if (!lengthMatch) return;
		const length = Number(lengthMatch[1]);
		const start = headerEnd + 4;
		if (buffer.length < start + length) return;
		const message = JSON.parse(buffer.slice(start, start + length).toString());
		buffer = buffer.slice(start + length);
		if (message.method === "initialize") {
			send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
		} else if (message.method === "textDocument/didOpen") {
			const { uri } = message.params.textDocument;
			setTimeout(() => publish(uri, 0), 5);
		} else if (message.method === "textDocument/didChange") {
			const { uri, version } = message.params.textDocument;
			setTimeout(() => publish(uri, version), 5);
		} else if (message.id !== undefined) {
			send({ jsonrpc: "2.0", id: message.id, result: null });
		}
	}
});
`;

async function setupFakeServer(): Promise<{ dir: string; file: string; previousPath: string | undefined }> {
	const binDir = await createTempDir("lsp-fake-bin-");
	const workspace = await createTempDir("lsp-fake-ws-");
	const binary = join(binDir, "fake-lsp");
	await writeFile(binary, FAKE_SERVER);
	chmodSync(binary, 0o755);
	const file = join(workspace, "sample.fakels");
	await writeFile(file, "one\n");
	const previousPath = process.env.PATH;
	process.env.PATH = [binDir, previousPath].join(delimiter);
	process.env.NANOPI_CODING_AGENT_DIR = await createTempDir("lsp-fake-cfg-");
	await writeFile(
		join(process.env.NANOPI_CODING_AGENT_DIR, "lsp.json"),
		JSON.stringify({
			servers: [{ id: "fake", command: "fake-lsp", include: [".fakels"], rootMarkers: ["sample.fakels"] }],
		}),
	);
	return { dir: workspace, file, previousPath };
}

const settings = { ...DEFAULT_EDIT_DIAGNOSTICS, enabled: true, timeoutMs: 4000 };

describe("lsp edit diagnostics", () => {
	it("reports only diagnostics published after the edit", async () => {
		const { dir, file, previousPath } = await setupFakeServer();
		const manager = new LspManager();
		try {
			// Open the pre-edit content first: the server publishes a snapshot for it,
			// the same way a real server answers a document it was already tracking.
			await manager.openFile({ cwd: dir }, file);
			await new Promise((resolve) => setTimeout(resolve, 250));
			await writeFile(file, "two\n");
			const report = await collectEditDiagnostics(manager, { cwd: dir }, "sample.fakels", settings);
			expect(report.lines.join("\n")).toContain("content v");
			expect(report.lines.join("\n")).not.toContain("pre-edit snapshot v0");
		} finally {
			await manager.shutdownAll();
			process.env.PATH = previousPath;
			delete process.env.NANOPI_CODING_AGENT_DIR;
		}
	});

	it("never fires when the setting is off", async () => {
		const { dir, file, previousPath } = await setupFakeServer();
		const manager = new LspManager();
		try {
			await writeFile(file, "two\n");
			const report = await collectEditDiagnostics(manager, { cwd: dir }, "sample.fakels", {
				...settings,
				enabled: false,
			});
			expect(report.lines).toEqual([]);
		} finally {
			await manager.shutdownAll();
			process.env.PATH = previousPath;
			delete process.env.NANOPI_CODING_AGENT_DIR;
		}
	});

	it("returns nothing for a file no server matches", async () => {
		const { dir, previousPath } = await setupFakeServer();
		const manager = new LspManager();
		try {
			const report = await collectEditDiagnostics(manager, { cwd: dir }, "unknown.unknown", settings);
			expect(report.lines).toEqual([]);
		} finally {
			await manager.shutdownAll();
			process.env.PATH = previousPath;
			delete process.env.NANOPI_CODING_AGENT_DIR;
		}
	});
});

describe("edit diagnostics settings", () => {
	it("defaults to disabled", async () => {
		const configDir = await createTempDir("lsp-settings-");
		expect(loadEditDiagnosticsSettings(join(configDir, "missing.json"))).toEqual(DEFAULT_EDIT_DIAGNOSTICS);
	});

	it("reads the opt-in flag and caps", async () => {
		const configDir = await createTempDir("lsp-settings-");
		const path = join(configDir, "lsp.json");
		await writeFile(path, JSON.stringify({ editDiagnostics: { enabled: true, timeoutMs: 1200, maxDiagnostics: 3 } }));
		expect(loadEditDiagnosticsSettings(path)).toMatchObject({ enabled: true, timeoutMs: 1200, maxDiagnostics: 3 });
	});
});
