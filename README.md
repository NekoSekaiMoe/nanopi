# NanoPi

NanoPi is a lightweight agent harness deeply trimmed and tailored from the Pi Coding Agent, featuring both a CLI and a WebUI.

In an era where coding agent frameworks are blindly bloating into complex microservices and over-engineered platforms, NanoPi retreats back to a pure, controllable core guided by four fundamental philosophies:

1. Radical Minimalism: Faithfully inherits Pi's early minimalist ethos. The core runtime provides only the essential execution loop and atomic tools—rejecting black-box orchestration and unnecessary intermediate abstractions in favor of on-demand customization.
2. Lean Context: While retaining full capability, the system prompt footprint is reduced by nearly two-thirds compared to similar agents. Fewer meta-instructions translate directly to less context drift, stronger instruction adherence, and tangible token savings.
3. Curated Experience: Bridges terminal efficiency with thoughtful aesthetics, delivering an intuitive, accessible WebUI without compromising on lightweight execution.
4. Transparent Extensibility: NanoPi does not aspire to be an all-encompassing microkernel OS, but grants you absolute control over the essentials—from the underlying system prompt to custom extensions.

---

> ![note]
> 
> NanoPi is a personal tool built strictly around my own workflow. No feature requests will be accepted.
>
> If it happens to fit your workflow, you are welcome to use it. If you spot a defect, bug fix PRs are always welcome.

## Installation

Download bundle js in release.

## Session export

`/export [path]` (or `nanopi --export <session.jsonl> [path]`) writes the current session; the path extension picks the format.

- `.html` (default) — the browser document with the session's theme and layout
- `.md` — a plain transcript; tool calls and tool results are kept
- `.jsonl` — the session file itself

Which formats a build carries follows its flavor: `full` exports Markdown and HTML, `base` only Markdown, `minimal` none (the `.jsonl` copy always works). With no `path`, the output name reuses the input's basename and the format's extension.

**Need a PDF?** Open the exported `.html` file in a browser and print it to PDF (Print > Save as PDF). The template's print styles reveal the collapsed tool output, thinking blocks and compaction detail and hide the interaction bar, so the printout is the whole conversation. nanopi has no PDF writer and needs no browser installed to export.

## License

**NanoPi** is distributed under MIT License from Pi Coding Agent.

## Acknowledgements

- **[Pi Coding Agent](https://github.com/...)**: Upstream base runtime and original minimalist philosophy.
- **Memoh**: Visual design reference for the Next.js WebUI rewrite (clean-room reimplementation).
