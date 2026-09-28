import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type AuthContext, type AuthPrompt, type Model, normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { LlamaClient } from "../src/extensions/llama/client.ts";
import { loadManagedLlamaSettings, type ManagedLlama, ManagedLlamaClient } from "../src/extensions/llama/managed.ts";
import { createLlamaProvider, LLAMA_MODE_ENV, MANAGED_LLAMA_SERVER_URL } from "../src/extensions/llama/provider.ts";
import {
	huggingFaceCacheDir,
	LlamaSupervisor,
	type LlamaSupervisorConfig,
	type ManagedLlamaServerInfo,
} from "../src/extensions/llama/supervisor.ts";

// Stands in for llama-server: binds the port pi passes (0), prints the address, and requires the API key.
const FAKE_SERVER = `
import { createServer } from "node:http";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
if (args.includes("--fail")) {
	console.error("fake failure");
	process.exit(3);
}
if (value("--port") !== "0" || value("--host") !== "127.0.0.1") {
	console.error("unexpected arguments: " + args.join(" "));
	process.exit(2);
}
const key = process.env.LLAMA_API_KEY;
const server = createServer((request, response) => {
	if (request.headers.authorization !== "Bearer " + key) {
		response.writeHead(401).end();
		return;
	}
	if (request.url === "/health") {
		response.end(JSON.stringify({ status: "ok" }));
		return;
	}
	if (request.url === "/models") {
		response.end(JSON.stringify({ data: [{ id: "local", status: { value: "unloaded" }, source: "models_dir" }] }));
		return;
	}
	response.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => {
	console.error("[ 4242] srv  main: listening on http://127.0.0.1:1");
	console.error("srv  main: listening on http://127.0.0.1:" + server.address().port);
});
process.on("SIGTERM", () => process.exit(0));
`;

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Fixture {
	stateDir: string;
	supervisors: LlamaSupervisor[];
	launch: (config: LlamaSupervisorConfig) => void;
	config: (args?: string[], command?: string) => () => Promise<LlamaSupervisorConfig>;
}

async function fixture(): Promise<Fixture> {
	// Unix socket paths are limited to about 100 bytes, so keep the state directory short.
	const stateDir = await mkdtemp("/tmp/pi-llama-");
	const script = join(stateDir, "fake-llama-server.mjs");
	await writeFile(script, FAKE_SERVER);
	const supervisors: LlamaSupervisor[] = [];
	const clients: ManagedLlamaClient[] = [];
	cleanups.push(async () => {
		for (const client of clients) client.release();
		await Promise.all(supervisors.map((supervisor) => supervisor.shutdown("test cleanup")));
		await rm(stateDir, { recursive: true, force: true });
	});
	return {
		stateDir,
		supervisors,
		// Run the supervisor in-process instead of spawning `pi --internal-llama-supervisor`.
		launch: (config) => {
			void LlamaSupervisor.start(config).then((supervisor) => {
				if (supervisor) supervisors.push(supervisor);
			});
		},
		config:
			(args = [script], command = process.execPath) =>
			async () => ({
				command,
				args,
				modelsDir: join(stateDir, "models"),
				stateDir,
				idleShutdownMs: 50,
				startupGraceMs: 500,
			}),
	};
}

async function isReachable(url: string): Promise<boolean> {
	try {
		await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) });
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(process.platform === "win32")("managed llama.cpp supervisor", () => {
	it("shares one server across clients and stops it after the last one disconnects", async () => {
		const { stateDir, supervisors, launch, config } = await fixture();
		const first = new ManagedLlamaClient(stateDir, launch);
		const second = new ManagedLlamaClient(stateDir, launch);

		const [a, b] = await Promise.all([first.acquire(config()), second.acquire(config())]);
		expect(a).toEqual(b);
		expect(supervisors).toHaveLength(1);
		// The router's forwarded "[port]" log line must not be mistaken for its own address.
		expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
		expect(a.url).not.toBe("http://127.0.0.1:1");
		expect(a.modelsDir).toBe(join(stateDir, "models"));
		expect(existsSync(a.modelsDir)).toBe(true);
		expect(existsSync(join(stateDir, "server.json"))).toBe(true);
		expect((await new LlamaClient(a.url, a.apiKey).list()).map((model) => model.id)).toEqual(["local"]);
		expect(await new ManagedLlamaClient(stateDir, launch).probe()).toEqual(a);

		first.release();
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(await isReachable(a.url)).toBe(true);

		second.release();
		await supervisors[0]!.done;
		expect(await isReachable(a.url)).toBe(false);
		expect(existsSync(join(stateDir, "server.json"))).toBe(false);
		expect(await new ManagedLlamaClient(stateDir, launch).probe()).toBeUndefined();
	});

	it("restarts the server on request", async () => {
		const { stateDir, supervisors, launch, config } = await fixture();
		const client = new ManagedLlamaClient(stateDir, launch);
		const before = await client.acquire(config());

		await client.stop();
		await supervisors[0]!.done;
		expect(await isReachable(before.url)).toBe(false);

		const after = await client.acquire(config());
		expect(supervisors).toHaveLength(2);
		expect(after.apiKey).not.toBe(before.apiKey);
		expect(await isReachable(after.url)).toBe(true);
	});

	it("reports servers that fail to start", async () => {
		const { stateDir, launch, config } = await fixture();
		await expect(
			new ManagedLlamaClient(stateDir, launch).acquire(config([], join(stateDir, "missing-llama-server"))),
		).rejects.toThrow("Could not start");
		const script = join(stateDir, "fake-llama-server.mjs");
		await expect(new ManagedLlamaClient(stateDir, launch).acquire(config([script, "--fail"]))).rejects.toThrow(
			"llama-server exited during startup (code 3: fake failure)",
		);
	});

	it("stops a server orphaned by a killed supervisor", async () => {
		const { stateDir, launch, config } = await fixture();
		const script = join(stateDir, "fake-llama-server.mjs");
		const orphan = spawn(
			process.execPath,
			[script, "--models-dir", join(stateDir, "models"), "--host", "127.0.0.1", "--port", "0"],
			{ stdio: "ignore" },
		);
		const exited = new Promise((resolve) => orphan.once("exit", resolve));
		cleanups.push(async () => {
			orphan.kill("SIGKILL");
		});
		await writeFile(join(stateDir, "server.json"), JSON.stringify({ pid: orphan.pid }));

		await new ManagedLlamaClient(stateDir, launch).acquire(config());
		await exited;
		// SIGTERM may arrive before the fake server installs its handler.
		expect(orphan.exitCode === 0 || orphan.signalCode === "SIGTERM").toBe(true);
	});
});

describe("managed llama.cpp settings", () => {
	it("applies defaults and rejects arguments pi controls", async () => {
		const agentDir = await mkdtemp("/tmp/pi-llama-settings-");
		cleanups.push(() => rm(agentDir, { recursive: true, force: true }));

		expect(loadManagedLlamaSettings(agentDir)).toEqual({
			command: "llama-server",
			args: [],
			modelsDir: join(agentDir, "llama", "models"),
			idleShutdownSeconds: 30,
		});

		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({ llamaCpp: { args: ["-c", "32768", "--port=8080"] } }),
		);
		expect(() => loadManagedLlamaSettings(agentDir)).toThrow("llamaCpp.args must not contain --port=8080");
	});

	it("resolves the download cache like llama.cpp", () => {
		expect(huggingFaceCacheDir({ LLAMA_CACHE: "/a", HF_HOME: "/b" })).toBe("/a");
		expect(huggingFaceCacheDir({ HF_HOME: "/b", XDG_CACHE_HOME: "/c" })).toBe(join("/b", "hub"));
		expect(huggingFaceCacheDir({ XDG_CACHE_HOME: "/c" })).toBe(join("/c", "huggingface", "hub"));
	});
});

describe("managed llama.cpp provider", () => {
	async function inferenceServer(onRequest: (url: string, authorization: string | undefined) => void) {
		const server: Server = createServer((request, response) => {
			onRequest(request.url ?? "", request.headers.authorization);
			if (request.url === "/models") {
				response.end(
					JSON.stringify({
						data: [
							{ id: "cached", status: { value: "unloaded" }, source: "cache" },
							{ id: "failed", status: { value: "unloaded", failed: true }, source: "models_dir" },
						],
					}),
				);
				return;
			}
			if (request.url === "/props") {
				// Older routers omit models_autoload; managed mode assumes llama.cpp's default (enabled).
				response.end(JSON.stringify({ role: "router" }));
				return;
			}
			response.writeHead(400, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: { message: "fake failure" } }));
		});
		server.listen(0, "127.0.0.1");
		await new Promise((resolve) => server.once("listening", resolve));
		cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
		return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	}

	function fakeManaged(server: ManagedLlamaServerInfo | undefined, calls: string[]): ManagedLlama {
		return {
			acquire: async () => {
				calls.push("acquire");
				if (!server) throw new Error("not running");
				return server;
			},
			probe: async () => {
				calls.push("probe");
				return server;
			},
			restart: async () => {
				throw new Error("unused");
			},
			verify: async () => {
				calls.push("verify");
				return "1 (test)";
			},
		};
	}

	it("stores managed mode on login without starting the server", async () => {
		const calls: string[] = [];
		const { provider } = createLlamaProvider(fakeManaged(undefined, calls));
		const auth = provider.auth.apiKey!;
		const signal = new AbortController().signal;
		const prompts: AuthPrompt[] = [];
		const credential = await auth.login!({
			signal,
			prompt: async (prompt) => {
				prompts.push(prompt);
				return "managed";
			},
			notify: () => {},
		});
		expect(prompts.map((prompt) => prompt.type)).toEqual(["select"]);
		expect(credential).toEqual({ type: "api_key", env: { [LLAMA_MODE_ENV]: "managed" } });

		const ctx: AuthContext = { env: async () => undefined, fileExists: async () => false };
		expect(await auth.check?.({ ctx, credential, signal })).toEqual({
			type: "api_key",
			source: "managed llama-server",
		});
		expect(await auth.resolve({ ctx, credential, signal })).toEqual({
			auth: { apiKey: "managed", baseUrl: `${MANAGED_LLAMA_SERVER_URL}/v1` },
			env: { [LLAMA_MODE_ENV]: "managed" },
			source: "managed llama-server",
		});
		expect(calls).toEqual(["verify"]);
	});

	it("refreshes only from a running server and sends requests to its current port", async () => {
		const requests: { url: string; authorization: string | undefined }[] = [];
		const url = await inferenceServer((requestUrl, authorization) =>
			requests.push({ url: requestUrl, authorization }),
		);
		const server: ManagedLlamaServerInfo = {
			url,
			apiKey: "secret",
			modelsDir: "/models",
			cacheDir: "/cache",
			logPath: "/log",
		};

		const idleCalls: string[] = [];
		const idle = createLlamaProvider(fakeManaged(undefined, idleCalls));
		await idle.provider.refreshModels?.({
			credential: { type: "api_key", key: "managed", env: { [LLAMA_MODE_ENV]: "managed" } },
			stored: undefined,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
			allowNetwork: true,
			signal: new AbortController().signal,
		});
		expect(idleCalls).toEqual(["probe"]);
		expect(idle.provider.getModels()).toEqual([]);

		const calls: string[] = [];
		const { provider } = createLlamaProvider(fakeManaged(server, calls));
		await provider.refreshModels?.({
			credential: { type: "api_key", key: "managed", env: { [LLAMA_MODE_ENV]: "managed" } },
			stored: undefined,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
			allowNetwork: true,
			signal: new AbortController().signal,
		});
		// Managed routers expose every autoloadable model, not only presets.
		const models = provider.getModels();
		expect(models.map((model) => model.id)).toEqual(["cached"]);
		expect(models[0]!.baseUrl).toBe(`${MANAGED_LLAMA_SERVER_URL}/v1`);

		const result = await provider
			.stream(models[0] as Model<"openai-completions">, normalizeContext({ messages: [] }), { apiKey: "managed" })
			.result();
		expect(result.stopReason).toBe("error");
		expect(calls).toEqual(["probe", "acquire"]);
		expect(requests.at(-1)).toEqual({ url: "/v1/chat/completions", authorization: "Bearer secret" });
	});
});
