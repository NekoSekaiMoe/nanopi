# Agent Note: 按请求固化定价快照，让历史开销可审计

Status: implemented

## Problem

ISSUE #803 对比 Maka 的 `Quote` 后发现：nanopi 的 `usage.cost` 在响应落盘时就算好，
跨会话汇总不会因改目录而重算——但账上只留了 dollar 数字，没留当时的 provider、model
和费率。用户在 `models.json` 里 upsert 单价、或一次构建重生成 `models.generated.ts`
之后，一条 `$1.23` 的历史记录无法回答「当时是按哪个价算的」，也不能按价格版本分组。

沙箱侧同一个 issue 还暴露两处语义缺口：无人值守会话在 launcher 缺失时只发一条没人看的
通知就本地执行；`SECURITY.md` 没写清 MCP server 不在 shell sandbox 内、Windows 无后端。

## Decision

`Usage` 上加可选 `pricing: UsagePricing`，由 `calculateCost()` 在算价时同步写入：

```
UsagePricing = { provider, model, revision, rates }
```

- `provider` / `model` 取算价用的 `AnyModel`，所以 Anthropic server-side fallback 走
  `usageModel` 时记的是实际计费模型，不是请求的那个。
- `rates` 是当时命中的完整 `ModelCost`（含 `tiers`）深拷贝；目录对象后来被改，不影响快照。
- `revision` 是 `provider + model + rates` 的确定性哈希。费率任意一项改动都会产生新
  revision，不依赖构建产物或外部目录的版本号。
- 快照挂在 `usage.pricing` 而不是替换 `usage.cost`：provider 直报账单价的路径不改，
  历史 JSONL 没有这个字段也照常读。
- `combineUsage()` 保留第一份快照：合并发生在一次「按基响应价格计费」的折叠里，保留
  一个可解释的价，而不是丢弃或伪造一个混合价。

沙箱侧：`sandboxIsUnattended(mode, hasUI)` 判定无 UI 的 `print` / `json` / `rpc` 会话。
配置沙箱但 launcher 不可用时，交互会话保持本地执行并警告；无人值守会话注册一个必失败的
`BashOperations`，每条 shell 调用报 `sandbox unavailable` 并以非 0 退出。
`SECURITY.md` 新增 `Shell sandbox boundary`，写明只约束 `bash` / `powershell`、
MCP server 与扩展/skill 在边界外、Windows 无后端。

## Alternatives considered

**用构建产物或 models.dev 的版本号当 revision。** 最强理由：目录有现成的
`.manifest.json` / `generatedAt`，不用自己定义哈希。否决理由：用户 upsert 价格发生在
运行时，不触碰 manifest；而且目录来自 models.dev + OpenRouter + 本地覆盖三处，没有单一
可信版本。按实际费率哈希才能覆盖所有改价路径。

**把快照塞进 `usage.cost`。** 最强理由：字段就在花钱的地方，消费方不用改。否决理由：
`cost` 的形状被 webui、TUI、导出、测试等多处直接读取（例如 `usage.cost.total`）；
改它的结构会污染这些路径，也会让 provider 直报账单价的路径被迫携带估算元数据。

**无人值守也只发通知。** 最强理由：与交互会话行为一致，实现简单。否决理由：无人值守
场景没有可读通知的终端，`--output json` 下通知是 no-op；用户配了沙箱却拿到裸跑，正是
Maka 明确拒绝的静默降级。失败要落在命令结果里。

## Consequences

- 每个计费响应多写一个小对象（四个费率 + tiers + 26 位左右 hash）；会话 JSONL 略增大，
  换来不重算的历史价。`cache_warm` 这类 `appendUsage` 复用已有 `usage`，也会带上它的快照。
- `revision` 是费率哈希，不是目录修订号：两次目录升级若费率未变，revision 也相同。这符合
  审计目的——关心的是价格，不是抓取时间。
- `/status` 的「cost 是历史价」现在可下钻，但这版没有在 UI 上展示 revision；字段先落盘，
  展示留给后续按 `(model, revision)` 分组的需求。
- 无人值守 fail-closed 只覆盖通过 `BashOperations` 的 shell 工具；直接调用扩展自己的
  subprocess 不在范围内，边界写进 `SECURITY.md`。
