# NanoPi

English | [简体中文](README.zh-CN.md)

NanoPi is a lightweight agent harness deeply trimmed and tailored from the Pi Coding Agent, featuring both a CLI and a WebUI. Pi is the upstream: NanoPi keeps its core and drops most of what surrounds it.

In an era where coding agent frameworks are blindly bloating into complex microservices and over-engineered platforms, NanoPi retreats back to a pure, controllable core guided by four fundamental philosophies:

1. Radical Minimalism: Faithfully inherits Pi's early minimalist ethos. The core runtime provides only the essential execution loop and atomic tools—rejecting black-box orchestration and unnecessary intermediate abstractions in favor of on-demand customization.
2. Lean Context: While retaining full capability, the system prompt footprint is reduced by nearly two-thirds compared to similar agents. Fewer meta-instructions translate directly to less context drift, stronger instruction adherence, and tangible token savings.
3. Curated Experience: Bridges terminal efficiency with thoughtful aesthetics, delivering an intuitive, accessible WebUI without compromising on lightweight execution.
4. Transparent Extensibility: NanoPi does not aspire to be an all-encompassing microkernel OS, but grants you absolute control over the essentials—from the underlying system prompt to custom extensions.

---

> [!NOTE]
> 
> NanoPi is a personal tool built strictly around my own workflow. No feature requests will be accepted.
>
> If it happens to fit your workflow, you are welcome to use it. If you spot a defect, bug fix PRs are always welcome.

## Installation

Download bundle js in release, or let `install.js` fetch one for you:

```bash
curl -fsSL https://raw.githubusercontent.com/NekoSekaiMoe/nanopi/main/install.js | node
```

In mainland China, GitHub Releases is slow or unreachable. The same bundles are published to AtomGit's [nanopi/releases-assets](https://atomgit.com/nanopi/releases-assets) by the GitHub Actions workflows themselves (nightly, and every release); pass the mirror URL printed in that repository's README to `install.js`:

```bash
# the URL carries the tag, `nightly` or a release like v20261031.1.0
curl -fsSL https://atomgit.com/NanoPi/NanoPi/raw/main/install.js | node - --mirror=https://atomgit.com/nanopi/releases-assets/raw/main/nightly

# or fetch the file itself, there is no API and no login
curl -fsSLO https://atomgit.com/nanopi/releases-assets/raw/main/nightly/nanopi.js
```

The AtomGit source repository is a mirror, and the release notes, source archive and npm packages stay on GitHub.

That installs the `full` bundle as `~/.local/bin/nanopi.js` and puts a `nanopi` shim beside it, so `nanopi` runs once `~/.local/bin` is on `PATH` (`install.js` says so when it is not).
`install.js` takes the same arguments either way:

```bash
# a smaller bundle: base or minimal
curl -fsSL https://raw.githubusercontent.com/NekoSekaiMoe/nanopi/main/install.js | node - --sku=minimal

# a specific release instead of the latest one
curl -fsSL https://raw.githubusercontent.com/NekoSekaiMoe/nanopi/main/install.js | node - --version=v20261013

# keep it as a script and pass arguments without the `-`
curl -fsSLO https://raw.githubusercontent.com/NekoSekaiMoe/nanopi/main/install.js
node install.js --sku=base

# a different prefix, like npm's
node install.js --prefix=/usr/local

# just the bundle file, no shim, no directory
node install.js --out=./nanopi.js
```

- `--sku=full|base|minimal` (default `full`) picks the flavor; see the flavor table in `buildconfig.json` for what each carries.
- `--version=<tag>` (default: latest release) accepts the tag with or without the leading `v`.
- `--prefix=<dir>` (default `~/.local`) installs into `<dir>/bin`: the bundle as `<asset name>` plus a `nanopi` shim (`nanopi.cmd` on Windows) that runs `node <dir>/bin/<asset name>`. Run it with `nanopi`.
- `--out=<path>` writes the bundle to exactly that path and nothing else. It cannot be combined with `--prefix`.
- `--mirror=<url>` takes the bundles from a mirror instead of GitHub Releases. The URL is the one printed in that mirror's README and it carries the tag, because a mirror resolves nothing for `latest`; `--version` is then ignored.

The download is checked against the release's `SHA256SUMS` and fails on a mismatch. Run `node install.js --help` for the same summary.

## Session export

`/export [path]` (or `nanopi --export <session.jsonl> [path]`) writes the current session; the path extension picks the format.

- `.html` (default) — the browser document with the session's theme and layout
- `.md` — a plain transcript; tool calls and tool results are kept
- `.jsonl` — the session file itself

Which formats a build carries follows its flavor: `full` exports Markdown and HTML, `base` only Markdown, `minimal` none (the `.jsonl` copy always works). With no `path`, the output name reuses the input's basename and the format's extension.

**Need a PDF?** Open the exported `.html` file in a browser and print it to PDF (Print > Save as PDF). The template's print styles reveal the collapsed tool output, thinking blocks and compaction detail and hide the interaction bar, so the printout is the whole conversation. nanopi has no PDF writer and needs no browser installed to export.

## License

**NanoPi** is distributed under MIT License from Pi Coding Agent.

## Credits

NanoPi is a fork of [Pi Coding Agent](https://github.com/Earendil-Works/pi): the runtime, the tools,
and the minimalist philosophy are Pi's work, and the parts this fork removed are easier to list than
the parts it kept. The WebUI's visual language follows Memoh's documented design system, reimplemented
clean-room (no code copied).

## LINUX DO

<p align="center">
  <a href="https://linux.do/">
    <img src="./packages/coding-agent/docs/images/linux-do.png" width="42%" alt="LINUX DO">
  </a>
</p>

<p align="center">
  <strong>For all things AI, head to <a href="https://linux.do/">LINUX DO</a>. Wishing the community ever greater success.</strong>
</p>
