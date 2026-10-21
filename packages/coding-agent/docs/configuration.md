# Configuration

nanopi supports user-level and project configuration. User-level configuration lives in the agent directory, which defaults to `~/.nanopi/agent`. Project configuration lives in `.nanopi` under the working directory and loads after [project trust](security.md#understand-project-trust) is granted. The only exception is `sessionDir`, which nanopi reads before resolving trust so it can locate sessions.

In interactive mode, use `/settings` to change common preferences. For other options, ask nanopi to update the configuration or edit the relevant files directly. Restart nanopi after manually changing settings, keybindings, instructions, or resources.

## Agent directory

The agent directory is shown as `<agent-dir>` below. Set its location with the `NANOPI_CODING_AGENT_DIR` environment variable or the SDK's [`agentDir`](sdk.md) option.

| Path | Responsibility |
|---|---|
| `<agent-dir>/settings.json` | User-level [settings](settings.md), including preferences, defaults, resource paths, and nanopi package declarations. |
| `<agent-dir>/keybindings.json` | Custom terminal UI and application [keybindings](keybindings.md). |
| `<agent-dir>/models.json` | [Compatible endpoints, models, and model overrides](models.md#configure-a-compatible-endpoint). |
| `<agent-dir>/auth.json` | Saved API keys and OAuth credentials. |
| `<agent-dir>/AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, or `CLAUDE.MD` | User instructions applied across working directories. |
| `<agent-dir>/SYSTEM.md` | Replaces nanopi’s default system prompt. |
| `<agent-dir>/APPEND_SYSTEM.md` | Adds instructions to nanopi’s system prompt. |
| `<agent-dir>/skills/` | User [skills](skills.md) and supporting files. |
| `<agent-dir>/prompts/` | User [prompt templates](prompt-templates.md) exposed as slash commands. |

## Project `.nanopi` directory

| Path | Responsibility |
|---|---|
| `.nanopi/settings.json` | Project-level [settings](settings.md), resource paths, and nanopi package declarations. |
| `.nanopi/SYSTEM.md` | Replaces the system prompt for the project. |
| `.nanopi/APPEND_SYSTEM.md` | Adds project-specific instructions to the system prompt. |
| `.nanopi/skills/` | Project skills and supporting files. |
| `.nanopi/prompts/` | Project prompt templates exposed as slash commands. |

For `SYSTEM.md` and `APPEND_SYSTEM.md`, the trusted project file takes precedence over the corresponding agent-directory file. Files with the same name are not combined.

<a id="repo-local-modules"></a>

### Repo-local modules

There is no project extension directory: modules are compiled in, so a project cannot hand the CLI a file to load at runtime. A project that wants its own module adds it where the module list is written:

1. Put the module under `packages/coding-agent/src/` and export a `SessionModule` (`{ name, factory }`).
2. Import it from `packages/coding-agent/src/modules/index.ts` and add it to `BUILTIN_MODULES`.
3. Add a `module/<name>` component and a `moduleBundles` entry to the root `buildconfig.json`; `validateFlavorModules()` fails the build without them.

A module outside `packages/coding-agent/src/` cannot be compiled into the CLI: `tsconfig.build.json` sets `rootDir: "src"`, so tsc rejects any file above it. Importing one type-checks and runs from source, but the build stops at `TS6059`. `.nanopi/extensions/` is therefore a place to keep module source, not a place nanopi loads from. `import-repro`, `prompt-url-widget`, and `redraws` live there for that reason: they are written against the module API and run through the SDK, not through the CLI build.

See [Modules](modules.md) for what a module can register, and [SDK modules](sdk.md#modules) for the embedding-app route.

## Context files

Context files are separate from project `.nanopi` configuration. nanopi loads them from the agent directory, the working directory, and its parent directories. A context file applies whenever nanopi runs in its directory or anywhere below it.

An `AGENTS.override.md` replaces `AGENTS.md` or `CLAUDE.md` only in the same directory. It does not suppress context files from the agent directory or other directories.

Context-file discovery does not require project trust.
