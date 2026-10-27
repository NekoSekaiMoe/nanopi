<p align="center">
  <a href="https://github.com/NekoSekaiMoe/nanopi/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/NekoSekaiMoe/nanopi?style=flat-square" /></a>
</p>

> New issues and PRs from new contributors are closed automatically. Maintainers review closed submissions daily. See [CONTRIBUTING.md](https://github.com/NekoSekaiMoe/nanopi/blob/main/CONTRIBUTING.md).

# nanopi

nanopi is a minimal, extensible agent harness that you can make your own.

Adapt nanopi to your workflows, not the other way around. Extend it with [modules](docs/sdk.md#modules) - programmatic modules compiled into the build - and customize it with [skills](docs/skills.md) and [prompt templates](docs/prompt-templates.md).

nanopi ships with powerful defaults but skips features like sub-agents and plan mode. Ask nanopi to build what you want, or install a package that does it your way.

Use nanopi [interactively](docs/usage.md), automate it in [print or JSON mode](docs/cli.md), control it over [RPC](docs/rpc.md), or build apps with the [nanopi TypeScript SDK](docs/sdk.md). See [OpenClaw](https://github.com/OpenClaw/OpenClaw) for a real-world integration.

## Getting started

Install the command-line interface with npm. The package lives in the GitHub
Packages registry, which GitHub only serves to authenticated clients, so name the
registry and a token that carries `read:packages` first:

```bash
# ~/.npmrc
@nekosekaimoe:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
npm install -g --ignore-scripts @nekosekaimoe/nanopi
```

`GITHUB_TOKEN` is any token in the environment with `read:packages`; the scope
line only redirects `@nekosekaimoe` packages, every other npm package keeps
installing from npmjs.

nanopi requires Node.js 24 or newer. The macOS, Linux, and Windows installers can install it if needed, and the `install.js` one-liner needs no registry token at all:

```bash
curl -fsSL https://raw.githubusercontent.com/NekoSekaiMoe/nanopi/main/install.js | node
```

nanopi does not require dependency lifecycle scripts for a normal npm installation.

On macOS and Linux, Nix users can install the latest release with `nix profile add github:NekoSekaiMoe/nanopi/stable`. See the [quickstart](docs/quickstart.md#1-install-nanopi) for updating and pinning releases.

Start nanopi in the directory where you want it to work:

```bash
cd /path/to/project
nanopi
```

For a built-in AI provider, run `/login` inside nanopi to connect a subscription or API key. Then give nanopi a task.

See the [documentation](docs/index.md) for full setup and usage instructions.

## Export a session

`/export [path]` writes the current session; the path extension picks the format:

- `.md` - Markdown, rendered in Node (tool calls and tool output included)
- `.html` - the styled document, and the default when the path names no extension
- `.jsonl` - the session file itself

Need a PDF? Export HTML, open the file in a browser, and print it. The print stylesheet expands everything the page keeps behind a click (tool output, thinking, compaction), so the PDF is the whole transcript rather than the collapsed preview. There is no built-in PDF writer: a PDF engine plus fonts would cost every build more than the export is worth.

A `minimal` build carries neither format and drops `/export`; `base` carries Markdown and HTML.

## Share your OSS coding agent sessions

If you use nanopi for open source work, please share your coding agent sessions.

Public OSS session data helps improve models, prompts, tools, and evaluations using real development workflows.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf) using a Hugging Face account and the Hugging Face CLI.

- [Demo video](https://x.com/badlogicgames/status/2041151967695634619) on how to publish nanopi sessions
- Published nanopi development sessions: [`badlogicgames/pi-mono` on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono).

## Development

Clone the repository, install its dependencies, and run nanopi from source:

```bash
git clone https://github.com/NekoSekaiMoe/nanopi
cd nanopi
npm install --ignore-scripts
node ./nanopi-test.mjs
```

`nanopi-test.mjs` can be called from any directory and preserves the caller's working directory.

Before submitting changes, run:

```bash
npm run check
node ./test.mjs
```

Read [CONTRIBUTING.md](https://github.com/NekoSekaiMoe/nanopi/blob/main/CONTRIBUTING.md) before opening an issue or pull request. It defines the contribution gate, issue quality bar, and required checks. Read [AGENTS.md](https://github.com/NekoSekaiMoe/nanopi/blob/main/AGENTS.md) for repository-specific implementation, testing, dependency, and release rules.

## License

MIT
