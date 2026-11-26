/**
 * #12164: a models.json `apiKey` written as a `!command` is reported as configured
 * before that command has ever run. That is deliberate, not a bug. `check()` answers
 * "this provider's credential comes from a source the user registered in models.json",
 * which is what the auth selector and `auth check` ask; whether the command can
 * produce a key is a `resolve()` fact, and a failing one surfaces through
 * `getAuth()`, the provider composition error, and the eventual request.
 *
 * The two layers are easy to merge while "cleaning up", so this pins each half of
 * the contract.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@nanopi/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const FAILING_COMMAND = "!sh -c 'echo boom >&2; exit 1'";

describe("models.json !command credentials (#12164)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "nanopi-command-auth-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function runtimeWith(apiKey: string): Promise<ModelRuntime> {
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					probe: {
						baseUrl: "https://probe.example/v1",
						api: "openai-completions",
						apiKey,
						models: [{ id: "probe-1" }],
					},
				},
			}),
		);
		return ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath,
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
	}

	it("reports the provider as configured from its command source, without running it", async () => {
		const runtime = await runtimeWith(FAILING_COMMAND);

		// The status answers "where does this provider's credential come from", so a
		// command that would exit 1 still counts as configured. This is the string the
		// auth selector renders behind "✓".
		expect(runtime.getProviderAuthStatus("probe")).toEqual({
			configured: true,
			source: "models_json_command",
		});
	});

	it("resolves the credential lazily and fails loudly when the command does", async () => {
		const runtime = await runtimeWith(FAILING_COMMAND);

		// A `configured` status is not a promise that a key comes out of the command.
		await expect(runtime.getAuth("probe")).rejects.toThrow(/Failed to resolve API key for provider "probe"/);
	});

	it("passes the command's output through when the command succeeds", async () => {
		const runtime = await runtimeWith("!echo sk-from-command");

		expect(runtime.getProviderAuthStatus("probe")).toEqual({
			configured: true,
			source: "models_json_command",
		});
		await expect(runtime.getAuth("probe")).resolves.toMatchObject({
			auth: { apiKey: "sk-from-command" },
		});
	});
});
