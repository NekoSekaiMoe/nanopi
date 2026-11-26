# pi-output-compact

Context-saving compaction of `bash`, `read`, and `grep` tool results, ported from pi-rtk-optimizer's output compactor. No `rtk` binary, command rewriting, or TUI.

Off by default because the techniques are lossy. Enable with `<agentDir>/output-compaction.json`:

```json
{ "outputCompaction": { "enabled": true } }
```

`/output-compaction` reports the current setting and character savings.
