# Environment Variables

nanopi uses environment variables in three ways:

- Variables such as `NANOPI_OFFLINE` configure the nanopi process.
- nanopi sets process markers so child processes can identify nanopi as the launching agent.
- Commands run by the LLM-callable shell tools receive `NANOPI_*` variables describing the current session.

Provider API-key variables are documented separately in [Providers](providers.md#use-an-api-key-from-the-environment).

## Process Marker

The CLI and RPC entry points set two process markers:

- `AI_AGENT=nanopi` is a generic marker that lets tooling identify nanopi as the agent that launched the process.
- `NANOPI_CODING_AGENT=true` is nanopi-specific and lets child processes detect that they run inside nanopi.

Child processes inherit both markers. They are not session-specific and are not set automatically when nanopi is embedded through the SDK.

## Shell Tool Session Environment

Commands run by the `bash` and `powershell` tools receive the current nanopi session state:

| Variable | Description |
|----------|-------------|
| `NANOPI_SESSION_ID` | Current session ID |
| `NANOPI_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
| `NANOPI_PROVIDER` | Currently selected model provider |
| `NANOPI_MODEL` | Currently selected model ID |
| `NANOPI_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

The values are resolved when each command starts. Switching models or changing the reasoning level therefore affects the next shell command without restarting nanopi. `NANOPI_PROVIDER` and `NANOPI_MODEL` identify the selected nanopi model, not a different upstream model that a router may choose internally.

When asked which model or provider is running, inspect these variables instead of inferring the answer from the system prompt:

```bash
printf '%s/%s\n' "$NANOPI_PROVIDER" "$NANOPI_MODEL"
printf 'reasoning=%s session=%s\n' "$NANOPI_REASONING_LEVEL" "$NANOPI_SESSION_ID"
```

The session file can be inspected directly when the session is persistent:

```bash
if [ -n "$NANOPI_SESSION_FILE" ]; then
  tail -n 1 "$NANOPI_SESSION_FILE"
fi
```

These variables are injected into the LLM-callable `bash` and `powershell` tools. They are not injected into user-entered `!` or `!!` commands.

### Custom Shell Tools

Tools created with `createBashTool()` or `createPowerShellTool()` expose the session environment by default when registered with nanopi. Injection happens before `spawnHook`, so a hook receives the variables in `ctx.env`:

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

Disable session metadata independently of the spawn hook:

```typescript
const powershellTool = createPowerShellTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

When disabled, nanopi removes inherited values for these variables so nested nanopi processes do not expose stale parent-session metadata.

## nanopi Process Configuration

These variables are read by nanopi itself:

| Variable | Description |
|----------|-------------|
| `NANOPI_CODING_AGENT_DIR` | Override the config directory; default is `~/.nanopi/agent` |
| `NANOPI_CODING_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir` |
| `NANOPI_EXTENSIONS` | Extra module files or directories to load from disk, `:`-separated; ignored by builds without jiti (`minimal`, the single-file `nanopi.js`). See [Modules from disk](modules.md#modules-from-disk) |
| `NANOPI_DEBUG` | Debug mode. Appends a memory sample to `nanopi-debug.log` in the agent dir every `NANOPI_DEBUG_INTERVAL_MS` (default `5000`), plus one at startup, because interactive mode paints over stderr and the file is the only place these numbers survive. Interactive mode also writes a diagnostic bundle to `<agent dir>/diagnostics/` at startup and at exit: environment, model and provider (credentials redacted), loaded modules, settings, failed assistant turns, recorded crashes, the session transcript, and the tail of `nanopi-debug.log`. Nothing is uploaded; the directory is printed when the session ends |
| `NANOPI_PACKAGE_DIR` | Override the package directory, useful for Nix/Guix store paths |
| `NANOPI_OFFLINE` | Disable automatic network activity, including model catalog refreshes |
| `NANOPI_TELEMETRY` | Override provider attribution headers: `1`/`true`/`yes` or `0`/`false`/`no` |
| `NANOPI_CACHE_RETENTION` | Set to `long` for extended provider prompt caching where supported |
| `NANOPI_HARDWARE_CURSOR` | Set to `1` to show the hardware cursor; see [Terminal setup](terminal-setup.md) |
| `NANOPI_CLIPBOARD_OSC52` | Set to `1` to also send copied text to the terminal with OSC 52 after the local clipboard write, as nanopi does over SSH. Use it when a remote client reaches nanopi without SSH variables, such as a multiplexer attached from another machine or a remote IDE daemon |
| `NANOPI_HYPERLINKS` | Override OSC 8 hyperlink detection with `1`, `0`, or `auto` |
| `NANOPI_PROGRAM_STATUS` | Override OSC 7501 program status detection: `1` always reports, `0` never reports; otherwise nanopi reports only after the terminal confirms support. See [Terminal setup](terminal-setup.md#program-status) |
| `NANOPI_IMAGE_PROTOCOL` | Override inline image detection with `kitty`, `iterm2`, `none`, or `auto` |
| `NANOPI_TRUE_COLOR` | Override truecolor detection with `1`, `0`, or `auto` |
| `NANOPI_TUI_ESC_TIMEOUT` | How long to wait after a lone ESC before treating it as Escape, in milliseconds; defaults to `100` over SSH and `10` otherwise. Increase if Alt-key input is misread as Escape |
| `VISUAL`, `EDITOR` | External editor fallback when `externalEditor` is unset |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests |

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and provider-specific configuration are listed in [Providers](providers.md#use-an-api-key-from-the-environment).
