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
import type { SessionModule } from "@nanopi/pi-coding-agent/modules";

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

## Declare the surfaces a module uses

`ModuleApi` is a composition of eight smaller contracts. A module that only
registers a command should not be handed `registerProvider`; say which surfaces
it uses and the compiler holds it to that:

```typescript
import type { ModuleCommandsSurface, SessionModule } from "@nanopi/pi-coding-agent/modules";

export default {
	name: "standup-notes",
	factory: (nanopi) => {
		nanopi.registerCommand("standup", { /* ... */ });
		// nanopi.registerProvider(...)  // error: not part of ModuleCommandsSurface
	},
} satisfies SessionModule<ModuleCommandsSurface>;
```

| Surface | What it carries |
|---|---|
| `ModuleEventsSurface` | the `on()` overloads, one per event the host emits |
| `ModuleToolsSurface` | `registerTool`, and the shell-backend trio (`registerBashOperations`, `setActiveBashOperations`, `getActiveBashOperations`) |
| `ModuleCommandsSurface` | `registerCommand`, `registerShortcut`, `registerFlag`, `getFlag` |
| `ModuleRenderingSurface` | `registerMessageRenderer`, `registerEntryRenderer`, `registerToolRenderer`, `registerMarkdownTransformer` |
| `ModuleActionsSurface` | `sendMessage`, `deliverMessage`, `sendUserMessage`, `appendEntry` |
| `ModuleSessionSurface` | `setSessionName`, `getSessionName`, `setLabel`, `exec`, `getActiveTools`, `getAllTools`, `getSettings`, `setActiveTools`, `getCommands`, `getModuleNames` |
| `ModuleModelSurface` | `setModel`, `getThinkingLevel`, `setThinkingLevel` |
| `ModuleProvidersSurface` | `registerProvider`, `unregisterProvider`, `registerVirtualModel`, `unregisterVirtualModel` |

Every surface also carries `events`, the shared `EventBus`.

The type parameter narrows the factory parameter only: the object the host
actually passes is the full `ModuleApi`, so a surface-composed type is a
*view*, not a smaller object. Pass `pi` to a helper that declares a wider
surface than you do and the compiler rejects it, which is the point - widen
the module's declaration rather than widening the helper. Leave the type
parameter off (`SessionModule`) and nothing changes.

The split is a promise about what a module *may* touch, checked when the
module is written. It is not a capability check at load time.

## Which entry point to import

Two subpaths carry what a module needs, and the package root carries everything else:

| Import from | Gives you |
|---|---|
| `@nanopi/pi-coding-agent/modules` | `SessionModule`, `ModuleApi`, `ModuleContext`, the event types, `isToolCallEventType`, `ToolDefinition`, `defineTool`, the UI context types |
| `@nanopi/pi-coding-agent/ui` | `Theme`, `getMarkdownTheme`, `renderDiff`, `CustomEditor`, `ToolExecutionComponent`, `truncateToVisualLines`, and the rest of the components a renderer returns |
| `@nanopi/pi-coding-agent` | the host surface: `createAgentSession`, `SessionManager`, `DefaultResourceLoader`, storage, model runtime |

The narrow doors exist because the root barrel is a promise: every name in it is part of the published `.d.ts`, and changing one is a breaking change. `./modules` and `./ui` are small enough to keep that promise cheaply, and `check:entry-graphs` holds them to a file budget so one additive export cannot turn them back into the root barrel. Import from a subpath when you are writing a module; the root stays for code that builds a session.

## What a module can register

- `registerTool(tool)` - a tool the model can call. The definition is the same `ToolDefinition` shape the built-in tools use.
- `registerCommand(name, options)` - a slash command; `handler(args, ctx)` gets a command context.
- `registerFlag(name, options)` - a CLI flag; read its value with `getFlag(name)`.
- `registerShortcut(keyId, options)` - a keybinding.
- `registerProvider(name, config)` / `unregisterProvider(name)` - a provider, its models, or a streaming override.
- `registerVirtualModel(...)` / `unregisterVirtualModel(...)` - a virtual model that routes to a physical one per request.
- `registerBashOperations(id, operations)` + `setActiveBashOperations(id)` - route shell commands through a sandbox.
- Renderers: `registerMessageRenderer`, `registerEntryRenderer`, `registerToolRenderer`, `registerMarkdownTransformer`.
- Transcript rows the module does not own: `registerToolRowRenderer` (restyle, flatten, or hide the row of a tool another module registered), `registerShellRenderer` (`!` command rows), `registerAssistantMessageRenderer` (the body of an assistant message, e.g. its thinking rows).
- Chrome: `registerWorkingIndicator` (the streaming working line), `registerSettingsItem` / `unregisterSettingsItem` (rows in the settings list, and retiring a core row a module supersedes).

Registration failures are programming errors and surface as load errors; they do not silently skip the module.

## Restyle a row you do not own

`registerTool` replaces a tool, including its `execute`. When all you want is a
different row, `registerToolRowRenderer` hands you the row for one call:

```typescript
nanopi.registerToolRowRenderer((toolName, next) => {
	// `next()` is the row the remaining resolvers, then the tool itself, would draw.
	if (!toolName.startsWith("mcp__")) return undefined;
	const base = next();
	return {
		...base,
		renderResult: (result, options, theme, context) => {
			// context.toolName identifies the row; context.hide() folds it away.
			return base?.renderResult?.(result, options, theme, context) ?? new Text("", 0, 0);
		},
	};
});
```

The same shape covers the other rows a reskin needs: `registerShellRenderer`
for `!` commands, `registerAssistantMessageRenderer` for an assistant message's
body (return `false` to leave the message to the default renderer), and
`registerWorkingIndicator` for the streaming working line.

## React to session events

`nanopi.on(event, handler)` is where a module observes or changes a run. Handlers receive the event and a `ModuleContext`; a handler can return a value to change behavior:

```typescript
import { isToolCallEventType } from "@nanopi/pi-coding-agent/modules";

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

## Modules from disk

Compiled-in modules are the whole story for a build without jiti support. The
`base` and `full` builds also load module files from three places:

1. The paths in `$NANOPI_EXTENSIONS` (files or directories, `:`-separated).
2. `<agent dir>/extensions/`, the user-wide directory (`~/.nanopi/agent/extensions/`).
3. `.nanopi/extensions/`, the project directory — only when the project is
   trusted, because these files are code the project wrote.

A module file default-exports either a `SessionModule` or a bare factory. jiti
transforms it in-process, so a `.ts` file runs as written and `import type`
lines cost nothing at runtime. Aliases point `@nanopi/pi-coding-agent` (and its
`/modules` and `/ui` subpaths), `@nanopi/pi-agent-core`, `@nanopi/pi-ai`, and
`@nanopi/pi-tui` at the running installation, so a module sees the same classes,
tools, and theme helpers the CLI uses.

```ts
// .nanopi/extensions/hello.ts
import type { SessionModule } from "@nanopi/pi-coding-agent/modules";

const hello: SessionModule = {
	name: "hello",
	factory: (nanopi) => {
		nanopi.registerCommand("hello", {
			description: "Say hello",
			handler: async (_args, ctx) => ctx.ui.notify("hello", "info"),
		});
	},
};

export default hello;
```

One broken file is reported as a diagnostic and skipped; the rest still load.

The `minimal` build and every single-file `nanopi.js` have no jiti: the
`jiti-modules` component is off, and a disk module there is never read. The npm
bundle carries jiti as a dependency and loads jiti only when it actually has a
file to import.

## What a module cannot do

- Be reloaded. Editing a module means restarting the process; the module set is
  read once per session.
- Reach events that no consumer uses. The event set above is the surface; events that no built-in consumer needed (`resources_discover`, `user_bash`, and a dozen others) were removed rather than kept as empty hooks.

Skills, prompt templates, and context files are still local files that nanopi discovers at startup. They are separate from modules and do not need code.

## Learn from the built-ins

Everything shipped with nanopi is a module: run modes and permissions (`packages/extra`), llama.cpp support, `/compact`, `/context`, `/status`, `/init`, codex-style compaction, and the extras under `packages/coding-agent/src/extras/` (`ask-lite`, `todo-lite`, `websearch`, `pi-rewind`, `pi-subagent-mini`, `pi-ui`, and the rest). This repository's own `.nanopi/extensions/` modules (`import-repro`, `prompt-url-widget`, `redraws`) are smaller, readable examples of the same shape; point `$NANOPI_EXTENSIONS` at that directory to load them into a development build.

A full runnable SDK example is [06-modules.ts](../examples/sdk/06-modules.ts).
