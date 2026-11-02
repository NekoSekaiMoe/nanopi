import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ResolveProjectTrustedOptions, resolveProjectTrusted } from "../src/core/project-trust.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";

describe("resolveProjectTrusted", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let trustStore: ProjectTrustStore;

	beforeEach(() => {
		tempDir = join(tmpdir(), `project-trust-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		trustStore = new ProjectTrustStore(agentDir);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function options(): ResolveProjectTrustedOptions {
		return {
			cwd,
			trustStore,
			defaultProjectTrust: "ask",
			projectTrustContext: { hasUI: false } as ResolveProjectTrustedOptions["projectTrustContext"],
		};
	}

	it("returns the saved rejection for a folder with only AGENTS.md", async () => {
		writeFileSync(join(cwd, "AGENTS.md"), "# rules\n");
		trustStore.set(cwd, false);

		await expect(resolveProjectTrusted(options())).resolves.toBe(false);
	});

	it("returns the saved trust decision when project resources exist", async () => {
		mkdirSync(join(cwd, ".nanopi"), { recursive: true });
		writeFileSync(join(cwd, ".nanopi", "settings.json"), "{}");
		trustStore.set(cwd, false);

		await expect(resolveProjectTrusted(options())).resolves.toBe(false);
	});

	it("trusts projects without trust-requiring resources and leaves the store untouched", async () => {
		writeFileSync(join(cwd, "AGENTS.md"), "# rules\n");

		await expect(resolveProjectTrusted(options())).resolves.toBe(true);
		expect(trustStore.get(cwd)).toBeNull();
	});

	it("keeps an existing auto-trust decision after resources appear", async () => {
		trustStore.set(cwd, true);
		mkdirSync(join(cwd, ".nanopi"), { recursive: true });
		writeFileSync(join(cwd, ".nanopi", "settings.json"), "{}");

		await expect(resolveProjectTrusted(options())).resolves.toBe(true);
	});

	it("prefers the trust override over the saved decision", async () => {
		trustStore.set(cwd, false);

		await expect(resolveProjectTrusted({ ...options(), trustOverride: true })).resolves.toBe(true);
	});
});
