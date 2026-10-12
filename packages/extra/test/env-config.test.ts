import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveEnvProvider, resolveInitMd } from "../src/env-config.ts";

const ENV_KEYS = ["NANOPI_INIT_MD", "NANOPI_API_URL", "NANOPI_API_TOKEN", "NANOPI_API_MODEL"] as const;

afterEach(() => {
	for (const key of ENV_KEYS) delete process.env[key];
});

describe("resolveInitMd", () => {
	test("unset env yields undefined", () => {
		expect(resolveInitMd(process.cwd())).toBeUndefined();
	});

	test("reads the referenced file and replaces the prefix content", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-extra-env-"));
		try {
			writeFileSync(join(dir, "init.md"), "  You are a terse reviewer.  ");
			process.env.NANOPI_INIT_MD = join(dir, "init.md");
			expect(resolveInitMd(dir)).toBe("You are a terse reviewer.");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("falls back to .nanopi/agent/init.md for flag-style values", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-extra-env-"));
		try {
			mkdirSync(join(dir, ".nanopi", "agent"), { recursive: true });
			writeFileSync(join(dir, ".nanopi", "agent", "init.md"), "fallback content");
			process.env.NANOPI_INIT_MD = "1";
			expect(resolveInitMd(dir)).toBe("fallback content");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("missing files yield undefined", () => {
		process.env.NANOPI_INIT_MD = "/nonexistent/init.md";
		expect(resolveInitMd(process.cwd())).toBeUndefined();
	});
});

describe("resolveEnvProvider", () => {
	test("requires NANOPI_API_URL", () => {
		expect(resolveEnvProvider()).toBeUndefined();
	});

	test("registers an appended OpenAI-compatible provider with defaults", () => {
		process.env.NANOPI_API_URL = "https://api.example.com/v1";
		process.env.NANOPI_API_TOKEN = "secret";
		process.env.NANOPI_API_MODEL = "my-model";
		const provider = resolveEnvProvider();
		expect(provider).toMatchObject({
			providerId: "nanopi-env",
			baseUrl: "https://api.example.com/v1",
			apiKey: "secret",
			api: "openai-completions",
		});
		expect(provider?.models[0]).toMatchObject({ id: "my-model", reasoning: false, input: ["text"] });
	});

	test("model defaults when unset; token optional", () => {
		process.env.NANOPI_API_URL = "https://api.example.com/v1";
		const provider = resolveEnvProvider();
		expect(provider?.models[0].id).toBe("default");
		expect(provider?.apiKey).toBeUndefined();
	});
});
