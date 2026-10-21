import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDiskModules, resolveModulePaths, scanDiskModules } from "../src/core/modules/jiti-loader.ts";
import type { SessionModule } from "../src/core/modules/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const TOOL_MODULE = `
import { Type } from "typebox";

export default {
	name: "disk-tool",
	factory: (nanopi) => {
		nanopi.registerTool({
			name: "disk_echo",
			description: "Echo the disk module's argument",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id, params) => ({ content: [{ type: "text", text: params.text }] }),
		});
	},
};
`;

describe("disk modules", () => {
	let projectDir: string;
	let agentDir: string;
	let previousEnv: string | undefined;

	beforeEach(() => {
		const root = join(tmpdir(), `nanopi-disk-modules-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		projectDir = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(join(projectDir, ".nanopi", "extensions"), { recursive: true });
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		previousEnv = process.env.NANOPI_EXTENSIONS;
		delete process.env.NANOPI_EXTENSIONS;
	});

	afterEach(() => {
		if (previousEnv === undefined) delete process.env.NANOPI_EXTENSIONS;
		else process.env.NANOPI_EXTENSIONS = previousEnv;
		rmSync(join(projectDir, ".."), { recursive: true, force: true });
	});

	it("scans the agent directory, and the project directory only when trusted", () => {
		writeFileSync(join(agentDir, "extensions", "global.ts"), TOOL_MODULE);
		writeFileSync(join(projectDir, ".nanopi", "extensions", "local.ts"), TOOL_MODULE);

		const untrusted = scanDiskModules({ cwd: projectDir, agentDir, projectTrusted: false });
		expect(untrusted.files.map((file) => file.split("/").pop())).toEqual(["global.ts"]);

		const trusted = scanDiskModules({ cwd: projectDir, agentDir, projectTrusted: true });
		expect(trusted.files.map((file) => file.split("/").pop())).toEqual(["global.ts", "local.ts"]);
	});

	it("reads an explicit path from $NANOPI_EXTENSIONS", () => {
		const file = join(projectDir, "outside.ts");
		writeFileSync(file, TOOL_MODULE);
		process.env.NANOPI_EXTENSIONS = file;

		const scan = scanDiskModules({ cwd: projectDir, agentDir, projectTrusted: false });
		expect(scan.files).toEqual([file]);
		expect(scan.missing).toEqual([]);
	});

	it("reports an explicit path that holds no module file", () => {
		process.env.NANOPI_EXTENSIONS = join(projectDir, "nope.ts");
		const scan = scanDiskModules({ cwd: projectDir, agentDir, projectTrusted: true });
		expect(scan.files).toEqual([]);
		expect(scan.missing).toEqual([join(projectDir, "nope.ts")]);
	});

	it("names a module after its file, or its directory for an index file", () => {
		writeFileSync(join(projectDir, "one.ts"), TOOL_MODULE);
		mkdirSync(join(projectDir, "two"));
		writeFileSync(join(projectDir, "two", "index.ts"), TOOL_MODULE);
		expect(resolveModulePaths(join(projectDir, "one.ts"), projectDir)).toHaveLength(1);
		expect(resolveModulePaths(join(projectDir, "two"), projectDir)).toEqual([join(projectDir, "two", "index.ts")]);
	});

	it("loads a module file into a SessionModule", async () => {
		const file = join(agentDir, "extensions", "disk-tool.ts");
		writeFileSync(file, TOOL_MODULE);
		const { modules, errors } = await loadDiskModules([file]);
		expect(errors).toEqual([]);
		expect(modules.map((module) => module.name)).toEqual(["disk-tool"]);
		expect(typeof modules[0]?.factory).toBe("function");
	});

	it("keeps the other modules when one fails to load", async () => {
		const good = join(agentDir, "extensions", "good.ts");
		const bad = join(agentDir, "extensions", "bad.ts");
		writeFileSync(good, TOOL_MODULE);
		writeFileSync(bad, "export default 42;\n");
		const { modules, errors } = await loadDiskModules([bad, good]);
		expect(modules.map((module) => module.name)).toEqual(["good"]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.path).toBe(bad);
	});

	it("adds disk modules to the ones the loader was constructed with", async () => {
		writeFileSync(join(agentDir, "extensions", "disk-tool.ts"), TOOL_MODULE);
		const handed: SessionModule = { name: "handed", factory: () => {} };
		const settingsManager = SettingsManager.create(projectDir, agentDir, { projectTrusted: true });
		const loader = new DefaultResourceLoader({ cwd: projectDir, agentDir, settingsManager, modules: [handed] });
		await loader.reload();
		const names = loader.getModules().modules.map((module) => module.name);
		expect(names).toContain("handed");
		expect(names).toContain("disk-tool");
		expect(loader.getModules().errors).toEqual([]);
	});

	it("does not scan the project directory in an untrusted project", async () => {
		writeFileSync(join(projectDir, ".nanopi", "extensions", "local.ts"), TOOL_MODULE);
		const settingsManager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });
		const loader = new DefaultResourceLoader({ cwd: projectDir, agentDir, settingsManager, modules: [] });
		await loader.reload();
		expect(loader.getModules().modules).toEqual([]);
		expect(existsSync(join(projectDir, ".nanopi", "extensions", "local.ts"))).toBe(true);
	});
});
