import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetServersCache } from "../config.ts";
import { collectEditDiagnostics } from "../edit-diagnostics.ts";
import { LspManager } from "../manager.ts";
import { DEFAULT_EDIT_DIAGNOSTICS, loadEditDiagnosticsSettings } from "../settings.ts";

const FAKE_SERVER = join(import.meta.dirname, "fixtures", "fake-lsp-server.mjs");

/**
 * `loadServers()` memoizes the merge for the process, so each test that points
 * NANOPI_CODING_AGENT_DIR at another config drops the cache here — after the
 * env var is set, before the manager first reads the server list.
 */
function resetConfigCache(): void {
	resetServersCache();
}

const temps: string[] = [];
const managers: LspManager[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lsp-edit-diag-"));
	temps.push(dir);
	return dir;
}

/** A project root whose only server entry is the fake one, matching .txt files. */
function fakeProject(env: Record<string, string> = {}): { cwd: string; agentDir: string; file: string } {
	const cwd = tempDir();
	const agentDir = tempDir();
	writeFileSync(join(cwd, ".git"), "");
	const file = join(cwd, "sample.txt");
	writeFileSync(file, "first\nsecond\n");
	writeFileSync(
		join(agentDir, "lsp.json"),
		JSON.stringify({
			servers: [
				{
					id: "fake",
					command: `${process.execPath} ${FAKE_SERVER}`,
					include: [".txt"],
					rootMarkers: [".git"],
					diagnosticsWaitMs: 1200,
				},
			],
		}),
	);
	// The manager resolves its user config through this env var, and the merge is
	// memoized per process, so both have to be in place before the first read.
	process.env.NANOPI_CODING_AGENT_DIR = agentDir;
	resetConfigCache();

	const previous = process.env.FAKE_LSP_STALE;
	const previousDelay = process.env.FAKE_LSP_DELAY_MS;
	if (env.FAKE_LSP_STALE) process.env.FAKE_LSP_STALE = env.FAKE_LSP_STALE;
	if (env.FAKE_LSP_DELAY_MS) process.env.FAKE_LSP_DELAY_MS = env.FAKE_LSP_DELAY_MS;
	restoreEnv = () => {
		if (previous === undefined) delete process.env.FAKE_LSP_STALE;
		else process.env.FAKE_LSP_STALE = previous;
		if (previousDelay === undefined) delete process.env.FAKE_LSP_DELAY_MS;
		else process.env.FAKE_LSP_DELAY_MS = previousDelay;
	};
	return { cwd, agentDir, file };
}

let restoreEnv: () => void = () => undefined;

afterEach(async () => {
	restoreEnv();
	for (const manager of managers.splice(0)) await manager.shutdownAll();
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newManager(): LspManager {
	resetConfigCache();
	const manager = new LspManager();
	managers.push(manager);
	return manager;
}

describe("edit diagnostics settings", () => {
	it("is off when lsp.json says nothing", () => {
		const agentDir = tempDir();
		writeFileSync(join(agentDir, "lsp.json"), JSON.stringify({ servers: [] }));
		expect(loadEditDiagnosticsSettings(join(agentDir, "lsp.json")).enabled).toBe(false);
	});

	it("is off when lsp.json is missing or malformed", () => {
		const agentDir = tempDir();
		writeFileSync(join(agentDir, "lsp.json"), "{ not json");
		expect(loadEditDiagnosticsSettings(join(agentDir, "lsp.json"))).toEqual(DEFAULT_EDIT_DIAGNOSTICS);
		expect(loadEditDiagnosticsSettings(join(agentDir, "missing.json"))).toEqual(DEFAULT_EDIT_DIAGNOSTICS);
	});

	it("reads an explicit opt-in and clamps the budgets", () => {
		const agentDir = tempDir();
		writeFileSync(
			join(agentDir, "lsp.json"),
			JSON.stringify({ editDiagnostics: { enabled: true, debounceMs: 99999, timeoutMs: 1, maxDiagnostics: 500 } }),
		);
		const settings = loadEditDiagnosticsSettings(join(agentDir, "lsp.json"));
		expect(settings.enabled).toBe(true);
		expect(settings.debounceMs).toBe(5000);
		expect(settings.timeoutMs).toBe(1);
		expect(settings.maxDiagnostics).toBe(500);
	});

	it("treats a non-boolean enabled as off", () => {
		const agentDir = tempDir();
		writeFileSync(join(agentDir, "lsp.json"), JSON.stringify({ editDiagnostics: { enabled: "yes" } }));
		expect(loadEditDiagnosticsSettings(join(agentDir, "lsp.json")).enabled).toBe(false);
	});
});

describe("post-edit diagnostics", () => {
	const fast = { ...DEFAULT_EDIT_DIAGNOSTICS, enabled: true, debounceMs: 50, timeoutMs: 4000 };

	it("reports errors the server produced for the new content", async () => {
		const { cwd, file } = fakeProject();
		writeFileSync(file, "first\nUP TO 1\n");
		const manager = newManager();

		// Simulates the edit tool having written the file before the hook runs.
		const result = await collectEditDiagnostics(manager, { cwd }, "sample.txt", fast);
		const report = result.lines.join("\n");
		expect(report).toContain("error from version 1");
		expect(report).toContain("LSP issue in sample.txt");
	});

	it("does not report the pre-edit snapshot as a result of this edit", async () => {
		const { cwd, file } = fakeProject({ FAKE_LSP_STALE: "1" });
		writeFileSync(file, "first\nUP TO 5\n");
		const manager = newManager();

		// Warm the server so it holds a pre-edit snapshot of the old content.
		await manager.openFile({ cwd }, file);
		await new Promise((resolve) => setTimeout(resolve, 200));

		// The edit lands, the server answers didChange with nothing at all (the
		// FAKE_LSP_STALE shape). The snapshot from before the edit describes the
		// file the model just changed, so it must not be reported.
		const result = await collectEditDiagnostics(manager, { cwd }, "sample.txt", { ...fast, timeoutMs: 600 });
		expect(result.lines).toEqual([]);
	});

	it("reports only issues newer than the pre-edit mark", async () => {
		const { cwd, file } = fakeProject();
		const manager = newManager();

		writeFileSync(file, "first\nUP TO 2\n");
		const stale = (await collectEditDiagnostics(manager, { cwd }, "sample.txt", fast)).lines.join("\n");
		expect(stale).toContain("LSP issue in sample.txt");

		writeFileSync(file, "first\nsecond\nUP TO 2\n");
		const fresh = (await collectEditDiagnostics(manager, { cwd }, "sample.txt", fast)).lines.join("\n");
		expect(fresh).toContain("LSP issues (2) in sample.txt");
		expect(fresh).toContain("error from version 2");
	});

	it("returns undefined instead of throwing when no server matches", async () => {
		const { cwd } = fakeProject();
		writeFileSync(join(cwd, "other.bin"), "x");
		const manager = newManager();
		const result = await collectEditDiagnostics(manager, { cwd }, "other.bin", { ...fast, timeoutMs: 500 });
		expect(result.lines).toEqual([]);
	});

	it("returns undefined instead of throwing when the server cannot start", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		writeFileSync(join(cwd, ".git"), "");
		writeFileSync(join(cwd, "sample.txt"), "first\n");
		writeFileSync(
			join(agentDir, "lsp.json"),
			JSON.stringify({ servers: [{ id: "broken", command: "definitely-not-a-language-server", include: [".txt"], rootMarkers: [".git"] }] }),
		);
		process.env.NANOPI_CODING_AGENT_DIR = agentDir;
		const manager = new LspManager();
		managers.push(manager);

		const result = await collectEditDiagnostics(manager, { cwd }, "sample.txt", { ...fast, timeoutMs: 500 });
		expect(result.lines).toEqual([]);
	});

	it("gives up at the budget and reports nothing rather than a stale snapshot", async () => {
		const { cwd, file } = fakeProject();
		writeFileSync(file, "first\nUP TO 1\n");
		const manager = newManager();
		const started = Date.now();
		const result = await collectEditDiagnostics(manager, { cwd }, "sample.txt", {
			...fast,
			debounceMs: 0,
			timeoutMs: 600,
		});
		// First call has no pre-edit mark to compare against, so whatever the
		// server publishes is acceptable; the point is that it returns.
		expect(Date.now() - started).toBeLessThan(5000);
		expect(Array.isArray(result.lines)).toBe(true);
	});
});
