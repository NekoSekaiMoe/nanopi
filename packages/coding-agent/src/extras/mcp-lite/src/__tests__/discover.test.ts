import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverServers, expandEnv, normalizeServer, serversFromToml } from "../discover.ts";
import { loadMcpConfig } from "../config.ts";

const temps: string[] = [];

function tempHome(): { home: string; cwd: string } {
	const root = mkdtempSync(join(tmpdir(), "mcp-discover-"));
	temps.push(root);
	const home = join(root, "home");
	const cwd = join(root, "project");
	mkdirSync(home, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	return { home, cwd };
}

function write(file: string, content: string): void {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, content);
}

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("normalizeServer", () => {
	const env = { TOKEN: "secret" };

	it("reads the shared command/args shape", () => {
		expect(normalizeServer({ command: "npx", args: ["-y", "server"], env: { KEY: "v" } }, env)).toEqual({
			transport: "stdio",
			command: "npx",
			args: ["-y", "server"],
			env: { KEY: "v" },
		});
	});

	it("reads OpenCode's argv command and its disabled flag", () => {
		expect(normalizeServer({ type: "local", command: ["npx", "server"] }, env)).toEqual({
			transport: "stdio",
			command: "npx",
			args: ["server"],
		});
		expect(normalizeServer({ enabled: false, command: "npx" }, env)).toBeUndefined();
		expect(normalizeServer({ disabled: true, command: "npx" }, env)).toBeUndefined();
	});

	it("treats any url entry as remote and expands env references", () => {
		expect(normalizeServer({ url: "https://x/mcp", headers: { authorization: "Bearer ${TOKEN}" } }, env)).toEqual({
			transport: "http",
			url: "https://x/mcp",
			headers: { authorization: "Bearer secret" },
		});
		expect(normalizeServer({ type: "sse", url: "https://x/sse" }, env)).toMatchObject({ transport: "sse" });
	});

	it("rejects an entry with neither command nor url", () => {
		expect(normalizeServer({ enabled: true }, env)).toBeUndefined();
	});
});

describe("expandEnv", () => {
	it("keeps unknown variables and honours defaults", () => {
		expect(expandEnv("${KNOWN}/${UNKNOWN}/${MISSING:-fallback}", { KNOWN: "a" })).toBe("a/${UNKNOWN}/fallback");
	});
});

describe("serversFromToml", () => {
	it("flattens [mcp_servers.x] tables and folds nested ones back", () => {
		const servers = serversFromToml(
			[
				"[mcp_servers.docs]",
				'command = "npx"',
				'args = ["-y", "@mcp/docs"]',
				"startup_timeout_sec = 20",
				"",
				"[mcp_servers.docs.env]",
				'API_KEY = "k"',
				"",
				"[mcp_servers.remote]",
				'url = "https://example.com/mcp"',
			].join("\n"),
			{},
		);
		expect(servers.get("docs")).toMatchObject({ command: "npx", args: ["-y", "@mcp/docs"], startup_timeout_sec: "20" });
		expect(normalizeServer(servers.get("remote"), {})).toMatchObject({ transport: "http" });
	});
});

describe("discoverServers", () => {
	it("imports the clients' own config files", () => {
		const { home, cwd } = tempHome();
		write(
			join(home, ".cursor", "mcp.json"),
			JSON.stringify({ mcpServers: { cursor: { command: "npx", args: ["cursor-server"] } } }),
		);
		write(
			join(home, ".codex", "config.toml"),
			'[mcp_servers.codex]\ncommand = "codex-server"\n',
		);
		const found = discoverServers({ cwd, home, enabled: true });
		expect(found.servers.map((server) => server.name).sort()).toEqual(["codex", "cursor"]);
		expect(found.servers.find((server) => server.name === "cursor")?.source).toContain(".cursor");
	});

	it("skips project files unless global scope is requested away", () => {
		const { home, cwd } = tempHome();
		write(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { local: { command: "local-server" } } }));
		expect(discoverServers({ cwd, home, enabled: true }).servers.map((s) => s.name)).toEqual(["local"]);
		expect(discoverServers({ cwd, home, enabled: true, globalOnly: true }).servers).toEqual([]);
	});

	it("lets later files win and honours exclude", () => {
		const { home, cwd } = tempHome();
		write(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "from-cursor" } } }));
		write(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "from-project" }, other: { command: "x" } } }));
		const found = discoverServers({ cwd, home, enabled: true });
		expect(found.servers.find((server) => server.name === "shared")?.config).toMatchObject({ command: "from-project" });
		const excluded = discoverServers({ cwd, home, enabled: true, exclude: [join(cwd, ".mcp.json")] });
		expect(excluded.servers.find((server) => server.name === "shared")?.config).toMatchObject({ command: "from-cursor" });
	});

	it("reads VS Code's servers key and strips JSONC comments", () => {
		const { home, cwd } = tempHome();
		write(
			join(home, ".config", "Code", "User", "mcp.json"),
			'{\n  // comment\n  "servers": { "vs": { "type": "stdio", "command": "vs-server" } }\n}\n',
		);
		const previous = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = join(home, ".config");
		try {
			const found = discoverServers({ cwd, home, enabled: true });
			expect(found.servers.map((server) => server.name)).toEqual(["vs"]);
		} finally {
			if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = previous;
		}
	});

	it("reports a malformed file instead of throwing", () => {
		const { home, cwd } = tempHome();
		write(join(home, ".cursor", "mcp.json"), "{ not json");
		const found = discoverServers({ cwd, home, enabled: true });
		expect(found.servers).toEqual([]);
		expect(found.problems[0]).toContain(".cursor");
	});
});

describe("loadMcpConfig", () => {
	it("keeps the user's own entry above a discovered one", () => {
		const { home, cwd } = tempHome();
		write(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "from-cursor" }, extra: { command: "cursor-only" } } }));
		write(join(home, ".nanopi", "agent", "mcp.json"), JSON.stringify({ mcpServers: { shared: { transport: "stdio", command: "mine" } } }));
		const previous = process.env.NANOPI_CODING_AGENT_DIR;
		process.env.NANOPI_CODING_AGENT_DIR = join(home, ".nanopi", "agent");
		try {
			const config = loadMcpConfig(cwd, { home });
			expect(config.servers.get("shared")).toMatchObject({ command: "mine" });
			expect(config.origins.get("shared")).toContain("agent");
			expect(config.servers.get("extra")).toMatchObject({ command: "cursor-only" });
			expect(config.discovery.mode).toBe("auto");
		} finally {
			if (previous === undefined) delete process.env.NANOPI_CODING_AGENT_DIR;
			else process.env.NANOPI_CODING_AGENT_DIR = previous;
		}
	});

	it("stops importing when discovery is switched off", () => {
		const { home, cwd } = tempHome();
		write(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { extra: { command: "cursor-only" } } }));
		write(join(home, ".nanopi", "agent", "mcp.json"), JSON.stringify({ discovery: { mode: "off" }, mcpServers: {} }));
		const previous = process.env.NANOPI_CODING_AGENT_DIR;
		process.env.NANOPI_CODING_AGENT_DIR = join(home, ".nanopi", "agent");
		try {
			const config = loadMcpConfig(cwd, { home });
			expect(config.servers.size).toBe(0);
			expect(config.discoveryFiles).toEqual([]);
		} finally {
			if (previous === undefined) delete process.env.NANOPI_CODING_AGENT_DIR;
			else process.env.NANOPI_CODING_AGENT_DIR = previous;
		}
	});

	it("defaults project scope off via the settings block", () => {
		const { home, cwd } = tempHome();
		write(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { local: { command: "local" } } }));
		write(join(home, ".nanopi", "agent", "mcp.json"), JSON.stringify({ discovery: { globalOnly: true } }));
		const previous = process.env.NANOPI_CODING_AGENT_DIR;
		process.env.NANOPI_CODING_AGENT_DIR = join(home, ".nanopi", "agent");
		try {
			expect(loadMcpConfig(cwd, { home }).servers.size).toBe(0);
		} finally {
			if (previous === undefined) delete process.env.NANOPI_CODING_AGENT_DIR;
			else process.env.NANOPI_CODING_AGENT_DIR = previous;
		}
	});
});
