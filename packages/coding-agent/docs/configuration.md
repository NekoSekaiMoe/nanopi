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
| `<agent-dir>/PRESET_PROMPTS.md` | Default [preset prompt](#preset-prompts) appended to the system prompt. |
| `<agent-dir>/skills/` | User [skills](skills.md) and supporting files. |
| `<agent-dir>/prompts/` | User [prompt templates](prompt-templates.md) exposed as slash commands. |

## Project `.nanopi` directory

| Path | Responsibility |
|---|---|
| `.nanopi/settings.json` | Project-level [settings](settings.md), resource paths, and nanopi package declarations. |
| `.nanopi/SYSTEM.md` | Replaces the system prompt for the project. |
| `.nanopi/APPEND_SYSTEM.md` | Adds project-specific instructions to the system prompt. |
| `.nanopi/PRESET_PROMPTS.md` | Default [preset prompt](#preset-prompts) for the project. |
| `.nanopi/skills/` | Project skills and supporting files. |
| `.nanopi/prompts/` | Project prompt templates exposed as slash commands. |

For `SYSTEM.md`, `APPEND_SYSTEM.md`, and `PRESET_PROMPTS.md`, the trusted project file takes precedence over the corresponding agent-directory file. Files with the same name are not combined.

### Preset prompts

A preset prompt is one block of instructions appended to the system prompt, chosen per run instead of per project. `--preset <file>` loads that file; `--preset <name>` loads `presets/<name>.md` from the project, then from the agent directory. With no `--preset`, the trusted `.nanopi/PRESET_PROMPTS.md` applies, then `<agent-dir>/PRESET_PROMPTS.md`.

The preset lands in the `<addendum>` section before any `--append-system-prompt` text, so `--append-system-prompt` can refine a preset for one run without editing the file. Unlike `--system-prompt` and `SYSTEM.md`, a preset does not replace the default preamble, so the tool list, rules, and skills sections stay intact. A missing preset name is reported and ignored rather than appended as literal text.

The preset file is read when the session loads resources, so editing it takes effect at the next start, like `SYSTEM.md` and `APPEND_SYSTEM.md`.

<a id="repo-local-modules"></a>

### Repo-local modules

`.nanopi/extensions/` is a project module directory: the `base` and `full` builds load the `.ts`/`.js` files in it when the project is trusted, so a module there needs no build step. See [Modules from disk](modules.md#modules-from-disk).

A module that ships with the CLI itself is compiled in. A project that wants its module inside the binary adds it where the module list is written:

1. Put the module under `packages/coding-agent/src/` and export a `SessionModule` (`{ name, factory }`).
2. Import it from `packages/coding-agent/src/modules/index.ts` and add it to `BUILTIN_MODULES`.
3. Add a `module/<name>` component and a `moduleBundles` entry to the root `buildconfig.json`; `validateFlavorModules()` fails the build without them.

A module outside `packages/coding-agent/src/` cannot be compiled into the CLI: `tsconfig.build.json` sets `rootDir: "src"`, so tsc rejects any file above it. Importing one type-checks and runs from source, but the build stops at `TS6059`. That is why this repository's own `import-repro`, `prompt-url-widget`, and `redraws` live in `.nanopi/extensions/` and load from disk: set `$NANOPI_EXTENSIONS=.nanopi/extensions` and a development build picks them up without recompiling.

See [Modules](modules.md) for what a module can register, and [SDK modules](sdk.md#modules) for the embedding-app route.

## Context files

Context files are separate from project `.nanopi` configuration. nanopi loads them from the agent directory, the working directory, and its parent directories. A context file applies whenever nanopi runs in its directory or anywhere below it.

An `AGENTS.override.md` replaces `AGENTS.md` or `CLAUDE.md` only in the same directory. It does not suppress context files from the agent directory or other directories.

Context-file discovery does not require project trust.
