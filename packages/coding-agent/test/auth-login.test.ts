import {
	createProvider,
	fauxProvider,
	InMemoryModelsStore,
	type OAuthCredential,
	type ProviderStreams,
} from "@nanopi/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { AuthCommandError, parseAuthCommand } from "../src/cli/auth-command.ts";
import { runAuthLogin } from "../src/cli/auth-login.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const PROVIDER = "faux-subscription";

function credential(): OAuthCredential {
	return { type: "oauth", refresh: "refresh-token", access: "access-token", expires: Date.now() + 3_600_000 };
}

/** A subscription provider that asks one question, like the real browser flows do. */
function subscriptionProvider(options: { prompts: string[] }) {
	const faux = fauxProvider({ provider: PROVIDER, models: [{ id: "alpha", reasoning: false }] });
	const api: ProviderStreams = {
		stream: () => {
			throw new Error("the faux provider never streams here");
		},
		streamSimple: () => {
			throw new Error("the faux provider never streams here");
		},
	};
	return createProvider({
		id: PROVIDER,
		name: "Faux Subscription",
		models: faux.models,
		api,
		auth: {
			oauth: {
				name: "Faux Subscription",
				loginLabel: "Sign in with Faux",
				notice: ["Signing in does not configure the daily check-in."],
				async login(interaction) {
					interaction.notify({ type: "auth_url", url: "https://example.invalid/authorize" });
					options.prompts.push(
						await interaction.prompt({
							type: "select",
							message: "How do you want to sign in?",
							options: [
								{ id: "browser", label: "Browser" },
								{ id: "code", label: "Paste a code" },
							],
						}),
					);
					return credential();
				},
				async refresh(current) {
					return current;
				},
				async toAuth() {
					return { apiKey: "oauth-token" };
				},
			},
			apiKey: { name: "Faux key", resolve: async () => ({ auth: {} }) },
		},
	});
}

async function createRuntime(credentials: AuthStorage): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	runtime.registerNativeProvider(subscriptionProvider({ prompts: [] }));
	return runtime;
}

describe("auth login command", () => {
	test("parses login with --provider and --no-browser", () => {
		const command = parseAuthCommand(["auth", "login", "--provider", "openai"]);
		expect(command).toMatchObject({ kind: "login", noBrowser: false });
		expect(parseAuthCommand(["auth", "login", "--provider", "openai", "--no-browser"])).toMatchObject({
			kind: "login",
			noBrowser: true,
		});
	});

	test("rejects --no-browser on the other auth commands", () => {
		expect(() => parseAuthCommand(["auth", "check", "--provider", "openai", "--no-browser"])).toThrow(
			AuthCommandError,
		);
	});

	test("signs in and stores the credential for later sessions", async () => {
		const credentials = AuthStorage.inMemory();
		const runtime = await createRuntime(credentials);

		const answers = ["code"];
		const result = await runAuthLogin(parseArgs(["--provider", PROVIDER]), runtime, {
			signal: new AbortController().signal,
			openBrowser: false,
			prompt: async () => answers.shift() ?? "",
		});

		expect(result).toEqual({ provider: PROVIDER, name: "Faux Subscription" });
		await expect(credentials.read(PROVIDER)).resolves.toMatchObject({ type: "oauth", access: "access-token" });
	});

	test("prints the provider notice before the flow asks anything", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory());
		const written: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			written.push(args.map(String).join(" "));
		});
		try {
			await runAuthLogin(parseArgs(["--provider", PROVIDER]), runtime, {
				signal: new AbortController().signal,
				openBrowser: false,
				prompt: async () => "code",
			});
		} finally {
			log.mockRestore();
		}

		expect(written[0]).toContain("Signing in does not configure the daily check-in.");
	});

	test("requires a provider", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory());

		await expect(
			runAuthLogin(parseArgs(["--model", `${PROVIDER}/alpha`]), runtime, {
				signal: new AbortController().signal,
				openBrowser: false,
			}),
		).rejects.toThrow("Login requires --provider <provider>");
	});

	test("rejects a provider without an OAuth flow", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory());
		const apiKeyOnly = createProvider({
			id: "faux-key-only",
			name: "Faux Key Only",
			models: fauxProvider({ provider: "faux-key-only", models: [{ id: "alpha", reasoning: false }] }).models,
			api: {
				stream: () => {
					throw new Error("the faux provider never streams here");
				},
				streamSimple: () => {
					throw new Error("the faux provider never streams here");
				},
			},
			auth: { apiKey: { name: "Faux key", resolve: async () => ({ auth: {} }) } },
		});
		runtime.registerNativeProvider(apiKeyOnly);

		await expect(
			runAuthLogin(parseArgs(["--provider", "faux-key-only"]), runtime, {
				signal: new AbortController().signal,
				openBrowser: false,
				prompt: async () => "",
			}),
		).rejects.toThrow("has no OAuth login");
	});

	test("rejects an unknown provider", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory());

		await expect(
			runAuthLogin(parseArgs(["--provider", "nope"]), runtime, {
				signal: new AbortController().signal,
				openBrowser: false,
			}),
		).rejects.toThrow('Unknown provider "nope"');
	});
});
