# Agent Note: 上游 v1.6.0..main Windows 与平台限定项挑选

Status: implemented

## Problem

Issue #809 从 #807 的「平台限定」里分出 Windows 相关项，逐条对照本地代码后，确认三处是 nanopi 上真实存在、且不碰非 Windows/非桌面路径的缺陷：

1. Windows 解析 bash 只探 `%ProgramFiles%\Git`，再从 `where bash.exe` 取第一个结果。Git 装在别处时，第一个结果往往是 WSL launcher `System32\bash.exe`：命令要么失败（未启用 WSL），要么跑进发行版，而不是宿主的 Git Bash（上游 `e8ee38887`，修 #12408）。
2. Windows Tabby 默认右键自行粘贴，同一次右键又作为 SGR mouse press 到达 TUI，触发合成粘贴，文本插入两次（上游 `165c70df9`，修 #12406）。本地只跳过 `TERM_PROGRAM=vscode`。
3. Wayland 的 `wl-copy` 不指定 MIME 时 inferred type 会被 Klipper 丢弃：以 `def`/`import` 开头的文本被推断成 `application/x-ruby`，复制静默失败（上游 `2d8133085`，修 #12374）。这项严格说不是 Windows，是 Linux/Wayland，一并纳入桌面平台处理。

另一项 `e3fa711f4`（WSL 中拒绝更新 Windows 安装）不适用：本地没有 `package-manager-cli.ts`、managed-install 或 `update --self` 机制，nanopi 用自有安装器，不存在这条路径。

## Decision

按缺陷逐项移植到现有文件，不改包结构，也不引入上游的 durable 包：

- Git Bash：`packages/coding-agent/src/utils/shell.ts` 在 Program Files 探测之后、`where bash.exe` 之前插入 `findGitBashOfGitOnPath()`：对 PATH 上的 `git.exe` 跑 `git var GIT_SHELL_PATH`（Git 2.47+），校验返回值以 `usr\bin\sh.exe` 结尾，取 `<root>\bin\bash.exe`。用 Git 的 launcher 而不是报告出来的 `usr\bin\sh.exe`，因为前者设置 `MSYSTEM` 和 `PATH`，后者单独跑找不到 `ls`。返回该路径前用 `shellPathExists()` 确认 launcher 存在；Git 过旧、shell 布局不符或 launcher 缺失都继续走 `bash.exe` fallback。
- Tabby：`packages/tui/src/tui-alt-screen.ts` 把 `TERM_PROGRAM === "vscode"` 换成不区分大小写的终端白名单 `Set(["vscode", "tabby"])`，命中即跳过合成粘贴。
- wl-copy：`packages/coding-agent/src/utils/clipboard.ts` 把裸 `wl-copy` 换成 `wl-copy -t text/plain`。该调用只发纯文本，固定类型不损失任何 offered type。

非 Windows / 非 Wayland 路径完全不变：Unix shell 解析、X11/Termux 剪贴板、非 Windows 的右键行为都保持原样。三处各带回归测试，钉住解析顺序、终端白名单和 MIME 参数。

## Alternatives considered

- **从 `git.exe` 的位置反推安装根**：PATH 上的 git 可能来自 `cmd`、`bin`、`mingw64\bin`、`ucrt64\bin` 或包管理器 shim，位置与安装根没有稳定关系；Git 自己报告最可靠。仅当 `git var GIT_SHELL_PATH` 不可用时才需猜测，而那正是要 fallback 的情形。
- **直接用 `git var` 报告的 `usr\bin\sh.exe`**：它不设置 `MSYSTEM`/`PATH`，单独启动后 `ls` 等工具不在 PATH 上，必须用 `<root>\bin\bash.exe` launcher。
- **Tabby 再加一个 `|| === "tabby"` 判断**：白名单把「会自行右键粘贴的终端」收敛成一处，大小写不敏感，后续终端只需改集合；逐个追加相等判断会重复且容易漏掉大小写变体。
- **让 wl-copy 继续推断类型**：正是失效点；Klipper 对推断出的 `application/x-ruby` 直接丢弃，固定 `text/plain` 无副作用。
- **整包 cherry-pick 上游提交**：上游树的包布局与 nanopi 不同（上游有 durable 包，本地没有），cherry-pick 会拖入无关重构；只取三处相关改动。
- **同步 durable 的镜像查找**：上游 `NodeExecutionEnv` 镜像了同一查找逻辑，但本地没有 durable 包，无可同步对象。

## Consequences

- Windows 上 Git 装在非 Program Files 位置时，bash 工具改用该安装的 Git Bash，不再误入 WSL launcher；默认安装（Program Files）不启动额外 git 进程，行为与耗时不变。
- Tabby + Windows 下右键粘贴只插入一次；其他终端的合成粘贴行为不变。
- Wayland 下复制文本显式声明 `text/plain`，Klipper 等管理器不再因推断类型丢弃内容；wl-copy 仍额外 offer `UTF8_STRING` 等类型，粘贴目标不受影响。
- 三处均有回归测试：`packages/coding-agent/test/windows-shell-config.test.ts`、`packages/tui/test/tui-alt-screen.test.ts`、`packages/coding-agent/test/clipboard.test.ts`。
- 上游 WSL 更新拒绝项因本地无对应机制未纳入，见上。
