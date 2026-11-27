import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callGraphReport } from "../callgraph.ts";
import { createBudget } from "../budget.ts";
import type { LspClient } from "../client.ts";
import { DEFAULT_SETTINGS, resetServersCache } from "../config.ts";
import { LspManager } from "../manager.ts";

const FAKE_SERVER = join(import.meta.dirname, "fixtures", "fake-lsp-server.mjs");

const temps: string[] = [];
const managers: LspManager[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lsp-budget-"));
	temps.push(dir);
	return dir;
}

interface Project {
	cwd: string;
	file: string;
	log: string;
}

/**
 * A project whose only server is the fake one, slowed by `slowMs` per message.
 * Every cancelled request is appended to a log file the test reads back.
 */
function project(slowMs: number, env: Record<string, string> = {}): Project {
	const cwd = tempDir();
	const agentDir = tempDir();
	writeFileSync(join(cwd, ".git"), "");
	const file = join(cwd, "sample.txt");
	writeFileSync(file, "first\nsecond\n");
	writeFileSync(
		join(agentDir, "lsp.json"),
		JSON.stringify({
			servers: [
				{ id: "fake", command: `${process.execPath} ${FAKE_SERVER}`, include: [".txt"], rootMarkers: [".git"], requestTimeout: 20_000 },
			],
		}),
	);
	const log = join(agentDir, "cancels.log");
	writeFileSync(log, "");
	process.env.NANOPI_CODING_AGENT_DIR = agentDir;
	process.env.FAKE_LSP_SLOW_MS = String(slowMs);
	process.env.FAKE_LSP_LOG = log;
	for (const [key, value] of Object.entries(env)) process.env[key] = value;
	resetServersCache();
	return { cwd, file, log };
}

function newManager(): LspManager {
	resetServersCache();
	const manager = new LspManager();
	managers.push(manager);
	return manager;
}

const savedEnv = { ...process.env };

afterEach(async () => {
	for (const key of ["FAKE_LSP_SLOW_MS", "FAKE_LSP_LOG", "FAKE_LSP_FANOUT", "NANOPI_CODING_AGENT_DIR"]) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	for (const manager of managers.splice(0)) await manager.shutdownAll();
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
	resetServersCache();
});

/** Polls the log for a cancel line, since the write crosses a process boundary. */
async function waitForCancel(log: string, timeoutMs = 2000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const text = readFileSync(log, "utf8");
		if (text.includes("cancel ")) return text;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return readFileSync(log, "utf8");
}

describe("request cancellation", () => {
	it("tells the server to drop a request that outlived its deadline", async () => {
		const { cwd, file, log } = project(1500);
		const manager = newManager();
		const opened = await manager.openFile({ cwd }, file);
		expect(opened).toBeDefined();

		const answer = await opened!.client
			.references(file, 0, 0, false, createBudget({ timeoutMs: 300, defaultTimeoutMs: 20_000 }))
			.then(() => "resolved", (error: Error) => error.message);
		expect(answer).toMatch(/timed out after 300ms/);

		// The request must not keep running server-side: without $/cancelRequest
		// the model's retry queues behind the answer nobody will read.
		expect(await waitForCancel(log)).toMatch(/cancel \d+/);
	});

	it("does not cancel a request that answered in time", async () => {
		const { cwd, file, log } = project(0);
		const manager = newManager();
		const opened = await manager.openFile({ cwd }, file);
		expect(opened).toBeDefined();

		await opened!.client.references(file, 0, 0, false, createBudget({ timeoutMs: 5000, defaultTimeoutMs: 20_000 }));
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(readFileSync(log, "utf8")).toBe("");
	});
});

describe("shared call-graph budget", () => {
	/** A client stand-in whose hops each take `hopMs` and whose graph never runs out of nodes. */
	function slowClient(hopMs: number): LspClient {
		const child = (uri: string, prefix: string) => ({ ...root, name: `${prefix}-${uri.slice(-6)}`, uri: `${uri}-${prefix}` });
		return {
			incomingCalls: (item: { uri: string }) =>
				new Promise((resolve) => setTimeout(() => resolve([{ from: child(item.uri, "p") }]), hopMs)),
			outgoingCalls: (item: { uri: string }) =>
				new Promise((resolve) => setTimeout(() => resolve([{ to: child(item.uri, "c") }]), hopMs)),
		} as unknown as LspClient;
	}

	const root = {
		name: "root",
		uri: "file:///nowhere/sample.txt",
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
		selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
	};

	it("spends one budget over the whole walk, not one per hop", async () => {
		const budget = createBudget({ timeoutMs: 600, defaultTimeoutMs: DEFAULT_SETTINGS.requestTimeout });
		const started = Date.now();
		const report = await callGraphReport(slowClient(250), root, "both", 3, budget);
		// Per-hop deadlines would allow depth x fan-out x 250ms; the walk stops
		// when the shared budget is gone.
		expect(Date.now() - started).toBeLessThan(1500);
		expect(report).toContain("budget spent");
	});

	it("leaves a walk inside the budget untruncated", async () => {
		const budget = createBudget({ timeoutMs: 20_000, defaultTimeoutMs: DEFAULT_SETTINGS.requestTimeout });
		const report = await callGraphReport(slowClient(10), root, "both", 1, budget);
		expect(report).not.toContain("budget spent");
		expect(report).toContain("Callers");
		expect(report).toContain("Callees");
	});

	it("keeps the hops it already collected when the budget runs out mid-walk", async () => {
		const { cwd } = project(0, { FAKE_LSP_FANOUT: "2" });
		const manager = newManager();
		const opened = await manager.openFile({ cwd }, join(cwd, "sample.txt"));
		expect(opened).toBeDefined();
		const budget = createBudget({ timeoutMs: 30, defaultTimeoutMs: 20_000 });
		const report = await callGraphReport(opened!.client, root, "incoming", 3, budget);
		expect(report).toContain("Callers");
	});
});
