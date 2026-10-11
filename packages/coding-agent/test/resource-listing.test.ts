import { homedir } from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import {
	formatContextPath,
	formatDisplayPath,
	getCompactExtensionLabels,
	getShortPath,
	type ResourceItem,
} from "../src/core/resource-listing.ts";
import type { SourceInfo } from "../src/core/source-info.ts";

function createSourceInfo(
	filePath: string,
	options: {
		source: string;
		scope: "user" | "project" | "temporary";
		origin: "package" | "top-level";
		baseDir?: string;
	},
): SourceInfo {
	return {
		path: filePath,
		source: options.source,
		scope: options.scope,
		origin: options.origin,
		baseDir: options.baseDir,
	};
}

function createExtensionFixtures(): ResourceItem[] {
	return [
		{
			path: "/tmp/project/.nanopi/extensions/answer.ts",
			sourceInfo: createSourceInfo("/tmp/project/.nanopi/extensions/answer.ts", {
				source: "local",
				scope: "project",
				origin: "top-level",
				baseDir: "/tmp/project/.nanopi/extensions",
			}),
		},
		{
			path: "/tmp/project/.nanopi/extensions/local-index/index.ts",
			sourceInfo: createSourceInfo("/tmp/project/.nanopi/extensions/local-index/index.ts", {
				source: "local",
				scope: "project",
				origin: "top-level",
				baseDir: "/tmp/project/.nanopi/extensions",
			}),
		},
		{
			path: "/tmp/agent/extensions/user-index/index.ts",
			sourceInfo: createSourceInfo("/tmp/agent/extensions/user-index/index.ts", {
				source: "local",
				scope: "user",
				origin: "top-level",
				baseDir: "/tmp/agent/extensions",
			}),
		},
		{
			path: "/tmp/project/.nanopi/npm/node_modules/nanopi-markdown-preview/extensions/index.ts",
			sourceInfo: createSourceInfo(
				"/tmp/project/.nanopi/npm/node_modules/nanopi-markdown-preview/extensions/index.ts",
				{
					source: "npm:nanopi-markdown-preview",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.nanopi/npm/node_modules/nanopi-markdown-preview",
				},
			),
		},
		{
			path: "/tmp/project/.nanopi/npm/node_modules/@scope/nanopi-scoped/extensions/index.ts",
			sourceInfo: createSourceInfo(
				"/tmp/project/.nanopi/npm/node_modules/@scope/nanopi-scoped/extensions/index.ts",
				{
					source: "npm:@scope/nanopi-scoped",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.nanopi/npm/node_modules/@scope/nanopi-scoped",
				},
			),
		},
		{
			path: "/tmp/project/.nanopi/git/github.com/HazAT/nanopi-interactive-subagents/extensions/index.ts",
			sourceInfo: createSourceInfo(
				"/tmp/project/.nanopi/git/github.com/HazAT/nanopi-interactive-subagents/extensions/index.ts",
				{
					source: "git:github.com/HazAT/nanopi-interactive-subagents",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.nanopi/git/github.com/HazAT/nanopi-interactive-subagents",
				},
			),
		},
		{
			path: "/tmp/project/.nanopi/git/github.com/HazAT/nanopi-interactive-subagents/extensions/subagents/index.ts",
			sourceInfo: createSourceInfo(
				"/tmp/project/.nanopi/git/github.com/HazAT/nanopi-interactive-subagents/extensions/subagents/index.ts",
				{
					source: "git:github.com/HazAT/nanopi-interactive-subagents",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.nanopi/git/github.com/HazAT/nanopi-interactive-subagents",
				},
			),
		},
		{
			path: "/tmp/temp/cli-extension.ts",
			sourceInfo: createSourceInfo("/tmp/temp/cli-extension.ts", {
				source: "cli",
				scope: "temporary",
				origin: "top-level",
				baseDir: "/tmp/temp",
			}),
		},
	];
}

describe("formatDisplayPath", () => {
	test("abbreviates the home directory to ~", () => {
		expect(formatDisplayPath(path.join(homedir(), "project/AGENTS.md"), homedir())).toBe("~/project/AGENTS.md");
		expect(formatDisplayPath("/tmp/project/AGENTS.md", homedir())).toBe("/tmp/project/AGENTS.md");
	});
});

describe("formatContextPath", () => {
	test("shows context paths relative to cwd while preserving full external paths", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "nanopi-mono");
		const labels = [
			formatContextPath(path.join(home, ".nanopi", "agent", "AGENTS.md"), cwd, home),
			formatContextPath(path.join(cwd, "AGENTS.md"), cwd, home),
		];
		expect(labels[0]).toBe("~/.nanopi/agent/AGENTS.md");
		expect(labels[1]).toBe("AGENTS.md");
	});
});

describe("getShortPath", () => {
	test("labels npm sibling extensions relative to the declaring package", () => {
		const baseDir = "/tmp/project/.nanopi/npm/node_modules/primary-package";
		expect(
			getShortPath(
				"/tmp/project/.nanopi/npm/node_modules/primary-package/index.ts",
				createSourceInfo("/tmp/project/.nanopi/npm/node_modules/primary-package/index.ts", {
					source: "npm:primary-package",
					scope: "project",
					origin: "package",
					baseDir,
				}),
				homedir(),
			),
		).toBe("index.ts");
		expect(
			getShortPath(
				"/tmp/project/.nanopi/npm/node_modules/sibling-package/index.ts",
				createSourceInfo("/tmp/project/.nanopi/npm/node_modules/primary-package/index.ts", {
					source: "npm:primary-package",
					scope: "project",
					origin: "package",
					baseDir,
				}),
				homedir(),
			),
		).toBe("../sibling-package/index.ts");
	});
});

describe("getCompactExtensionLabels", () => {
	test("captures mixed extension layouts", () => {
		expect(getCompactExtensionLabels(createExtensionFixtures(), homedir())).toEqual([
			"answer.ts",
			"local-index",
			"user-index",
			"nanopi-markdown-preview",
			"@scope/nanopi-scoped",
			"HazAT/nanopi-interactive-subagents",
			"HazAT/nanopi-interactive-subagents:subagents",
			"cli-extension.ts",
		]);
	});

	test("abbreviates extensions without source metadata", () => {
		expect(
			getCompactExtensionLabels(
				[{ path: "/tmp/extensions/answer.ts" }, { path: "/tmp/extensions/btw.ts" }],
				homedir(),
			),
		).toEqual(["answer.ts", "btw.ts"]);
	});

	test("adds more parent folders until local extension labels are unique", () => {
		const extensions: ResourceItem[] = ["alpha", "beta", "gamma"].map((dir) => ({
			path: `/tmp/${dir}/one/index.ts`,
			sourceInfo: createSourceInfo(`/tmp/${dir}/one/index.ts`, {
				source: "cli",
				scope: "temporary",
				origin: "top-level",
				baseDir: `/tmp/${dir}`,
			}),
		}));

		expect(getCompactExtensionLabels(extensions, homedir())).toEqual(["alpha/one", "beta/one", "gamma/one"]);
	});

	test("strips index.ts and index.js from local labels, showing the parent dir", () => {
		expect(
			getCompactExtensionLabels(
				[
					{
						path: "/tmp/extensions/webfetch.ts",
						sourceInfo: createSourceInfo("/tmp/extensions/webfetch.ts", {
							source: "local",
							scope: "project",
							origin: "top-level",
							baseDir: "/tmp/extensions",
						}),
					},
					{
						path: "/tmp/extensions/plan-mode/index.js",
						sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.js", {
							source: "local",
							scope: "project",
							origin: "top-level",
							baseDir: "/tmp/extensions",
						}),
					},
				],
				homedir(),
			),
		).toEqual(["webfetch.ts", "plan-mode"]);
	});

	test("labels npm packages without the extensions/ prefix", () => {
		expect(
			getCompactExtensionLabels(
				[
					{
						path: "/tmp/project/.nanopi/npm/node_modules/nanopi-markdown-preview/extensions/index.ts",
						sourceInfo: createSourceInfo(
							"/tmp/project/.nanopi/npm/node_modules/nanopi-markdown-preview/extensions/index.ts",
							{
								source: "npm:nanopi-markdown-preview",
								scope: "project",
								origin: "package",
								baseDir: "/tmp/project/.nanopi/npm/node_modules/nanopi-markdown-preview",
							},
						),
					},
				],
				homedir(),
			),
		).toEqual(["nanopi-markdown-preview"]);
	});

	test("labels Windows npm sibling extensions relative to the declaring package", () => {
		const primaryPath = "C:\\Users\\me\\.nanopi\\agent\\npm\\node_modules\\primary-package\\index.ts";
		const siblingPath = "C:\\Users\\me\\.nanopi\\agent\\npm\\node_modules\\sibling-package\\index.ts";
		const baseDir = "C:\\Users\\me\\.nanopi\\agent\\npm\\node_modules\\primary-package";
		expect(
			getCompactExtensionLabels(
				[
					{
						path: primaryPath,
						sourceInfo: createSourceInfo(primaryPath, {
							source: "npm:primary-package",
							scope: "user",
							origin: "package",
							baseDir,
						}),
					},
					{
						path: siblingPath,
						sourceInfo: createSourceInfo(primaryPath, {
							source: "npm:primary-package",
							scope: "user",
							origin: "package",
							baseDir,
						}),
					},
				],
				homedir(),
			),
		).toEqual(["primary-package", "primary-package:../sibling-package"]);
	});
});
