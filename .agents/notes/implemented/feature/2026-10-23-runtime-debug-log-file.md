# Agent Note: Runtime diagnostics go to `nanopi-debug.log`, not stderr

Status: implemented

## Problem

The memory sampler added for issue #165 (`/status` memory row, merged in the
same change series) printed its samples with `process.stderr.write()`, one line
every `NANOPI_MEM_DEBUG` interval. Nobody ever saw a line.

The interactive mode is a full-screen renderer: `TuiMainScreen` keeps the whole
frame in `previousLines` and repaints over it on every change. A line written
to stderr lands underneath that frame and is erased by the next render, which
happens on startup and on every keystroke. Redirecting stderr to a file did not
help either — the process under test never reached the sampling call, so the
first symptom ("no output") had two causes stacked.

The concrete trace: `NANOPI_MEM_DEBUG=1 nanopi`, sample fires after 5 s,
`stderr` gets `mem rss ...`, the renderer redraws the footer, the line is gone.
Only a scrollback after exit would show it, and by then the terminal has been
restored and the alternate screen dropped.

## Decision

Opt-in runtime diagnostics write to a file, keyed by one flag.

- The flag is `NANOPI_DEBUG=1` (was `NANOPI_MEM_DEBUG`), interval
  `NANOPI_DEBUG_INTERVAL_MS` (was `NANOPI_MEM_INTERVAL_MS`, default 5000). One
  flag for one log: the file will hold more than memory lines, and a second
  flag for a second section would make the reader guess which to set.
- The destination is `<agent dir>/nanopi-debug.log`
  (`resolveDebugLogPath(getAgentDir())`), timestamped per line, appended
  synchronously so a crash still leaves the last sample. The agent dir is
  already where the TUI crash log goes, and it survives a killed process.
- Startup writes a header (`debug start version v20261023.abc1234 pid … cwd …`)
  and one `mem startup` sample before the UI mounts, so the numbers of a
  session that dies still identify the build that produced them.
- `MemorySampler` takes `logPath` and owns the file logger; without a path it
  keeps the old stderr sink, which is right for `-p`/RPC where nothing paints
  over the output.
- `/status` reads the sampler's last sample. Verified end to end under a pty:
  the row reports the value of the most recent periodic line, not a fresh
  `process.memoryUsage()`.

## Alternatives considered

- Keep stderr and tell users to redirect: rejected — the interactive renderer
  erases the line before it can be read, so `2>file` is the only way and that is
  exactly what the file sink does, minus the surprise.
- Write into the TUI as a status line: rejected — a diagnostic that changes the
  screen on a 5 s interval is noise in every session that forgot to unset the
  flag, and `/status` already has the on-demand view.
- Log to `os.tmpdir()`: rejected — a temp file is invisible (nobody knows the
  generated name) and gets cleaned between reboots; the agent dir is where a
  user already looks for nanopi's own logs.
- Keep `NANOPI_MEM_DEBUG` as an alias: rejected — nothing has shipped with it
  yet, and two names for one switch is a permanent doc tax.

## Consequences

- Benefit: `NANOPI_DEBUG=1 node nanopi.js` produces readable output in every
  mode, including the full-screen one; the log outlives a crash and names its
  build.
- Cost: one synchronous append per interval (a few hundred bytes), and one more
  file in the agent dir that users may need to delete. Sampling is still off by
  default and the file is only created when the flag is on.
- The header sample is taken before the UI mounts, so it reports the cost of
  the runtime rather than of the rendered frame; later lines cover the rest.
- Testing: `test/memory-usage.test.ts` covers the flag, the interval fallback,
  the log path resolution, the header line, and `createFileLogger` writing
  timestamped lines into a fresh directory.
