import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { findExecutable } from "../src/executables.ts";
import {
	buildSandboxCommand,
	createSandboxedBashOperations,
	DEFAULT_SANDBOX_CONFIG,
	describeSandboxCall,
	detectSandbox,
	normalizeSandboxConfig,
	resolveSandboxHome,
	shellQuote,
} from "../src/sandbox.ts";
import { normalizeExtraSettings } from "../src/types.ts";

const bwrapAvailable: { available: true; kind: "bwrap"; launcher: string } = {
	available: true,
	kind: "bwrap",
	launcher: "/usr/bin/bwrap",
};

describe("sandbox config", () => {
	test("drops non-boolean and non-string entries", () => {
		expect(normalizeSandboxConfig({ writable: ["/tmp", "", 7], allowNetwork: "yes", engine: "jail" })).toEqual({
			engine: undefined,
			home: undefined,
			writable: ["/tmp"],
			allowNetwork: false,
		});
	});

	test("settings carry an optional sandbox block", () => {
		expect(normalizeExtraSettings({}).sandbox).toBeUndefined();
		expect(normalizeExtraSettings({ sandbox: { allowNetwork: true } }).sandbox).toEqual({
			engine: undefined,
			home: undefined,
			writable: [],
			allowNetwork: true,
		});
	});

	test("home defaults under the agent dir", () => {
		expect(resolveSandboxHome(DEFAULT_SANDBOX_CONFIG, { NANOPI_CODING_AGENT_DIR: "/agent" })).toBe("/agent/sandbox");
	});
});

describe("detectSandbox", () => {
	test("reports the platform mismatch before looking for a launcher", () => {
		const availability = detectSandbox({ ...DEFAULT_SANDBOX_CONFIG, engine: "bwrap" }, {});
		if (process.platform === "linux") {
			expect(availability.available ? availability.kind : availability.reason).toBe(
				availability.available
					? "bwrap"
					: "bubblewrap not found; install it (for example `apt install bubblewrap`)",
			);
		} else {
			expect(availability).toEqual({ available: false, kind: "bwrap", reason: "bubblewrap is Linux-only" });
		}
	});

	test("finds a launcher through PATH", () => {
		const dir = mkdtempSync(join(tmpdir(), "nanopi-sandbox-"));
		try {
			expect(findExecutable("bwrap", { PATH: dir })).toBeUndefined();
			expect(detectSandbox({ ...DEFAULT_SANDBOX_CONFIG, engine: "sandbox-exec" }, { PATH: dir })).toMatchObject({
				available: false,
				kind: "sandbox-exec",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("sandbox command", () => {
	test("bwrap mounts the tree read-only and binds the writable roots", () => {
		const cwd = mkdtempSync(join(tmpdir(), "nanopi-sandbox-cwd-"));
		const home = mkdtempSync(join(tmpdir(), "nanopi-sandbox-home-"));
		try {
			const { argv } = buildSandboxCommand(DEFAULT_SANDBOX_CONFIG, { cwd, home }, bwrapAvailable);
			expect(argv.slice(0, 1)).toEqual(["/usr/bin/bwrap"]);
			expect(argv).toContain("--unshare-net");
			expect(argv.join(" ")).toContain(`--bind ${cwd} ${cwd}`);
			expect(argv.join(" ")).toContain(`--setenv HOME ${home}`);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("--network drops the network namespace", () => {
		const cwd = mkdtempSync(join(tmpdir(), "nanopi-sandbox-cwd-"));
		try {
			const { argv } = buildSandboxCommand(
				{ ...DEFAULT_SANDBOX_CONFIG, allowNetwork: true },
				{ cwd, home: cwd },
				bwrapAvailable,
			);
			expect(argv).not.toContain("--unshare-net");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("unavailable launcher throws instead of running bare", () => {
		expect(() =>
			buildSandboxCommand(
				DEFAULT_SANDBOX_CONFIG,
				{ cwd: "/", home: "/" },
				{
					available: false,
					reason: "bubblewrap not found",
				},
			),
		).toThrow("bubblewrap not found");
	});
});

describe("shellQuote", () => {
	test("quotes spaces and embedded single quotes", () => {
		expect(shellQuote("ls -la")).toBe("'ls -la'");
		expect(shellQuote("echo 'hi'")).toBe(`'echo '\\''hi'\\'''`);
	});
});

describe("createSandboxedBashOperations", () => {
	test("wraps the command and keeps the caller's exec", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nanopi-sandbox-cwd-"));
		const seen: string[] = [];
		try {
			const backend = createSandboxedBashOperations({
				config: DEFAULT_SANDBOX_CONFIG,
				availability: bwrapAvailable,
				home: cwd,
				exec: async (command) => {
					seen.push(command);
					return { exitCode: 0 };
				},
			});
			const result = await backend.exec("echo hi", cwd, { onData: () => {} });
			expect(result).toEqual({ exitCode: 0 });
			expect(seen[0]).toContain(`/bin/sh -c 'echo hi'`);
			expect(seen[0]?.startsWith("'/usr/bin/bwrap'")).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("reports a missing launcher as a failed command, not a fallback", async () => {
		const chunks: string[] = [];
		const backend = createSandboxedBashOperations({
			config: DEFAULT_SANDBOX_CONFIG,
			availability: { available: false, reason: "bubblewrap not found" },
			home: "/tmp",
			exec: async () => {
				throw new Error("must not run");
			},
		});
		const result = await backend.exec("echo hi", "/tmp", { onData: (data) => chunks.push(data.toString()) });
		expect(result.exitCode).toBe(1);
		expect(chunks.join("")).toContain("sandbox unavailable");
	});
});

describe("describeSandboxCall", () => {
	test("mentions the cut network only for shell tools", () => {
		expect(describeSandboxCall(DEFAULT_SANDBOX_CONFIG, "bash")).toBe("network blocked by sandbox");
		expect(describeSandboxCall(DEFAULT_SANDBOX_CONFIG, "read")).toBeUndefined();
		expect(describeSandboxCall({ ...DEFAULT_SANDBOX_CONFIG, allowNetwork: true }, "bash")).toBeUndefined();
	});
});
