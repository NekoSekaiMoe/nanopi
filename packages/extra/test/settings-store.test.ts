import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	globalExtraSettingsPath,
	globalGuardValue,
	loadExtraSettings,
	projectExtraSettingsPath,
	projectGuardValue,
	resolveGuardSwitch,
	saveExtraSettings,
} from "../src/settings-store.ts";
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

/** A throwaway project directory with its own `.nanopi/extra/settings.json`. */
function withTempProject(run: (projectDir: string) => void): void {
	const projectDir = mkdtempSync(join(tmpdir(), "pi-extra-guard-"));
	try {
		run(projectDir);
	} finally {
		rmSync(projectDir, { recursive: true, force: true });
	}
}

describe("guard switches read one layer at a time", () => {
	test("no key in either file resolves to on, from the default", () => {
		withTempHome(() => {
			withTempProject((projectDir) => {
				expect(resolveGuardSwitch(projectDir, "gitGuard")).toEqual({ value: true, source: "default" });
			});
		});
	});

	test("a global value is reported with its layer", () => {
		withTempHome(() => {
			withTempProject((projectDir) => {
				saveExtraSettings({ gitGuard: false });
				// The project file says nothing, so there is no project value to report.
				expect(resolveGuardSwitch(projectDir, "gitGuard")).toEqual({ value: false, source: "global" });
			});
		});
	});

	test("a project value overrules the global one and says so", () => {
		withTempHome(() => {
			withTempProject((projectDir) => {
				saveExtraSettings({ gitGuard: true });
				mkdirSync(join(projectDir, ".nanopi", "extra"), { recursive: true });
				writeFileSync(projectExtraSettingsPath(projectDir), JSON.stringify({ gitGuard: false }));
				expect(resolveGuardSwitch(projectDir, "gitGuard")).toEqual({
					value: false,
					source: "project",
					projectValue: false,
				});
				// The merged view every other key uses still sees the override; the
				// difference is that this one also carries where it came from.
				expect(loadExtraSettings(projectDir).settings.gitGuard).toBe(false);
			});
		});
	});

	test("each layer is readable on its own, so absent and false stay distinct", () => {
		withTempHome(() => {
			withTempProject((projectDir) => {
				expect(projectGuardValue(projectDir, "shellGuard")).toBeUndefined();
				expect(globalGuardValue("shellGuard")).toBeUndefined();
				saveExtraSettings({ shellGuard: false });
				expect(globalGuardValue("shellGuard")).toBe(false);
				expect(projectGuardValue(projectDir, "shellGuard")).toBeUndefined();
			});
		});
	});

	test("writes land in the named layer only", () => {
		withTempHome(() => {
			withTempProject((projectDir) => {
				saveExtraSettings({ gitGuard: true });
				saveExtraSettings({ gitGuard: false }, "project", projectDir);
				expect(globalGuardValue("gitGuard")).toBe(true);
				expect(projectGuardValue(projectDir, "gitGuard")).toBe(false);
				expect(readFileSync(globalExtraSettingsPath(), "utf8")).toContain('"gitGuard": true');
			});
		});
	});

	test("a null guard value removes the key from that layer", () => {
		withTempHome(() => {
			withTempProject((projectDir) => {
				mkdirSync(join(projectDir, ".nanopi", "extra"), { recursive: true });
				writeFileSync(
					projectExtraSettingsPath(projectDir),
					JSON.stringify({ gitGuard: false, defaultMode: "plan" }),
				);
				saveExtraSettings({ gitGuard: null }, "project", projectDir);
				expect(projectGuardValue(projectDir, "gitGuard")).toBeUndefined();
				// The rest of the file is untouched: the repair removes one key.
				expect(loadExtraSettings(projectDir).settings.defaultMode).toBe("plan");
			});
		});
	});
});
