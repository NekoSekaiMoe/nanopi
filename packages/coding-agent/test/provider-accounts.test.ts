import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
	addAccountModels,
	createAccount,
	deleteAccount,
	deleteAccountModel,
	editAccount,
	editAccountModel,
	listAccounts,
	ProviderAccountError,
} from "../src/modes/webui/provider-accounts.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "nanopi-provider-accounts-"));
	dirs.push(dir);
	return join(dir, "models.json");
}

describe("provider accounts over models.json", () => {
	it("creates, lists, edits, and deletes accounts", async () => {
		const path = freshPath();
		const created = await createAccount(path, {
			provider: "openrouter",
			api_key: "sk-test",
			models: [{ model: "vendor/model-a", display_name: "Model A", context_window: 128_000 }],
		});
		assert.deepStrictEqual(created, { account: "openrouter", models: ["vendor/model-a"] });

		const accounts = await listAccounts(path);
		assert.strictEqual(accounts.length, 1);
		assert.strictEqual(accounts[0]?.id, "openrouter");
		assert.strictEqual(accounts[0]?.type, "openai");
		assert.strictEqual(accounts[0]?.base_url, "https://openrouter.ai/api/v1");
		assert.strictEqual(accounts[0]?.has_api_key, true);
		assert.deepStrictEqual(accounts[0]?.model_ids, ["vendor/model-a"]);

		await editAccount(path, "openrouter", { display_name: "My router", base_url: "https://gw.example/v1" });
		await assert.rejects(
			editAccount(path, "missing", { display_name: "x" }),
			(error: unknown) => error instanceof ProviderAccountError && error.status === 404,
		);
		// An empty key keeps the stored one.
		assert.strictEqual((await listAccounts(path))[0]?.has_api_key, true);
		assert.strictEqual((await listAccounts(path))[0]?.display_name, "My router");

		await deleteAccount(path, "openrouter");
		assert.deepStrictEqual(await listAccounts(path), []);
	});

	it("rejects duplicates, invalid ids, and missing models", async () => {
		const path = freshPath();
		const input = {
			provider: "ollama",
			base_url: "http://localhost:11434/v1",
			models: [{ model: "qwen2.5-coder:7b" }],
		};
		await createAccount(path, input);
		await assert.rejects(
			createAccount(path, input),
			(error: unknown) => error instanceof ProviderAccountError && error.status === 409,
		);
		await assert.rejects(
			createAccount(path, { ...input, id: "bad id!" }),
			(error: unknown) => error instanceof ProviderAccountError && error.status === 400,
		);
		await assert.rejects(
			createAccount(path, { provider: "nope", models: [{ model: "x" }] }),
			(error: unknown) => error instanceof ProviderAccountError && error.status === 400,
		);
		await assert.rejects(
			createAccount(freshPath(), { provider: "anthropic", models: [] }),
			(error: unknown) => error instanceof ProviderAccountError && error.status === 400,
		);
		await assert.rejects(
			createAccount(freshPath(), { provider: "anthropic", models: [{ model: "claude" }] }),
			(error: unknown) => error instanceof ProviderAccountError && error.status === 400,
		);
	});

	it("preserves foreign fields in models.json", async () => {
		const path = freshPath();
		await writeFile(
			path,
			`${JSON.stringify(
				{
					$schema: "https://example/schema.json",
					providers: {
						gw: {
							baseUrl: "https://gw.example/v1",
							apiKey: "k",
							headers: { "x-extra": "1" },
							models: [{ id: "m1" }],
						},
					},
				},
				null,
				"\t",
			)}\n`,
		);
		await addAccountModels(path, "gw", [{ model: "m2" }]);
		const onDisk = JSON.parse(readFileSync(path, "utf8")) as {
			$schema?: string;
			providers: Record<string, { headers?: unknown; models?: Array<{ id: string }> }>;
		};
		assert.strictEqual(onDisk.$schema, "https://example/schema.json");
		assert.deepStrictEqual(onDisk.providers.gw?.headers, { "x-extra": "1" });
		assert.deepStrictEqual(
			onDisk.providers.gw?.models?.map((model) => model.id),
			["m1", "m2"],
		);
	});

	// Regression for #609: every preset wrote the listing protocol (`openai`,
	// `anthropic`) into models.json as the model's `api`, but the runtime
	// registers the implementations under their api ids, so an account added from
	// the webui could be created and listed yet every turn failed with
	// "No API provider registered for api: openai".
	it("writes the registered api id, not the listing protocol", async () => {
		const ids: Array<[string, string]> = [
			["anthropic", "anthropic-messages"],
			["openai", "openai-completions"],
			["openrouter", "openai-completions"],
			["deepseek", "openai-completions"],
			["moonshot", "openai-completions"],
			["zhipu", "openai-completions"],
			["ollama", "openai-completions"],
			["lmstudio", "openai-completions"],
			["openai-compatible", "openai-completions"],
			["anthropic-compatible", "anthropic-messages"],
		];
		for (const [provider, api] of ids) {
			const path = freshPath();
			await createAccount(path, { provider, api_key: "k", models: [{ model: "m1" }] });
			const onDisk = JSON.parse(readFileSync(path, "utf8")) as {
				providers: Record<string, { api?: string }>;
			};
			assert.strictEqual(onDisk.providers[provider]?.api, api, provider);
		}
	});

	it("reports a stored account's api as the listing protocol", async () => {
		const path = freshPath();
		await createAccount(path, { provider: "anthropic-compatible", api_key: "k", models: [{ model: "m1" }] });
		// The page sends this back to /providers/discover-models, which picks the
		// path and header by protocol, so the view keeps the short name.
		assert.strictEqual((await listAccounts(path))[0]?.type, "anthropic");
	});

	it("adds, edits, and deletes models per account", async () => {
		const path = freshPath();
		await createAccount(path, { provider: "ollama", models: [{ model: "a" }] });
		assert.deepStrictEqual(await addAccountModels(path, "ollama", [{ model: "a" }, { model: "b" }]), ["b"]);

		await editAccountModel(path, "ollama", "b", { display_name: "B", max_tokens: 4096 });
		const entry = (await listAccounts(path))[0];
		assert.deepStrictEqual(entry?.model_ids, ["a", "b"]);

		await deleteAccountModel(path, "ollama", "a");
		assert.deepStrictEqual((await listAccounts(path))[0]?.model_ids, ["b"]);
		await assert.rejects(
			deleteAccountModel(path, "ollama", "zz"),
			(error: unknown) => error instanceof ProviderAccountError && error.status === 404,
		);
	});
});
