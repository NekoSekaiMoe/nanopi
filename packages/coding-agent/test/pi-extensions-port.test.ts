/** Regression for issue #824: the pi-extensions pick keeps its pure contracts. */
import { describe, expect, test } from "vitest";
import { formatHostname } from "../src/core/hostname.ts";
import { parseGitLog } from "../src/modules/pi-git-tools/src/index.ts";
import { sizeOk, splitForChunking } from "../src/modules/pi-meat/src/index.ts";
import { buildCliArgs, parsePreferredCli } from "../src/modules/pi-subagent-mini/src/cli-adapter.ts";
import { periodStart } from "../src/modules/pi-token-usage/src/index.ts";

describe("pi-extensions port", () => {
	test("hostname drops the trailing dot and DNS domain", () => {
		expect(formatHostname("mini.local.")).toBe("mini");
		expect(formatHostname("host.example.com")).toBe("host");
	});

	test("git log parser keeps multi-line bodies as one record", () => {
		const entries = parseGitLog("abc\u0001date\u0001author\u0001subject\u0001body line 1\nbody line 2\u0000");
		expect(entries).toHaveLength(1);
		expect(entries[0].body).toBe("body line 1\nbody line 2");
	});

	test("meat chunks split at file boundaries and preserve the header", () => {
		const diff = ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1,1 +1,1 @@", "-old", "+new"].join(
			"\n",
		);
		expect(sizeOk(diff)).toBe(true);
		const chunks = splitForChunking(diff);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toContain("diff --git a/x.ts b/x.ts");
	});

	test("preferred CLI aliases resolve and unknown values are ignored", () => {
		expect(parsePreferredCli("claude-code")).toBe("claude");
		expect(parsePreferredCli("antigravity")).toBe("agy");
		expect(parsePreferredCli("bogus")).toBeUndefined();
	});

	test("codex CLI sends the brief as a positional after --", () => {
		const launch = buildCliArgs("codex", { brief: "do the thing", cwd: "/repo" });
		expect(launch.stdin).toBe(false);
		expect(launch.args.slice(-2)).toEqual(["--", "do the thing"]);
		expect(launch.args).toContain("-C");
	});

	test("claude CLI sends the brief over stdin", () => {
		const launch = buildCliArgs("claude", { brief: "do the thing", cwd: "/repo" });
		expect(launch.stdin).toBe(true);
		expect(launch.args).toContain("stream-json");
	});

	test("token-usage periods start at local midnight", () => {
		const now = new Date(2026, 10, 26, 15, 30);
		expect(new Date(periodStart("today", now)).getHours()).toBe(0);
		expect(new Date(periodStart("month", now)).getDate()).toBe(1);
	});
});
