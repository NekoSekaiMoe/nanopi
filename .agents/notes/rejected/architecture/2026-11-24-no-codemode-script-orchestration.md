# Agent Note: 不把 nanopi 的 mcp shell 演进成 CodeMode 脚本编排层

Status: rejected — 用户拍板先否决整套 CodeMode / fork 脚本改造：四层契约工程量大，当前 `mcp` shell 的进程隔离已够用，维持现状。见 ISSUE #801。

> **已被部分取代（2026-11-24，ISSUE #803）**：本篇否决的是脚本运行时与四层契约；用户随后明确只要一个 hidden module 用 `pi.registerTool` + `ctx.executeTool()` 做批量编排，不要新引擎。批量工具已落地，见[用隐藏内置模块把多次工具往返压成一次](../../implemented/feature/2026-11-24-hidden-batch-tool-module.md)。脚本运行时、`vm`/QuickJS、四层契约的否决仍然有效。

## Problem

ISSUE #801 从 #799 的讨论延伸，想弄清楚「nanopi 的 MCP 要往 CodeMode 走，具体怎么改」。当时的 `mcp` shell（[MCP discovery 与 mcp 壳工具](../../implemented/architecture/2026-10-21-mcp-discovery-and-wrapper-tool.md)）是上下文隔离的搬运工：主会话调 `mcp(server, tool, args)`，每次 spawn 一个 subagent 跑真正的 `mcp__*` 工具，外部 payload 不进主 transcript。代价是每次调用约 1 秒启动、无法在一段脚本里编排多次工具调用。

讨论中一度把差距拆成四层契约：tool exposure 分级（`ToolExposure` 只有 `direct | model-only | hidden`，缺「仅脚本可见」的一档）、`structuredContent` 直通、脚本内发现与编排、嵌套调用的权限与审计。要是逐层补齐，就是一次跨包改造，而不是加一个 JS 工具那么简单。

## Proposal

否决这四层改造，不为 MCP 引入新的脚本运行时，也不改 `mcp` shell 的现状。需要多步编排时，模型仍按今天的路径多次调用 `mcp`，或直接用 `subagent` 在一次委派里点名需要的 `mcp__*` 工具。

### 执行环境选型一路收敛到「fork 真 node」

选型经过三轮，最终没有一种值得为它启动四层契约：

1. 照搬 Pi 的 QuickJS/WASM 沙箱——不成立。仓库在 `7acaea0c9` 已删掉整个 codemode/mcp 包，没有任何 QuickJS 依赖；nanopi 自身跑在 Node >= 24 上。
2. 用 Node `vm` 做受控 context——也不成立。`vm` 不是安全沙箱，同进程一个死循环就卡死整个 agent；为了「可信编排脚本」去模拟模块系统不值。
3. `fork` 一个真 `.mjs` 子进程 + IPC 工具代理——最接近正常 Node 脚本：脚本进程用 `process.send({type:'call', ...})` 调工具，宿主跑 `ctx.executeTool()` 后回结果，`Promise.all` 天然并发。但它只解决「脚本怎么跑」，tool exposure、`structuredContent`、权限审计一层都没少，为了把约 1 秒的 spawn 从每次调用挪到每段脚本，要跨包改四层契约，收益与成本不匹配。

### 四层契约里写着、却没有实现的部分

`packages/coding-agent/src/core/modules/types.ts` 里 `ToolExposure` 的实际取值只有 `direct | model-only | hidden`；同一文件的 `setActiveTools` 注释却提到 `codemode`/`deferred` 的 tool 无论 active 与否都能被脚本调用。这是 codemode 包删除后留下的注释残留，不是现存的可用能力。把它当成「地基已经有一半」会低估工作量：脚本可见分级、`structuredContent` 交接、权限继承都要从头写并测试。

## Alternatives considered

### 维持现状，把「这是隔离不是 CodeMode」说清楚

最强理由：零改动、零风险，`mcp` shell 的进程隔离正是它存在的目的；外部 payload 不进主 transcript 这条保证已经在 [MCP discovery 与 mcp 壳工具](../../implemented/architecture/2026-10-21-mcp-discovery-and-wrapper-tool.md) 里钉住。多步编排用多次 `mcp` 调用或一次点名多个工具的 `subagent` 也能做，只是没法在一个脚本里留中间状态。这也是本次采纳的路。

### 只做极简版 `fork` 脚本工具，不做四层契约

最强理由：绕开大部分工程量，一个最小 `script` tool 就能让模型一次写多步编排。否决理由：只要脚本能调工具，就立刻碰到「哪些工具对脚本可见」「结果以什么形状回传」「权限怎么继承」——正是要跳过的四层契约。所谓极简版只是把问题推迟到第一个真实用例，不是省掉它。

### 保留 `mcp` shell，另加一条 `codemode` 路径并存

最强理由：不动现有行为，给想要编排的用户多一个选择。否决理由：两套工具暴露规则、两套结果形状会让心智模型更乱；`ToolExposure` 注释残留已经说明「留着描述不落地的概念」会误导后续改动。要并存就得先把四层契约做实，又回到全量成本。

## Consequences

- `mcp` shell 保持「一次调用一次 spawn、主会话只看文本且截断 8000 字符」的现状，MCP 工具继续是 subagent-only。多步任务靠多次调用或 `subagent` 直接编排。
- 成本是用户得不到脚本内的中间状态留存与并发编排：每次编排决策都要回主模型，约 1 秒/次的 spawn 开销仍在。
- 收益是零跨包改动、零新运行时。进程隔离的边界继续成立：外部 MCP payload 不进主 transcript，权限与 `nestedCalls` 审计走现有的 `ctx.executeTool()` 路径。
- 如果将来重开这个方向，真正要写的是四层契约，不是沙箱选型；选型在 `fork` / `vm` / QuickJS 之间已有本 Note 的结论可复用。届时这里记录的「维持现状」即被取代，需新开一篇接管。
