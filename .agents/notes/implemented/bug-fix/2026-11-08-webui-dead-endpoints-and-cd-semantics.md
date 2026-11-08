# Agent Note: webui 删掉死端点，并让 `/cd` 与 `/mcp/status` 说实话

Status: implemented

## Problem

`#594` 把 webui 后端刻意留空的几处能力列了一遍，`#595` 定了怎么收：

- `/live`、`/live/mcp/trust`、`/tunnel/status`、`/fs/search`、`/model-profiles`
  都没有调用方（`packages/webui` 里搜不到），却各自回一个假答案：501
  `live_unsupported`、`{ reachable: false }`、`matches: []`、400
  `model profiles are not available`。假响应比 404 更贵——下一个读代码的人要先
  证明它真的是死的。
- `/cd` 返回成功但什么都没换：`current_dir` 报的是 `runtime.cwd`，而
  `runtime.cwd` 是进程级的，`switchSession(path, { cwdOverride })` 只改了
  `runtime.session.cwd`。于是设置页把"切换成功"显示成旧路径，
  `/project` 的 `project_hash` 也不再和真正打开的会话一致。
- `/mcp/status` 固定回 `{ servers: [], trusted: true }`。前端照这个渲染成
  「还没有 MCP 服务器」，而用户可能只是用了一个剔掉 `module/mcp-lite` 的构建，
  或者根本没配——两种情况要分开说。

## Decision

**死端点直接删**（`webui-server.ts` 的 `/live`、`/live/mcp/trust`、
`/tunnel/status`、`/fs/search`、`/model-profiles` 路由，以及静态资源正则里的
`live|tunnel|model-profiles` 前缀）。现在它们走最后的 404，和任何不存在的路径
一样。`/command` 保留：它是 `#595` 认可要做的一条，只是还没做。

**`/cd` 换的是真目录。** 新增 `replaceSessionCwd(runtime, cwd, bindSession)`：

运行时没有任何公开入口能换目录。`switchSession(file, { cwdOverride })` 让
`SessionManager.open` 落在 override 上，但运行时重建的 services 仍来自**上一个**
目录；`newSession()` 按构造时的进程 cwd 定。所以照运行时自己的做法替换：在目标
目录 `SessionManager.create(cwd)`，`teardownCurrent` → `createRuntime` →
`apply` → `finishSessionReplacement`。

两处细节是实测踩出来的：

- `SessionManager.create(cwd)` 不能带旧的 session 目录。`resolvePath` 把
  `/project/nested` 当绝对路径处理，传入旧目录会把 manager 悄悄钉回启动目录。
- **`createRuntime` 会丢掉传入的 `cwd`。** 运行时的工厂闭包里 `services` 是启动
  目录那一套，`createAgentSession` 的 `const cwd = resolvePath(options.cwd ??
  options.sessionManager?.getCwd() ?? process.cwd())` 也会让 sessionManager 赢。
  于是 DBG 实测到 `createRuntime({ cwd: 启动/nested })` 回来的仍是启动目录。

修法是在 `AgentSessionRuntime` 上开一个 hop：`setServicesHop(factory)`，
`createRuntime` 优先走它。webui 注册的 hop 就是平台自己的两步替换
（`createAgentSessionServices({ cwd: next.sessionManager.getCwd() })` +
`createAgentSessionFromServices`），只是目录由调用方挑。hop 不设时行为与之前完全
一致，CLI 走原来的工厂。

替换期间跳过模块 rebind（`setRebindSession(undefined)` + `finally` 恢复）：
`bindModules` 会带着工厂已经消费掉的 `session_start` 事件再启动一次，那次重启会用
运行时固定的 cwd 重建 cwd 相关的状态。

响应里的 `current_dir` / `project_hash` 取自 `sessionCwdOf(runtime)`（会话的
`sessionManager.getCwd()`，回退到 `runtime.cwd`）。同样的理由让 `/project`（SPA
靠它决定会话列表归属）和 `POST /sessions` 也改读会话 cwd。`/chat` 里"SPA 回声的
`working_dir`"那条分支同样改成和会话 cwd 比较，否则一次 `/cd` 之后每个 turn 都会
再切一次。

对话留在旧转录里：它是关于旧目录的，带过来会把两个项目混进一个会话。

**turn 在飞时 `/cd` 回 409**，不再在运行中的 turn 底下换目录：它的转录、工具
结果都还属于启动时的目录。

**`/mcp/status` 读 mcp-lite 的配置，不连服务器。** `mcpStatusPayload()` 先用
`isBuildComponentEnabled("module/mcp-lite")` 判构建，被剔掉就
`{ available: false, servers: [] }`；否则用 `loadMcpConfig()`（与
`mcp-lite` 模块同一个读法：`~/.nanopi/agent/mcp.json` → `.nanopi/mcp.json` →
其他客户端的发现文件）列出每个服务器，`status: "configured"` 表示"配了，本进程
没连"，stdio 命令不在 PATH 上时把 `error` 填成 `<cmd> is not on PATH`。
`trusted` 取 `settingsManager.isProjectTrusted()`，未信任的项目把自己的
`.nanopi/mcp.json` 记进 `blocked`。

不从 HTTP 处理器里真去 `connect()`：那会给设置页每次渲染拉起一堆进程，而且没有
人等着它们。设置页新增 `available === false` 分支，写「此构建不含 MCP」而不是
「还没有 MCP 服务器」。

## Alternatives considered

**让 `/cd` 真的挪 `runtime.cwd`。** `cwd` 是构造时定的（`cwd = services.cwd`），
`AgentSession`、工具定义、`DefaultResourceLoader` 全在构造时绑定它，重新赋值这个
字段只会让 cwd 相关状态自相矛盾。要么按上面的方式重建 services，要么什么都不做。

**只改 `runtime.cwd` 的赋值，不做替换。** 同上：`AgentSession` 里的 `_cwd`、工具
definitions、`SessionManager` 都还是旧的，表面上换了目录，实际工具仍在旧目录跑。

**`/cd` 只改会话文件里的 header，不重新打开会话。** 会话在没有 `session_start`
的情况下换目录，`mcp-lite`、skills 这些在 `session_start` 里读 cwd 的模块都还
停在旧目录。

**`/mcp/status` 连一次服务器拿真实状态。** 见上：HTTP 处理器没有生命周期，连接
没人关；而且 mcp-lite 的 MCP 工具本来就是 subagent-only，主会话的"状态"只有
"配了什么"这一层。

**保留 `/live` 的 501 提示"这个传输没实现"。** `#595` 的结论是删：没有调用方，
提示本身就要求读代码的人先相信没有客户端会来问。

## Consequences

- 收益：`/cd` 之后设置页、终端（默认目录的那条）、`/project`、`/chat` 的
  `working_dir`、以及真正跑工具的那个 session 指向同一个目录；`/cd` 在 turn 运行
  中会明说 409，而不是留下一个"成功但没换"的状态。
- 代价：`AgentSessionRuntime` 多了一个 `setServicesHop` 钩子。它和
  `setRebindSession` 同类（宿主替换会话时要用），默认不设，CLI 路径不变。
- 代价：`webui-server.ts` 通过 `as unknown as` 形状访问运行时的 `teardownCurrent` /
  `createRuntime` / `apply` / `finishSessionReplacement`。这四个是运行时的私有实现，
  上游改签名时 webui 会在运行时先看到，而不是编译期。回归测试
  （`test/webui-cd-and-mcp-status.test.ts`）就是为此存在的。
- 收益：剔掉 `module/mcp-lite` 的构建在设置页明确显示"不含 MCP"，而不是让用户
  以为自己没配。
- 代价：`/mcp/status` 报的是配置不是连接，`status: "configured"` 这个值是新加的
  词，前端要认它（现在按非 connected 渲染成灰点，符合"配了没连"）。
- 代价：webui 与其他 AtomCode 客户端（如果将来有）在 `/live`、
  `/model-profiles` 上不再兼容；`#595` 已确认这条不做。
- `GET /project` 的 `working_dir` 现在是会话 cwd。SPA 在 `/cd` 之后靠它重排会话
  列表，之前拿到的是启动目录。
