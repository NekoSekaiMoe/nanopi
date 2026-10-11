import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Route through the repo esbuild preload so Node builds without built-in type stripping can run the worker.
const typeScriptPreload = fileURLToPath(new URL("../../../../ts-import.mjs", import.meta.url));

describe("delta tracker retention across GC jobs", () => {
	it.each([
		"aborted-payload",
		"unadopted-prepared",
		"draft-proxies",
		"settled-lifecycle",
		"obsolete-revisions",
		"retained-settled-prepared",
		"retained-settled-change",
		"retained-settled-proxy",
		"retained-large-settled-proxy",
		"retained-large-placement-proxies",
		"stale-unprepared-change",
		"same-job-fast-cleanup",
		"same-job-folded-ops-cleanup",
		"lifecycle-churn",
	])(
		"validates %s retention semantics",
		(scenario) => {
			const child = spawnSync(
				process.execPath,
				[
					"--import",
					typeScriptPreload,
					"--expose-gc",
					fileURLToPath(new URL("./retention.worker.ts", import.meta.url)),
					scenario,
				],
				{ encoding: "utf8", timeout: 60_000 },
			);
			expect(child.error, child.stderr).toBeUndefined();
			expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
		},
		65_000,
	);
});
