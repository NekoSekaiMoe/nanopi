# NanoPi

[English](README.md) | 简体中文

NanoPi 是从 Pi Coding Agent 深度裁剪、贴合个人工作流的轻量级 Agent 骨架，带 CLI 和 WebUI。Pi 是上游：NanoPi 保留它的内核，把内核周围的大部分东西都砍掉。

在编码 Agent 框架纷纷膨胀成复杂微服务和过度工程化平台的时代，NanoPi 退回一个纯粹、可控的内核，遵循四条基本理念：

1. 极致精简：忠实继承 Pi 早期的极简取向。内核只提供必需的执行循环和原子工具——拒绝黑盒编排与不必要的中间抽象，一切按需定制。
2. 精简上下文：能力不减的前提下，系统提示词体积比同类 Agent 缩减近三分之二。更少的元指令意味着更少的上下文漂移、更强的指令遵循和实打实的 token 节省。
3. 打磨过的体验：在终端效率与得体审美之间搭桥，提供一个直观、易上手的 WebUI，同时不牺牲执行的轻量。
4. 透明的可扩展性：NanoPi 不打算做包罗万象的微内核操作系统，而是把要紧的那部分——从底层系统提示词到自定义扩展——的绝对控制权交给你。

---

> [!NOTE]
>
> NanoPi 是严格围绕我个人工作流打造的个人工具，不接受功能请求。
>
> 如果它正好契合你的工作流，欢迎使用。发现缺陷的话，修复类的 PR 永远欢迎。

## 安装

从 Release 下载打包好的 js，或者让 `install.js` 帮你取一份：

```bash
curl -fsSL https://raw.githubusercontent.com/NekoSekaiMoe/nanopi/main/install.js | node
```

国内访问 GitHub Releases 慢或者不通：同一批包由 GitHub Actions 的流水线自己发到 AtomGit 的 [nanopi/releases-assets](https://atomgit.com/nanopi/releases-assets)（每天一次 nightly，每次正式发布各一份）。把那个仓库 README 里的镜像地址交给 `install.js`：

```bash
# 地址里带 tag，`nightly` 或 v20261031.1.0 这样的正式版本
curl -fsSL https://atomgit.com/NanoPi/NanoPi/raw/main/install.js | node - --mirror=https://atomgit.com/nanopi/releases-assets/raw/main/nightly

# 也可以直接取文件，没有 API，也不用登录
curl -fsSLO https://atomgit.com/nanopi/releases-assets/raw/main/nightly/nanopi.js
```

AtomGit 上的源码仓是镜像，发布说明、源码包和 npm 包仍以 GitHub 为准。

这会把 `full` 包安装为 `~/.local/bin/nanopi.js`，并在旁边放一个 `nanopi` 垫片；只要 `~/.local/bin` 在 `PATH` 里，`nanopi` 就能直接运行（不在 `PATH` 里时 `install.js` 会提示）。两种用法下 `install.js` 的参数一致：

```bash
# 更小的包：base 或 minimal
curl -fsSL https://raw.githubusercontent.com/NekoSekaiMoe/nanopi/main/install.js | node - --sku=minimal

# 指定版本，而不是最新版
curl -fsSL https://raw.githubusercontent.com/NekoSekaiMoe/nanopi/main/install.js | node - --version=v20261013

# 先存成脚本，然后传参时省掉那个 `-`
curl -fsSLO https://raw.githubusercontent.com/NekoSekaiMoe/nanopi/main/install.js
node install.js --sku=base

# 换个安装前缀，比如 npm 的习惯
node install.js --prefix=/usr/local

# 只要包文件本身，不要垫片，不建目录
node install.js --out=./nanopi.js
```

- `--sku=full|base|minimal`（默认 `full`）选择口味；每个口味带什么，见 `buildconfig.json` 里的口味表。
- `--version=<tag>`（默认最新 Release）接受带不带前导 `v` 的 tag。
- `--prefix=<dir>`（默认 `~/.local`）安装到 `<dir>/bin`：包文件按 asset 名落盘，外加一个 `nanopi` 垫片（Windows 上是 `nanopi.cmd`），它执行 `node <dir>/bin/<asset 名>`。用 `nanopi` 启动。
- `--out=<path>` 只把包文件写到指定路径，别的什么都不做，不能与 `--prefix` 同时使用。
- `--mirror=<url>` 从镜像而不是 GitHub Releases 取包。URL 用镜像 README 里给的那一个，它自带 tag——镜像不帮你解析「最新版」，此时 `--version` 不起作用。

下载内容会对照 Release 的 `SHA256SUMS` 校验，不一致就失败。运行 `node install.js --help` 可以看到同样的说明。

## 会话导出

`/export [path]`（或 `nanopi --export <session.jsonl> [path]`）导出当前会话，路径的扩展名决定格式。

- `.html`（默认）：带当前主题与排版的浏览器文档
- `.md`：纯文本转写，保留工具调用与工具结果
- `.jsonl`：会话文件本身

一个构建带哪些格式取决于口味：`full` 导出 Markdown 和 HTML，`base` 只导出 Markdown，`minimal` 不导出（`.jsonl` 副本始终可用）。不给 `path` 时，输出名沿用输入文件的基名，扩展名按格式补。

**想要 PDF？** 用浏览器打开导出的 `.html`，打印成 PDF（打印 > 另存为 PDF）。模板的打印样式会展开折叠的工具输出、思考块和压缩细节，并隐藏交互栏，所以打印出来的就是完整对话。nanopi 没有 PDF 生成器，导出也不需要装浏览器。

## 许可证

**NanoPi** 依照来自 Pi Coding Agent 的 MIT License 分发。

## 致谢

NanoPi 是 [Pi Coding Agent](https://github.com/Earendil-Works/pi) 的 fork：运行时、工具和极简理念都出自 Pi，这个 fork 去掉的部分比留下的部分更好列举。WebUI 的视觉语言沿用 Memoh 公开的设计体系，为净室重写（未复制代码）。

## LINUX DO

<p align="center">
  <a href="https://linux.do/">
    <img src="./packages/coding-agent/docs/images/linux-do.png" width="42%" alt="LINUX DO">
  </a>
</p>

<p align="center">
  <strong>AI 相关，上 <a href="https://linux.do/">LINUX DO</a>。祝社区越办越好。</strong>
</p>

## AtomGit

<p align="center">
  <a href="https://atomgit.com/NanoPi/NanoPi">
    <img src="./packages/coding-agent/docs/images/atomgit.png" width="12%" alt="AtomGit">
  </a>
</p>

<p align="center">
  <strong>国内镜像与下载，见 <a href="https://atomgit.com/NanoPi/NanoPi">AtomGit</a>。感谢 AtomGit 提供的托管。</strong>
</p>
