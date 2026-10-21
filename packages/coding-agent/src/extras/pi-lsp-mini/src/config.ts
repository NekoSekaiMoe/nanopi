import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** One language-server entry. `command` may be a list of alternatives; the first found on PATH wins. */
export interface LspServerConfig {
  id: string;
  command: string | string[];
  args?: string[];
  /** File extensions this server handles, e.g. [".ts", ".tsx"] */
  include?: string[];
  /** Walk up from the file until one of these exists; fallback: cwd */
  rootMarkers?: string[];
  diagnosticsWaitMs?: number;
  settings?: unknown;
  initializationOptions?: unknown;
  enabled?: boolean;
  /** Scan common build subdirectories (build/, cmake-build-*, ...) for compile_commands.json and pass
   *  --compile-commands-dir to the server. For clangd-style servers. */
  compileCommandsProbe?: boolean;
}

export const DEFAULT_SERVERS: LspServerConfig[] = [
  {
    id: "typescript",
    // tsserver itself is NOT an LSP server (its --stdio speaks tsserver's own
    // wire protocol, so an LSP client would time out on initialize). Both
    // candidates below are LSP wrappers around the local tsserver:
    // typescript-language-server (theia) is the common choice; vtsls is the
    // standalone VS Code tsserver language server. First one on PATH wins.
    command: ["typescript-language-server --stdio", "vtsls --stdio"],
    include: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
  },
  {
    id: "python",
    command: ["pyright-langserver --stdio", "basedpyright-langserver --stdio", "pylsp"],
    include: [".py", ".pyi"],
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "pyrightconfig.json"],
  },
  {
    id: "go",
    command: "gopls",
    include: [".go"],
    rootMarkers: ["go.mod", "go.work"],
  },
  {
    id: "rust",
    command: "rust-analyzer",
    include: [".rs"],
    rootMarkers: ["Cargo.toml"],
  },
  {
    id: "cpp",
    command: ["clangd", "/usr/bin/clangd", "/usr/local/bin/clangd"],
    args: ["--background-index"],
    include: [".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".cu", ".cuh"],
    rootMarkers: ["compile_commands.json", "compile_flags.txt", "CMakeLists.txt", "Makefile", ".git"],
    diagnosticsWaitMs: 3000,
    compileCommandsProbe: true,
  },
  {
    id: "ruby",
    command: ["ruby-lsp", "solargraph stdio"],
    include: [".rb", ".rake", ".gemspec"],
    rootMarkers: ["Gemfile", ".ruby-version", ".git"],
  },
  {
    id: "php",
    command: ["intelephense --stdio", "phpactor language-server"],
    include: [".php"],
    rootMarkers: ["composer.json", ".git"],
  },
  {
    id: "java",
    command: "jdtls",
    include: [".java"],
    rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", ".git"],
    diagnosticsWaitMs: 5000,
  },
  {
    id: "kotlin",
    command: "kotlin-language-server",
    include: [".kt", ".kts"],
    rootMarkers: ["build.gradle.kts", "build.gradle", "settings.gradle.kts", ".git"],
    diagnosticsWaitMs: 5000,
  },
  {
    id: "csharp",
    command: ["csharp-ls", "omnisharp --languageserver"],
    include: [".cs"],
    rootMarkers: ["*.sln", "*.csproj", ".git"],
    diagnosticsWaitMs: 5000,
  },
  {
    id: "fsharp",
    command: "fsautocomplete --adaptive-lsp-server-enabled",
    include: [".fs", ".fsx", ".fsi"],
    rootMarkers: ["*.sln", "*.fsproj", ".git"],
    diagnosticsWaitMs: 5000,
  },
  {
    id: "swift",
    command: "sourcekit-lsp",
    include: [".swift"],
    rootMarkers: ["Package.swift", "*.xcodeproj", ".git"],
  },
  {
    id: "zig",
    command: "zls",
    include: [".zig", ".zon"],
    rootMarkers: ["build.zig", "build.zig.zon", ".git"],
  },
  {
    id: "lua",
    command: "lua-language-server",
    include: [".lua"],
    rootMarkers: [".luarc.json", ".luacheckrc", ".git"],
  },
  {
    id: "dart",
    command: "dart language-server --protocol=lsp",
    include: [".dart"],
    rootMarkers: ["pubspec.yaml", ".git"],
    diagnosticsWaitMs: 5000,
  },
  {
    id: "haskell",
    command: ["haskell-language-server-wrapper --lsp", "haskell-language-server --lsp"],
    include: [".hs", ".lhs"],
    rootMarkers: ["*.cabal", "stack.yaml", "cabal.project", ".git"],
    diagnosticsWaitMs: 5000,
  },
  {
    id: "elixir",
    command: "elixir-ls",
    include: [".ex", ".exs"],
    rootMarkers: ["mix.exs", ".git"],
    diagnosticsWaitMs: 5000,
  },
  {
    id: "erlang",
    command: "erlang_ls",
    include: [".erl", ".hrl"],
    rootMarkers: ["rebar.config", "erlang.mk", ".git"],
  },
  {
    id: "scala",
    command: "metals",
    include: [".scala", ".sc"],
    rootMarkers: ["build.sbt", "build.sc", ".git"],
    diagnosticsWaitMs: 8000,
  },
  {
    id: "clojure",
    command: "clojure-lsp",
    include: [".clj", ".cljs", ".cljc", ".edn"],
    rootMarkers: ["deps.edn", "project.clj", "shadow-cljs.edn", ".git"],
  },
  {
    id: "ocaml",
    command: ["ocamllsp", "ocaml-lsp-server"],
    include: [".ml", ".mli"],
    rootMarkers: ["dune-project", "dune", ".git"],
  },
  {
    id: "bash",
    command: "bash-language-server start",
    include: [".sh", ".bash", ".zsh", ".ksh"],
    rootMarkers: [".git"],
  },
  {
    id: "terraform",
    command: "terraform-ls serve",
    include: [".tf", ".tfvars"],
    rootMarkers: [".terraform", "*.tf", ".git"],
  },
  {
    id: "dockerfile",
    command: ["docker-langserver --stdio", "dockerfile-language-server-nodejs --stdio"],
    include: [".dockerfile"],
    rootMarkers: [".git"],
  },
  {
    id: "vue",
    command: ["vue-language-server --stdio", "vls"],
    include: [".vue"],
    rootMarkers: ["package.json", "vite.config.ts", "vite.config.js", ".git"],
  },
  {
    id: "svelte",
    command: "svelteserver --stdio",
    include: [".svelte"],
    rootMarkers: ["package.json", "svelte.config.js", ".git"],
  },
  {
    id: "cmake",
    command: "cmake-language-server",
    include: [".cmake"],
    rootMarkers: ["CMakeLists.txt", ".git"],
  },
  {
    id: "protobuf",
    command: "buf beta lsp --stdio",
    include: [".proto"],
    rootMarkers: ["buf.yaml", "buf.gen.yaml", ".git"],
  },
  {
    id: "sql",
    command: "sqls",
    include: [".sql"],
    rootMarkers: [".git"],
  },
  {
    id: "solidity",
    command: ["nomicfoundation-solidity-language-server --stdio", "solidity-ls --stdio"],
    include: [".sol"],
    rootMarkers: ["hardhat.config.ts", "hardhat.config.js", "foundry.toml", "truffle-config.js", ".git"],
  },
  {
    id: "systemverilog",
    command: "svlangserver",
    include: [".v", ".sv", ".svh", ".vh"],
    rootMarkers: [".git"],
  },
];

function userConfigPath(): string {
  const envDir = process.env.NANOPI_CODING_AGENT_DIR;
  if (envDir) return path.join(envDir, "lsp.json");
  return path.join(os.homedir(), ".nanopi", "agent", "lsp.json");
}

let cachedServers: LspServerConfig[] | undefined;

/** Built-in defaults, overridden per-id by ~/.nanopi/agent/lsp.json ({ "servers": [{ "id": ..., ... }] }). */
export function loadServers(): LspServerConfig[] {
  if (cachedServers) return cachedServers;

  let userEntries: LspServerConfig[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(userConfigPath(), "utf8"));
    if (Array.isArray(raw?.servers)) userEntries = raw.servers;
  } catch {
    // no config file / invalid json -> defaults only
  }

  const byId = new Map<string, LspServerConfig>();
  for (const server of DEFAULT_SERVERS) byId.set(server.id, { ...server });
  for (const entry of userEntries) {
    if (!entry?.id) continue;
    const base = byId.get(entry.id) ?? ({ id: entry.id } as LspServerConfig);
    byId.set(entry.id, { ...base, ...entry });
  }

  cachedServers = [...byId.values()].filter((s) => s.enabled !== false && s.command);
  return cachedServers;
}
