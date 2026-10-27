import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LspManager } from "../src/extras/pi-lsp-mini/src/manager.ts";
import { collectReadDiagnostics } from "../src/extras/pi-lsp-mini/src/read-diagnostics.ts";
import { DEFAULT_READ_DIAGNOSTICS, loadReadDiagnosticsSettings } from "../src/extras/pi-lsp-mini/src/settings.ts";

const FAKE_SERVER = join(
	import.meta.dirname,
	"..",
	"src",
	"extras",
	"pi-lsp-mini",
	"src",
	"__tests__",
	"fixtures",
	"fake-lsp-server.mjs",
);

const temps: string[] = [];
const managers: LspManager[] = [];
const savedEnv = { ...process.env };

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lsp-read-"));
	temps.push(dir);
	return dir;
}

function newManager(): LspManager {
	const manager = new LspManager();
	managers.push(manager);
	return manager;
}

/** A project whose only server is the fake one; `extra` goes into lsp.json next to `servers`. */
function project(
	content: string,
	extra: Record<string, unknown> = {},
): { cwd: string; agentDir: string; file: string } {
	const cwd = tempDir();
	const agentDir = tempDir();
	writeFileSync(join(cwd, ".git"), "");
	const file = join(cwd, "sample.txt");
	writeFileSync(file, content);
	writeFileSync(
		join(agentDir, "lsp.json"),
		JSON.stringify({
			servers: [
				{
					id: "fake",
					command: `${process.execPath} ${FAKE_SERVER}`,
					include: [".txt"],
					rootMarkers: [".git"],
					diagnosticsWaitMs: 100,
				},
			],
			...extra,
		}),
	);
	process.env.NANOPI_CODING_AGENT_DIR = agentDir;
	return { cwd, agentDir, file };
}

afterEach(async () => {
	if (savedEnv.NANOPI_CODING_AGENT_DIR === undefined) delete process.env.NANOPI_CODING_AGENT_DIR;
	else process.env.NANOPI_CODING_AGENT_DIR = savedEnv.NANOPI_CODING_AGENT_DIR;
	for (const manager of managers.splice(0)) await manager.shutdownAll();
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * The fake server reports one error per didChange version <= N for a file whose
 * content says `UP TO N`. "UP TO 1" on a fresh open is one error, which is what
 * a broken file looks like before anything touched it.
 */
describe("diagnostics before read", () => {
	it("reports the errors a file already has", async () => {
		const { cwd, file } = project("UP TO 1\n");
		const report = await collectReadDiagnostics(newManager(), { cwd }, file, DEFAULT_READ_DIAGNOSTICS);
		expect(report.lines.join("\n")).toContain("existing error");
		expect(report.lines.join("\n")).toContain("error from version 1");
	});

	it("stays silent for a clean file", async () => {
		const { cwd, file } = project("nothing wrong here\n");
		const report = await collectReadDiagnostics(newManager(), { cwd }, file, DEFAULT_READ_DIAGNOSTICS);
		expect(report.lines).toEqual([]);
	});

	it("attaches nothing when the hook is disabled", async () => {
		const { cwd, file } = project("UP TO 1\n");
		const report = await collectReadDiagnostics(newManager(), { cwd }, file, {
			...DEFAULT_READ_DIAGNOSTICS,
			enabled: false,
		});
		expect(report.lines).toEqual([]);
	});

	it("skips a file larger than maxFileBytes", async () => {
		const { cwd, file } = project("UP TO 1\n");
		const report = await collectReadDiagnostics(newManager(), { cwd }, file, {
			...DEFAULT_READ_DIAGNOSTICS,
			maxFileBytes: 4,
		});
		expect(report.lines).toEqual([]);
	});
});

describe("read diagnostics settings", () => {
	it("defaults to enabled with an error floor", () => {
		const { agentDir } = project("x\n");
		const settings = loadReadDiagnosticsSettings(join(agentDir, "lsp.json"));
		expect(settings).toEqual(DEFAULT_READ_DIAGNOSTICS);
		expect(settings.enabled).toBe(true);
		expect(settings.maxSeverity).toBe(1);
	});

	it("reads the readDiagnostics key and clamps its numbers", () => {
		const { agentDir } = project("x\n", {
			readDiagnostics: { enabled: false, maxSeverity: 9, timeoutMs: -1, maxDiagnostics: 0, maxFileBytes: 1 },
		});
		const settings = loadReadDiagnosticsSettings(join(agentDir, "lsp.json"));
		expect(settings.enabled).toBe(false);
		expect(settings.maxSeverity).toBe(4);
		expect(settings.timeoutMs).toBe(DEFAULT_READ_DIAGNOSTICS.timeoutMs);
		expect(settings.maxDiagnostics).toBe(DEFAULT_READ_DIAGNOSTICS.maxDiagnostics);
		expect(settings.maxFileBytes).toBe(1);
	});
});
