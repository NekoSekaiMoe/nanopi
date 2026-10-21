# Modules

Modules are how you add code to nanopi: tools, slash commands, CLI flags, shortcuts, providers, and handlers for session events. A module is a plain object with a `name` and a `factory`, and it runs when something imports it.

There is no plugin directory, no install command, and no `--extension` flag. Loading a new module means compiling it into the build or passing it to the SDK. That is the whole mechanism, and it also means the question "how do I call my module" has one answer: your code imports it.

## Where a module can come from

Three places, depending on what you are building:

| You are... | Add the module by | Documented in |
|---|---|---|
| Writing an app that embeds nanopi | passing `modules: [myModule]` to `createAgentSession()` or `DefaultResourceLoader` | [SDK modules](sdk.md#modules) |
| Working inside this repository | putting the source under `packages/coding-agent/src/`, importing it in `src/modules/index.ts`, and adding a `module/<name>` component to `buildconfig.json` | [Repo-local modules](configuration.md#repo-local-modules), [Build flavors](sdk.md#build-flavors) |

A published package ships every built-in module. `--modules a,b` narrows that list for one run; it cannot add a module the binary does not carry.

## Write a module

```typescript
import type { SessionModule } from "@nanopi/pi-coding-agent";

export default {
	name: "standup-notes",
	factory: (nanopi) => {
		nanopi.registerCommand("standup", {
			description: "Summarize what changed since yesterday",
			handler: async (_args, ctx) => {
				const result = await nanopi.exec("git", ["log", "--since=yesterday", "--oneline"]);
				ctx.ui.notify(result.stdout.trim() || "No commits since yesterday", "info");
			},
		});
	},
} satisfies SessionModule;
```

The factory runs once per session construction, in load order, before the first prompt. Registration happens synchronously through the `ModuleApi` it receives.

## What a module can register

- `registerTool(tool)` - a tool the model can call. The definition is the same `ToolDefinition` shape the built-in tools use.
- `registerCommand(name, options)` - a slash command; `handler(args, ctx)` gets a command context.
- `registerFlag(name, options)` - a CLI flag; read its value with `getFlag(name)`.
- `registerShortcut(keyId, options)` - a keybinding.
- `registerProvider(name, config)` / `unregisterProvider(name)` - a provider, its models, or a streaming override.
- `registerVirtualModel(...)` / `unregisterVirtualModel(...)` - a virtual model that routes to a physical one per request.
- `registerBashOperations(id, operations)` + `setActiveBashOperations(id)` - route shell commands through a sandbox.
- Renderers: `registerMessageRenderer`, `registerEntryRenderer`, `registerToolRenderer`, `registerMarkdownTransformer`.

Registration failures are programming errors and surface as load errors; they do not silently skip the module.

## React to session events

`nanopi.on(event, handler)` is where a module observes or changes a run. Handlers receive the event and a `ModuleContext`; a handler can return a value to change behavior:

```typescript
import { isToolCallEventType } from "@nanopi/pi-coding-agent";

nanopi.on("tool_call", (event) => {
	// Block a destructive command before it runs.
	if (isToolCallEventType("bash", event) && /rm -rf \//.test(event.input.command)) {
		return { block: true, reason: "refusing to delete the filesystem" };
	}
});

nanopi.on("before_agent_start", (event) => ({
	// The prompt is rendered from systemPromptOptions plus earlier handlers.
	systemPrompt: `${event.systemPrompt}\n\nThis project uses pnpm, never npm.`,
}));
```

The event set is the one real consumers use: `project_trust`, `session_start`, `session_shutdown`, `session_before_fork`, `session_before_compact`, `session_compact`, `session_before_tree`, `session_tree`, `before_agent_start`, `agent_start`, `agent_end`, `agent_settled`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_call`, `tool_result`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `model_select`, `input`, `before_provider_request`, and `before_provider_headers`.

Several handlers for the same event run in module load order. `tool_call` can block or modify, `message_end` can replace the message, `input` can transform a prompt, `turn_end` merges boundaries.

## What a module cannot do

- Be discovered. Nothing scans `~/.nanopi` or `.nanopi` for code to run.
- Be reloaded. Editing a module means rebuilding the binary or restarting the embedding app.
- Reach events that no consumer uses. The event set above is the surface; events that no built-in consumer needed (`resources_discover`, `user_bash`, and a dozen others) were removed rather than kept as empty hooks.

Skills, prompt templates, and context files are still local files that nanopi discovers at startup. They are separate from modules and do not need code.

## Learn from the built-ins

Everything shipped with nanopi is a module: run modes and permissions (`packages/extra`), llama.cpp support, `/compact`, `/context`, `/status`, `/init`, codex-style compaction, and the extras under `packages/coding-agent/src/extras/` (`ask-lite`, `todo-lite`, `websearch`, `pi-rewind`, `pi-subagent-mini`, `pi-ui`, and the rest). This repository's own `.nanopi/extensions/` modules (`import-repro`, `prompt-url-widget`, `redraws`) are smaller, readable examples of the same shape; they are run through the SDK, since the CLI build only compiles modules under `packages/coding-agent/src/`.

A full runnable SDK example is [06-modules.ts](../examples/sdk/06-modules.ts).
