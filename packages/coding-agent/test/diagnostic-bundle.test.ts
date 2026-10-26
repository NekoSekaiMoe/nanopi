import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AssistantMessage } from "@nanopi/pi-ai/compat";
import { getModel } from "@nanopi/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { getDebugLogPath } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	buildDiagnosticMetadata,
	buildDiagnosticReport,
	diagnosticBundleFiles,
	redactJsonValue,
	redactUrl,
	writeDiagnosticBundle,
} from "../src/core/diagnostic-bundle.ts";
import type { LoadModulesResult } from "../src/core/modules/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "nanopi-diagnostics-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const emptyModules: LoadModulesResult = {
	modules: [],
	errors: [],
	warnings: [],
	runtime: {} as LoadModulesResult["runtime"],
};

async function input(options: { cwd: string; agentDir?: string; sessionJsonl?: string } = { cwd: tempDir() }) {
	const sessionManager = SessionManager.inMemory(options.cwd);
	const modelRuntime = getModelRuntime(await createInMemoryModelRegistry(AuthStorage.inMemory()));
	return {
		sessionManager,
		input: {
			phase: "startup" as const,
			cwd: options.cwd,
			sessionManager,
			model: getModel("anthropic", "claude-sonnet-4-5"),
			modelRuntime,
			thinkingLevel: "medium" as const,
			modules: emptyModules,
			settings: {
				global: SettingsManager.inMemory().getGlobalSettings(),
				project: SettingsManager.inMemory().getProjectSettings(),
			},
			crashes: [],
			...(options.sessionJsonl === undefined ? {} : { sessionJsonl: options.sessionJsonl }),
			...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
		},
	};
}

describe("diagnostic bundle redaction", () => {
	it("removes URL credentials and secret query parameters", () => {
		expect(redactUrl("https://user:pass@proxy.example.com:8080/")).toBe("https://proxy.example.com:8080/");
		expect(redactUrl("git:https://pat@github.com/org/repo")).toBe("git:https://github.com/org/repo");
		expect(redactUrl("https://api.example/v1?api-key=abc&model=x")).toBe(
			"https://api.example/v1?api-key=%3Credacted%3E&model=x",
		);
	});

	it("redacts secret values without hiding ordinary numbers", () => {
		expect(
			redactJsonValue({
				apiKey: "sk-123",
				headers: { Authorization: "Bearer x", "X-Trace": "1" },
				compaction: { reserveTokens: 16_384, keepRecentTokens: 20_000 },
			}),
		).toEqual({
			apiKey: "<redacted>",
			headers: { Authorization: "<redacted>", "X-Trace": "1" },
			compaction: { reserveTokens: 16_384, keepRecentTokens: 20_000 },
		});
	});
});

describe("diagnostic bundle contents", () => {
	it("reports the environment, model, and settings without credentials", async () => {
		const { input: bundleInput } = await input();
		const metadata = buildDiagnosticMetadata(bundleInput);

		expect(metadata.kind).toBe("nanopi.diagnostics");
		expect(metadata.phase).toBe("startup");
		expect(metadata.model?.id).toBe("claude-sonnet-4-5");
		expect(metadata.provider?.id).toBe("anthropic");
		expect(metadata.provider?.authTypes).toContain("api_key");
		expect(metadata.session.transcriptIncluded).toBe(false);
		expect(metadata.environment.nanopiEnvironmentVariables.every((name) => name.startsWith("NANOPI_"))).toBe(true);
	});

	it("keeps failed assistant turns and leaves out successful ones", async () => {
		const { sessionManager, input: bundleInput } = await input();
		sessionManager.appendMessage(userMsg("hello"));
		const failed: AssistantMessage = {
			...assistantMsg(""),
			stopReason: "error",
			errorMessage: "upstream 500",
			diagnostics: [{ type: "provider_error", timestamp: Date.now() }],
		};
		sessionManager.appendMessage(failed);

		const report = buildDiagnosticReport(bundleInput);
		expect(report.assistantMessageCount).toBe(1);
		expect(report.assistant).toHaveLength(1);
		expect(report.assistant[0]?.errorMessage).toBe("upstream 500");
	});

	it("writes loose files plus bundle.zip into the agent dir", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const { input: bundleInput } = await input({ cwd, agentDir, sessionJsonl: '{"type":"session"}\n' });

		const written = await writeDiagnosticBundle(bundleInput);
		expect(written).toBeDefined();
		if (!written) return;

		expect(written.directory.startsWith(join(agentDir, "diagnostics"))).toBe(true);
		expect(existsSync(join(written.directory, "diagnostics.json"))).toBe(true);
		expect(existsSync(join(written.directory, "report.json"))).toBe(true);
		expect(existsSync(join(written.directory, "session.jsonl"))).toBe(true);
		expect(existsSync(join(written.directory, "bundle.zip"))).toBe(true);

		const names = readdirSync(written.directory).sort();
		expect(names).toEqual(["bundle.zip", "diagnostics.json", "report.json", "session.jsonl"]);

		const parsed = JSON.parse(readFileSync(join(written.directory, "diagnostics.json"), "utf8"));
		expect(parsed.session.transcriptIncluded).toBe(true);
	});

	it("labels the archive with the session phase and keeps both files distinct", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const { input: bundleInput } = await input({ cwd, agentDir });

		const startup = await writeDiagnosticBundle(bundleInput);
		const exit = await writeDiagnosticBundle({ ...bundleInput, phase: "exit" });
		expect(startup?.directory).not.toBe(exit?.directory);
		expect(startup?.directory.endsWith("-startup")).toBe(true);
		expect(exit?.directory.endsWith("-exit")).toBe(true);
	});

	it("includes the debug log when one exists", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const { input: bundleInput } = await input({ cwd, agentDir });
		const logPath = getDebugLogPath();
		const logExisted = existsSync(logPath);
		const previous = logExisted ? readFileSync(logPath, "utf8") : undefined;
		try {
			mkdirSync(dirname(logPath), { recursive: true });
			rmSync(logPath, { force: true });
			expect(diagnosticBundleFiles(bundleInput).map((file) => file.name)).toEqual([
				"diagnostics.json",
				"report.json",
			]);

			writeFileSync(logPath, "[now] mem rss 120MiB\n");
			const withLog = diagnosticBundleFiles(bundleInput);
			expect(withLog.map((file) => file.name)).toEqual(["diagnostics.json", "report.json", "debug.log"]);
			expect(withLog[2]?.data).toContain("mem rss 120MiB");
		} finally {
			if (previous === undefined) rmSync(logPath, { force: true });
			else writeFileSync(logPath, previous);
		}
	});
});
