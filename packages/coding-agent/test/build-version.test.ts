import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILD_VERSION, dateFromVersion, formatBuildVersion, resolveBuildCommit } from "../src/core/build-version.ts";

describe("dateFromVersion", () => {
	it("keeps the date segment of a date version", () => {
		expect(dateFromVersion("20261013.1.0")).toBe("20261013");
	});

	it("passes through versions without a date prefix", () => {
		expect(dateFromVersion("0.99.0")).toBe("0.99.0");
	});
});

describe("formatBuildVersion", () => {
	it("appends the short commit when one is known", () => {
		expect(formatBuildVersion("20261013.1.0", "718adde10f8298")).toBe("v20261013.718adde");
	});

	it("falls back to the bare date without a commit", () => {
		expect(formatBuildVersion("20261013.1.0", undefined)).toBe("v20261013");
	});
});

describe("resolveBuildCommit", () => {
	it("reads HEAD of the given directory", () => {
		const commit = resolveBuildCommit(import.meta.dirname);
		expect(commit).toBeDefined();
		expect(commit).toMatch(/^[0-9a-f]{7,40}$/);
	});

	it("returns undefined outside a git repository", () => {
		expect(resolveBuildCommit("/")).toBeUndefined();
	});
});

describe("BUILD_VERSION", () => {
	it("carries the date from the package version", () => {
		// Read the version instead of hardcoding it: this assertion went stale on the
		// first package bump and failed for every checkout until someone noticed.
		const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
			version: string;
		};
		const expectedDate = packageJson.version.split(".")[0];

		expect(BUILD_VERSION.startsWith(`v${expectedDate}`)).toBe(true);
	});
});
