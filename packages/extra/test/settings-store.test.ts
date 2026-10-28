import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { globalExtraSettingsPath, loadExtraSettings, saveExtraSettings } from "../src/settings-store.ts";
import { normalizeExtraSettings } from "../src/types.ts";

function withTempHome(run: () => void): void {
	const temp = mkdtempSync(join(tmpdir(), "pi-extra-test-"));
	process.env.NANOPI_CODING_AGENT_DIR = join(temp, ".nanopi", "agent");
	try {
		run();
	} finally {
		delete process.env.NANOPI_CODING_AGENT_DIR;
		rmSync(temp, { recursive: true, force: true });
	}
}

describe("extra settings store", () => {
	test("missing files yield defaults", () => {
		withTempHome(() => {
			const { settings, sources } = loadExtraSettings(process.cwd());
			expect(settings.defaultMode).toBe("standard");
			expect(settings.subsystems).toEqual({});
			expect(sources).toEqual([]);
		});
	});

	test("save and reload round-trips through the global file", () => {
		withTempHome(() => {
			saveExtraSettings({ defaultMode: "plan" });
			saveExtraSettings({ subsystems: { mcp: false } });
			const { settings, sources } = loadExtraSettings(process.cwd());
			expect(settings.defaultMode).toBe("plan");
			expect(settings.subsystems).toEqual({ mcp: false });
			expect(sources).toContain(globalExtraSettingsPath());
		});
	});

	test("the shell guard switch persists and a project file can override it", () => {
		withTempHome(() => {
			const projectDir = join(tmpdir(), `pi-extra-shell-${Math.random().toString(36).slice(2)}`);
			mkdirSync(join(projectDir, ".nanopi", "extra"), { recursive: true });
			try {
				expect(loadExtraSettings(projectDir).settings.shellGuard).toBeUndefined();
				saveExtraSettings({ shellGuard: false });
				expect(loadExtraSettings(projectDir).settings.shellGuard).toBe(false);
				writeFileSync(join(projectDir, ".nanopi", "extra", "settings.json"), JSON.stringify({ shellGuard: true }));
				expect(loadExtraSettings(projectDir).settings.shellGuard).toBe(true);
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});
	});

	test("null subsystem entries remove the override", () => {
		withTempHome(() => {
			saveExtraSettings({ subsystems: { mcp: false } });
			saveExtraSettings({ subsystems: { mcp: null } });
			expect(loadExtraSettings(process.cwd()).settings.subsystems).toEqual({});
		});
	});

	test("project file overrides global values per key", () => {
		withTempHome(() => {
			const projectDir = join(tmpdir(), `pi-extra-proj-${Math.random().toString(36).slice(2)}`);
			mkdirSync(join(projectDir, ".nanopi", "extra"), { recursive: true });
			try {
				saveExtraSettings({ defaultMode: "plan", subsystems: { mcp: false, todo: false } });
				writeFileSync(
					join(projectDir, ".nanopi", "extra", "settings.json"),
					JSON.stringify({ defaultMode: "minimal", subsystems: { mcp: true } }),
				);
				const { settings } = loadExtraSettings(projectDir);
				expect(settings.defaultMode).toBe("minimal");
				expect(settings.subsystems).toEqual({ mcp: true, todo: false });
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});
	});

	test("invalid values fall back to defaults", () => {
		expect(normalizeExtraSettings({ defaultMode: "yolo", subsystems: { mcp: "yes", todo: false } })).toEqual({
			defaultMode: "standard",
			subsystems: { todo: false },
		});
		expect(normalizeExtraSettings(null)).toEqual({ defaultMode: "standard", subsystems: {} });
	});
});
