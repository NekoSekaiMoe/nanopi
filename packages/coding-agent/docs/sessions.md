# Sessions and Context

nanopi saves a conversation as a session. The active branch of that session supplies conversation history for the next model request. Use session commands to continue work, explore another branch, or reduce the amount of history sent to the model.

## Continue or switch sessions

nanopi saves sessions automatically unless you start it with `--no-session`.

```bash
nanopi --continue
nanopi --resume
```

`--continue` opens the most recent session for the current working directory. `--resume` opens the session picker. In interactive mode, `/resume` opens the same picker and `/new` starts a new session.

Use `/name` or `--name` to assign a recognizable session name. Run `/session` to verify the current session file, ID, message count, token usage, and cost.

The session picker lets you search, rename, and delete sessions. It can also show paths, change sorting, and limit results to named sessions. See [Keybindings](keybindings.md#sessions) for its shortcuts.

## Choose how to branch

nanopi stores entries as a tree, so returning to an earlier point does not erase the branch you leave.

| Action | Result | Use it when |
|---|---|---|
| `/tree` | Moves within the current session file | Related alternatives should stay together |
| `/fork` | Creates a new session from an earlier user message | The alternative should become separate work |
| `/clone` | Copies the active branch into a new session | You want a separate copy of the current state |

In `/tree`, select a user message to put its text back in the editor. Edit and submit it to create another branch. Selecting an assistant response or another entry continues after that entry with an empty editor.

When you leave a branch, nanopi can summarize it and attach that summary to the branch you enter. This preserves relevant work from the abandoned path without including every message from it.

For the persisted tree and entry types, see [Session Format](session-format.md).

## Manage conversation context

The model receives the active branch, not every branch in the session file. nanopi combines that history with the system prompt, discovered context files, available tools, and loaded skill descriptions. [How nanopi Works](how-nanopi-works.md#context) describes how those inputs are assembled.

The footer shows current context usage. When the active context approaches the model's limit, nanopi normally compacts older history automatically. Compaction adds a summary and keeps recent messages. It does not delete the original session entries.

Run `/compact` to compact manually. You can add instructions when the summary should preserve a particular topic or decision. Configure automatic compaction and retained history through [Settings](settings.md#compaction).

Compaction can fail if the provider is unavailable or cannot accept the summarization request. Correct the provider problem and run `/compact` again. Disabling automatic compaction does not disable the manual command.

See [Compaction Reference](compaction.md) for thresholds, retained boundaries, branch-summary behavior, and extension hooks.

## Control session storage

By default, nanopi stores sessions under `~/.nanopi/agent/sessions/`, grouped by working directory. Use `--session-dir`, `NANOPI_CODING_AGENT_SESSION_DIR`, or the `sessionDir` setting to choose another location. The CLI option has highest precedence.

Use `--no-session` for an ephemeral run. An ephemeral session cannot be resumed after nanopi exits.

Use `--session` when you already know the session path or ID. Use `--fork` to create a new session from an existing session before interactive mode starts.

## Export or share a session

Use `/export [path]` to write the current session as Markdown (`.md`), HTML (`.html`), or the session file itself (`.jsonl`); the path extension picks the format and HTML is the default.

Need a PDF? Open the exported `.html` file in a browser and print it to PDF (Print > Save as PDF). The template styles the printout: collapsed tool output, thinking blocks and compaction detail are revealed, and the interaction bar is hidden, so the paper copy holds the same conversation as the page. nanopi itself has no PDF writer and needs no browser to export.

Which formats a build carries depends on its flavor: `full` exports Markdown and HTML, `base` only Markdown, `minimal` none (the `.jsonl` export is ungated). A build that drops a format says so instead of writing an empty file. With `--export <session.jsonl>` and no path, Markdown and HTML get the input's basename, while a `.jsonl` export asks for a destination instead of rewriting the session it reads.

Use `/share` to upload the session and get a viewer link. nanopi uses a Radius artifact when Radius authentication is configured; otherwise, it uses a private GitHub gist.

Review exported or shared sessions first. They can contain prompts, model responses, tool arguments, command output, file contents, and extension messages.

## Report a bug

Bugs go to the GitHub tracker: https://github.com/NekoSekaiMoe/nanopi/issues/new?template=bug.yml. nanopi has no in-app reporting command and uploads nothing.

To attach context, start nanopi with `NANOPI_DEBUG=1`. Debug mode writes a diagnostic bundle to `<agent dir>/diagnostics/` when the session starts and again when it ends, and prints the directory on exit. A bundle holds `diagnostics.json` (environment, model and provider with credentials redacted, loaded modules, settings), `report.json` (failed assistant turns and recorded crashes), `session.jsonl` (the current branch), and the tail of the debug log, next to a `bundle.zip` with the same files.

Review the bundle before posting it. Sessions can contain prompts, tool arguments, command output, and file contents, and the transcript is not redacted. Without the flag, run `/export` (or `/share` for a link) instead.
