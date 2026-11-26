# pi-meat

`meat` reads a git diff and returns a faithful reading diff. A subagent submits remove/fold/replace line coordinates; the deterministic compiler emits every untouched line verbatim, so the result cannot invent content. Large diffs are chunked at file and hunk boundaries and cached by content hash.

Requires `pi-subagent-mini`.
