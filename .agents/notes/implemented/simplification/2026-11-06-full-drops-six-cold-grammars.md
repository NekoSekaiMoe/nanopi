# Agent Note: `full` 砍掉六个冷门语法高亮，base 不变

Status: implemented

## Problem

Issue #528 把 11.0 MiB 的产物按字节拆开后，语法高亮是一个反直觉的开销：
`utils/syntax-highlight.ts` 里 188 个 grammar 全是
`import("highlight.js/lib/languages/<tag>")`，运行时确实按需加载，但单文件产物
`splitting: false`、npm bundle 也会把每个动态 import 的模块收进图里，于是
**运行时的懒加载省的是堆内存，字节一份不少**。1.21 MiB 的 grammar 数据里，
六个冷门语言就占了 ~492 KiB：`1c` 156、 `mathematica` 121、 `isbl` 82、
`gml` 60、 `sqf` 45、 `maxima` 28。agent 会话几乎不读 1C:Enterprise、
Mathematica、ISBL、GameMaker、Arma SQF、Maxima 的代码块。

用户明确要求："第二个 full 把 1c、mathematica、isbl、gml、sqf、maxima 这些冷门的
看了（砍了），base 不变"。这是 issue 里 item 2 的最小落地：只动 `full`，
`base`/`minimal` 的语法高亮集合保持原样。

难点是「懒加载已经在了，怎么让字节也跟着走」。仅仅在运行时判断某个 tag 不用，
`preloadLanguage` 的 `import()` 语句还在，esbuild 照样把模块收进产物——这正是
[grammars load on demand](./2026-10-26-grammars-load-on-demand.md) 里
记过的坑：deferral 决定「何时付」，不决定「付不付」。

## Decision

`buildconfig.json` 新增 `grammars` 组件（和 `providers`/`apis` 一样是**集合名**，
不是布尔开关）与顶层 `grammarSets` 映射。`grammarSets.curated` 列出要从产物里
剔除的六个 tag。`full` 设 `"grammars": "curated"`；`base`/`minimal` 不设，
解析时回落到 `"all"`，`resolveFlavorComponents` 让它们的组件映射里
`grammars` 固定为 `"all"`，因此**注入的组件映射对 base 没有任何新增条目，
base 的字节与行为都不变**。

两端配合，缺一不可：

1. **构建期丢字节**：`scripts/build-components.mjs` 新增
   `createGrammarDropPlugin`。它用和 `createLazyImportDropPlugin` 相同的
   `onResolve` + 空 namespace 手法，把被排除的
   `highlight.js/lib/languages/<tag>` 解析成 `export default undefined` 的
   空模块，esbuild 就不会再去读那六个 grammar 文件。`preloadLanguage` 的
   switch 保持完整——它是「highlight.js 有哪些 language」的唯一注册表，
   构建期按 specifier 拦截，源码不用为某个 flavor 改。
2. **运行期收口**：`buildDefines` 注入 `NANOPI_BUILD_GRAMMARS`（被排除的
   tag 列表）到两个 bundle 脚本；`syntax-highlight.ts` 的
   `isGrammarIncluded` 读它，`supportsLanguage` 对被排除的 tag 返回
   `false`，`highlightCode` 于是走已有的「无有效语言 → 纯文本渲染」分支，
   不会去触发一个产物里根本没有的 grammar 加载。源 checkout / npm 安装没有
   define，读作「全部保留」。

`grammarSets` 校验会在加载 `buildconfig.json` 时把 `excluded` 里的每个 tag
和 `BUNDLED_LANGUAGES` 交叉核对，写错一个语言名（或拼错）直接构建失败，
而不是「以为省了其实没省」。

## Alternatives considered

- **只加运行时门控，不动构建**。最省事，但 `import()` 还在，六个 grammar
  的字节照付，`full` 一字节没小。这正是上面那个坑，否掉。
- **直接把六个 `case` 从 `syntax-highlight.ts` 删掉**。能省字节，但把
  flavor 差异写死进源码，且 `BUNDLED_LANGUAGES` 与 switch 两份注册表会漂移；
  别的 flavor 想加回某个语言要改代码而不是改配置。否掉。
- **像 item 2 原方案那样做 `all`/`common`/`none` 三档 + 构建 alias**。这是更完整
  的「语法高亮集合可配」能力，但用户这次只要砍六个冷门、且限定 `full`。先做
  `excluded` 列表这一档，避免为没要求的能力引入 alias 机制和测试矩阵；
  真要 `common`/`none` 时，`grammarSets` 这个结构可以平滑扩展。
- **把整个 `syntax-highlight` 组件从 full 关掉**。省得更多（1.21 MiB），但
  那样连 shell/TypeScript/JSON 都不着色了，是改 SKU 行为，不是裁剪。否掉。
- **连 `base` 一起砍**。用户点名「base 不变」。`base` 本就较小，且用户要
  单独看 `base` 支持多少语言（已另开 issue）。否掉。

## Consequences

- 实测（同一棵已合入 1/3/4 的 main，`NANOPI_BUILD_METAFILE_DIR` 归因）：
  `full` 单文件 `10,060,199 → 9,556,039` 字节，省 **504,160 字节 / 492 KiB**，
  与六个 grammar 的估算吻合；metafile 里 `1c`/`mathematica`/`isbl`/`gml`/
  `sqf`/`maxima` 六个 language 模块从 inputs 消失。`base`（5.8 MiB）、
  `minimal`（2.5 MiB）字节不变，`base` 产物里不出现被排除列表。
- `full` 里这六种语言的代码块渲染为纯文本（和未知语言一致），不报错；
  其余 182 个语言照常着色。`highlightCode` 的「先 `supportsLanguage` 再高亮」
  路径已经处理了这种降级。
- `grammars` 是新增的选择型组件：`loadBuildConfig` 校验集合名与
  `excluded` 内容，`resolveFlavorGrammars` 给构建脚本用。组件映射对未选集合
  的 flavor 回落 `"all"`，所以这套机制对 `base`/`minimal` 是纯增量、无回归。
- `createGrammarDropPlugin` 与 `NANOPI_BUILD_GRAMMARS` define 是成对契约：
  只动一半，要么字节没省、要么触发加载空模块。新增集合时两者由同一份
  `resolveFlavor().grammars` 喂给，改一处即可。
- 体积预算笔记 [the trimmed flavor size budget](../process/2026-10-22-trimmed-flavor-size-budget.md)
  记的「~0.45 MiB 语法高亮余量」是工作区口径；这次是在 `full` 上真正把
  grammar 字节拿掉，与那条笔记不冲突，是 item 2 的落地。
