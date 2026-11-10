# Agent Note: Kitty 图片重贴只在无头断言里验证过，多终端实拍矩阵未做

Status: implemented

## Problem

`imageCellsNeedRedraw` 与 `drawKittyImagesLast` 的 `isWezTerm` 门控已经删掉（`0346b6497`，
#645 合入，ref #640 第 4 条 `4622edb7`）。改后的行为是：只要 `imageProtocol === "kitty"`，
「覆盖图片的文本行被重绘」就先清 placement、再写文本、最后重贴，不再区分终端品牌。

上游给这条改动的验证是「Ghostty 1.3.1、Kitty latest 结果一致」——在两个真实终端上肉眼确认
图片不消失。本仓库没有等价手段：无头环境里装不了 Ghostty / Kitty，`tmux` 也不在。
所以 `packages/tui/test/tui-alt-screen.test.ts` 里那条新用例只能断言字节序：

- 先出现 `deleteAllKittyPlacements`；
- placement 写在 `changed` 之后；
- 没有重新上传（不出现 `\x1b_Ga=T`）。

这三条能证明「代码按预期顺序发出转义序列」，证明不了「终端把图片留在了屏幕上」。中间隔着的
是终端自身的实现：xterm.js 的 image addon、Ghostty 的格子绑定、Kitty 的 placement 生命周期。
门控从 WezTerm 一家放开到所有 Kitty 终端，正是让这段没被实拍覆盖的路径变宽了。

## Decision

这次只落 headless 断言，多终端实拍矩阵留作后续；判定依据是「擦除是终端侧行为，与品牌无关，
`imageProtocol === "kitty"` 已是充分条件」，实拍只用来确认这个推理，不用来做门。

后续要补的范围按验收写死：

- 终端版本：Ghostty 1.3.1、Kitty（当时 latest）。xterm.js 侧走 Orca 的内嵌终端。
- 场景：全屏 alt-screen 下，图片锚点行不变、但图片覆盖的某一行被后续文本重绘。基准用例就是
  新加的那条 headless 测试所描述的情形。
- 判定：图片仍在；且重绘只触发重贴、不触发重传（`\x1b_Ga=T` 不出现）。
- 记录形式：每个终端一行「版本 / 场景 / 结果」，贴在跑矩阵的 issue 或 PR 里，不落成自动测试——
  这台机器上装不了这些终端，落成测试只会得到一堆 skip。

在矩阵补齐之前，回归防线就是上面那三条字节序断言；改动 `drawKittyImagesLast` 或
`imageCellsNeedRedraw` 时那条用例必须一起跑。

## Alternatives considered

**在 CI 里真跑 Ghostty / Kitty。** 上游就是这么验的，也是唯一能证明「图片真没消失」的路径。
否掉的原因是本仓库的 CI 跑在无 GPU、无终端模拟器的容器里：Ghostty 是 GTK4 应用，Kitty 也要
真 TTY 和像素缓冲，用 `xvfb` 拉起来只能得到「进程没崩」，截不到图，而这条 bug 的症状恰恰是
「图没了但进程正常」。付出几十行 CI 配置换来一个测不出症状的绿灯，比没有更糟。

**用 `tmux` 做中间层，在 CI 里跑 headless 的 kitty 客户端。** Kitty 支持单实例 + socket 远程
控制，理论上可以无窗口发图。实际卡在两点：容器里没有 kitty 二进制（要自己编），而且
`tmux` 本身就在能力探测链的前面（`detectCapabilitiesFromEnvironment` 先判 tmux/screen），
把场景架在 tmux 里验的是另一条分支。issue #640 原本建议的「附 tmux 手测记录」也因此只对
人在真终端里跑有意义。

**把断言升级成解析终端屏幕快照（VT 解析器回放转义序列）。** 能让 headless 测试覆盖到「图
是否还在」这一层，不必装真终端。否掉的原因是这个「在」需要终端私有的图片缓冲区模型：
Kitty 的 placement 存活规则、xterm.js addon 的擦除粒度各不相同，写一个够准的模拟器就是重写
被测对象的一半，而写不准的模拟器只会把 bug 固化成「模拟器的行为」。当前三条字节序断言已经
卡住了代码侧唯一会退化的地方（顺序、是否重传），再往上加就是在给自家 mock 做回归。

**靠上游的实拍结果背书，本仓库不再验。** 成本为零，也确实是这次改动的主要依据。但它把
「本仓库的探测链、`isWezTerm` 周边的判空、以及 alt-screen 重绘路径与上游的差异」一并托付给
了一次外部验证——本仓库这几处已经各自演进过，不能默认同构（见 #640 第 6 条对光标标记的同类
提醒）。所以记下来，而不是当作已验。

## Consequences

- 收益：门控放开这件事在三个终端家族（Kitty / Ghostty / WezTerm）里同时生效，而本仓库只对
  WezTerm 有历史实拍经验。风险被显式记账，不是被默认掉。
- 代价：`imageProtocol === "kitty"` 为真、但擦除语义与假设不符的终端（新的 Kitty 兼容实现、
  某版 xterm.js addon 的回归）出问题时，现有测试不会红。症状是「图闪一下没了」，用户报上来
  才发现。
- 代价：矩阵是人工流程，没有期限也没有自动化兜底。它只在有人愿意开两个终端手测时才前进。
- 升级触发条件：`packages/tui/src/tui-alt-screen.ts` 里与 Kitty 图片相关的判定再改动一次、
  或收到「图片在某终端上消失」的实报，就该把矩阵跑一遍并把结果贴到对应 issue。
