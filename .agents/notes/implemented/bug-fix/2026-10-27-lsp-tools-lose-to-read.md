# Agent Note: LSP 工具要跟 `read` 竞争，不是跟 `grep` 竞争

Status: implemented

## Problem

`pi-lsp-mini` 的六个工具在正常模式下几乎不被调用，模型宁愿 `read` 整个文件去
回答"这个函数的签名是什么"。生产环境观察到的行为，不是猜测。

前两篇笔记把这件事当成"文案效率问题"处理过：`lsp-query-merge` 删掉了
description 里的效率论证（认为"有 read 和 LSP 摆在面前时，省一步对模型是显
而易见的"），`lsp-hover-definition` 则给 hover/definition 加了 `symbol` 参数，
理由是"模型知道名字不知道列号，逼它找列号等于把它赶回去读文件"。

两次都判断对了机制，没判断对竞争对象。系统提示里 `lsp_` 一侧的规则只有一条：

```
- lsp_ tools answer from the language server, ... Reach for them before
  grepping for text that a compiler resolves better: ...
```

而 `read` 一侧是：

```
- Use read to examine files instead of cat or sed.
```

`read` 那条规则没有对手 —— 它只跟 `cat`/`sed` 比，而 LSP 那条只跟 `grep`
比。模型要回答"这个符号是什么"，脑子里根本没有 `grep`，它要的是"看代码"，
而全prompt里唯一被点名"用来看代码"的工具就是 `read`。LSP 的规则在跟一个模
型没打算用的工具竞争，于是它从未被考虑过。

一条规则如果只否掉 A 而不同时说清"那 B 呢"，而 B 才是默认路径，模型就走 B。

## Decision

改规则本身，让 `lsp_` 跟 `read` 正面竞争：

- **`LSP_GUIDANCE` 以 `read` 为对手写**，句式是"在打开文件之前"而不是"在
  grep 之前"：
  `Before opening a file to answer what a symbol is or where it comes from, use
  the lsp_ tool for that question: hover for a signature or doc, definition for
  where it is declared, query for usages or callers, diagnostics for errors.`
  后半句交代了为什么可以不打这个文件（服务端已经解析过 import 和类型）。
- **每个工具有一条自己的规则**，说的是它参数才允许的场景，不复述共享那条：
  hover/definition 的 `symbol` 参数（知道名字不必先定位行号）、query 用在
  rename/改签名/删除之前、diagnostics 在编辑后不用构建。
- **`promptSnippet` 不再写"省一步"**（"without reading the file"），改写成问
  句："What a symbol's signature/doc is, by name or position"。原来的写法把这
  个工具定位成一个可选的优化技巧，而 `read` 的 snippet 是干巴巴的 "Read file
  contents" —— 在模型眼里前者像捷径，后者像正事。
- **六个工具统一从 `schemas.ts` 取 `promptGuidelines`**，注册处不再硬编码
  `[LSP_GUIDANCE]`，这样"何时用"和参数语义待在同一份声明里。`buildRules`
  对重复规则去重，所以共享那条在渲染后的 `<rules>` 里只出现一次。

## Consequences

`<rules>` 里 lsp 相关的规则从 1 条（约 460 字符）变成 5 条（807 字符），加
上 `<tools>` 的 468 字符，六个工具的 prompt 总量从 3277 字符（约 820 tokens）
涨到 4543 字符（约 1140 tokens）。多出的约 320 tokens 是每请求都付的代价，买
的是工具真的会被选。

代价里有一条要盯住：规则变长会稀释后面的规则。这 5 条都放在 `<rules>`
里且每条都指向具体工具，没有一条只是"LSP 很好"。如果之后有人想再加一条解
释 LSP 原理的规则，先删掉一条旧的再说。

测试上新增两条断言：`LSP_GUIDANCE` 必须以 "before opening a file" 开头（防
止又被改回"只跟 grep 比"），以及每个工具的 guideline 列表非空、无重复且都含
共享那条。

## Alternatives considered

**只改 `read` 的规则，让它承认 LSP 的存在**（例如 "use read for a file's
body; the lsp_ tools answer questions about symbols"）。更对称，也不用给每
个工具加规则。否掉是因为 `read` 是内置核心工具，它的 guideline 被所有构建
共用，为一个可选模块的存在改它，等于让核心工具替扩展背书；而扩展在运行时
可以整个消失（subsystem 开关），此时 `read` 的规则就会指向不存在的工具。
放在扩展自己的声明里，工具没了规则也一起没了。

**恢复 description 里的效率论证**（"costs less than reading the file"）。
`lsp-query-merge` 否掉它的理由是重复付费且信息冗余。这个判断仍然成立：模型不
是不信 LSP 更省，是压根没想到 LSP。论证省钱解决不了"没被想起"，指出场景
才行。

**把提示塞进 system prompt 的固定段落**（而不是挂在工具声明上）。那样就不
用为六个工具各存一份。否掉：`pi-lsp-mini` 是一个可在运行时被关掉的模块，
固定段落无法随模块消失而收回，会留下指向不存在工具的规则。

**调大 `promptSnippet` 而不加 `promptGuidelines`**。snippet 只进 `<tools>`
列表，是"这个工具是干什么的"；它不出现在 `<rules>` 里，而 `<rules>` 才是
模型读取舍的地方。`read` 的竞争规则就在 `<rules>`。

## Verification

- `packages/coding-agent/test/lsp-query.test.ts` 的两条新断言固定了措辞方向，
  防止回退到"只跟 grep 比"。
- `pnpm run check` 通过；`lsp-query`、`lsp-hover-definition`、
  `lsp-read-diagnostics`、`lsp-edit-diagnostics` 共 29 个测试通过；
  `packages/extra/test/plan-mode-policy.test.ts` 5 个通过（计划模式的白名单未
  改动）。
- 真实效果取决于模型，测试只能保证规则被渲染出来。要看结果，起一个会话问
  "`X` 这个函数签名是什么"，看首轮调用的是 `lsp_hover` 还是 `read`。
