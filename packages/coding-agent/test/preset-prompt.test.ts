import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("preset prompt", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `nanopi-preset-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function writeProjectFile(relativePath: string, content: string): void {
		const path = join(tempDir, ".nanopi", relativePath);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, content);
	}

	async function load(preset?: string, options: { projectTrusted?: boolean; appendSystemPrompt?: string[] } = {}) {
		const settingsManager = SettingsManager.create(tempDir, agentDir, {
			projectTrusted: options.projectTrusted ?? true,
		});
		const loader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
			preset,
			appendSystemPrompt: options.appendSystemPrompt,
		});
		await loader.reload();
		return loader;
	}

	it("appends the trusted project PRESET_PROMPTS.md by default", async () => {
		writeProjectFile("PRESET_PROMPTS.md", "project preset");
		const loader = await load();

		expect(loader.getAppendSystemPrompt()).toEqual(["project preset"]);
		expect(loader.getAppendSystemPromptSources().map((source) => source.path)).toEqual([
			join(tempDir, ".nanopi", "PRESET_PROMPTS.md"),
		]);
	});

	it("ignores the project PRESET_PROMPTS.md while the project is untrusted", async () => {
		writeProjectFile("PRESET_PROMPTS.md", "project preset");
		const loader = await load(undefined, { projectTrusted: false });

		expect(loader.getAppendSystemPrompt()).toEqual([]);
	});

	it("lets --preset override the project default", async () => {
		writeProjectFile("PRESET_PROMPTS.md", "project preset");
		const explicit = join(tempDir, "explicit.md");
		writeFileSync(explicit, "explicit preset");

		const loader = await load(explicit);

		expect(loader.getAppendSystemPrompt()).toEqual(["explicit preset"]);
	});

	it("resolves a bare --preset name under .nanopi/presets", async () => {
		writeProjectFile("presets/review.md", "review preset");
		const loader = await load("review");

		expect(loader.getAppendSystemPrompt()).toEqual(["review preset"]);
	});

	it("keeps appends after the preset so they can correct it", async () => {
		writeProjectFile("PRESET_PROMPTS.md", "project preset");
		const loader = await load(undefined, { appendSystemPrompt: ["later correction"] });

		expect(loader.getAppendSystemPrompt()).toEqual(["project preset", "later correction"]);
	});

	it("does not append a missing preset name as literal text", async () => {
		const loader = await load("missing");

		expect(loader.getAppendSystemPrompt()).toEqual([]);
	});
});
