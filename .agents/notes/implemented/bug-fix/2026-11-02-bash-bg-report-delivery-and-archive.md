# Agent Note: bash_bg 的完成报告与作业归档

Status: implemented

## Problem

两条缺口都在同一个地方：后台作业的唯一出口是「一条 custom message」和「一个进程组」。

**报告会丢。** `notifyComplete` 走的是 `pi.sendMessage(..., { triggerTurn: true })`。
`sendCustomMessage` 在 `isStreaming === false && triggerTurn` 时直接 `_startRun`，而
`agent_settled` 到 `prompt()` 真正 resolve 之间还有一段时间 `isStreaming` 已经是 false、
上一轮却还在收尾。这段窗口里启动的第二轮会被 `agent.prompt()` 拒掉，抛出的 rejection
被 `.catch` 吞掉——作业跑完了，通知没了。subagent 的同一处已经改用
`deliverMessage`（`packages/coding-agent/test/suite/regressions/subagent-report-delivery.test.ts`），
`bash_bg` 是同一条路上的另一个出口。

**「停写者、留服务」没有落脚点。** `npm run dev` 这类命令的 shell 会退出（job 变
`completed`，exit 0），它派生的 server 还占着端口。`jobIsActive` 已经认这个状态
（`jobOwnsLiveProcessGroup`），但注册表只活在内存里：

- 作业表随进程消失，重启后既没有 jobId，也没有日志路径；
- `pruneCompletedJobs` 淘汰作业时无条件 `rmSync` 日志，存活服务的唯一线索被删掉；
- `session_shutdown` 把 `baseDir` 整个删掉。

于是「写者停了、服务还在」这件事在会话结束后完全不可寻址。

## Decision

**报告走 `deliverMessage({ startTurn: true })`。** 它返回 `"started" | "queued" |
"pending"`，报告只有一条出口，落地方式必须可观测：`started` 表示这一轮是本次调用起的，
`queued` 表示进行中的一轮会带上它，`pending` 表示它等在 transcript 里等下一个 prompt。
结果写进归档记录的 `delivered` 字段；投递失败则把原因记在 `job.reportFailure` 上，由
`status` / `wait` 的尾巴里显示成 `completion report: not delivered (...)`——不吞。

**作业归档成 `bash-bg-job` 会话条目**（`BASH_BG_ARCHIVE_TYPE`，`version: 1`）。
append-only，同一个 id 的最新一条胜出。字段是恢复路径真正会 dereference 的那些：

- `logPath` / `logBytes` / `logDeleted`
- `serviceAlive`：写记录那一刻进程组是否还活着
- `delivered`
- `status` / `exitCode` / `startedAt` / `finishedAt`

三处写入点：`startJob`（作业出现）、`markDone`（shell 退出，`exit 0` 但进程组还在的状态
第一次存在的那一刻）、`finalizeOutput`；`pruneCompletedJobs` 与 `session_shutdown` 各写
一次终态。

**日志的存活规则跟着进程组走。** 淘汰或关停时，只有进程组还活着的作业保留自己的日志
文件（关停路径先把它 rename 到一边，删完 `baseDir` 再放回去），其余照旧删除。归档记录
同时写 `logDeleted`，恢复出来的 `status` 直接显示 `log: <path>`，不必等 `tail` 被截断。

**恢复是白名单的。** `parseArchiveEntry` 先校验 `version`，再逐一校验 `id` / `command` /
`cwd` / `pid` / `status` / `startedAt` / `exitCode` / `logPath`；`entry.data` 来自会话
文件，是外部输入。恢复出来的作业 `done: true`、`child: undefined`、`outputFinalized: true`，
按 `startedAt` 取最近 `MAX_RESTORED_JOBS` 条。

恢复出来的作业仍然可以被 `kill`：`jobOwnsLiveProcessGroup` 只看 pid 的进程组，进程组
还在就照常 `signalProcessTree(undefined, pid, ...)`——这是「重启之后仍然停得掉那个服务」
的一半。另一半（重启后重新接管输出）不做，日志文件是既成事实。

## Alternatives considered

- **`sendMessage` + `{ triggerTurn: true, deliverAs: "followUp" }`**。`deliverAs` 只在
  `isStreaming` 为真时生效；收尾窗口里 `isStreaming` 已经是 false，仍然落进
  `_startRun`，同一个 bug 换个写法。`deliverMessage` 判断的是
  `isStreaming || _isRunStarting()`，多认了「run 正在启动」这一档。
- **只修 `notifyComplete`，不做归档。** 「停写者、留服务」依然没有落脚点：日志路径
  只存在于内存，重启即失。
- **把归档放在 `~/.nanopi` 下的独立 JSON**。会话已经有一个 append-only 的档案通道
  （`pi.appendEntry`），会话文件本身就是「这次会话发生过什么」的事实来源；再开一个
  平行存储要自己解决并发、清理和 resume 语义。
- **归档里存 `outputTail`**，重启后照旧显示尾巴。日志本身最大 16MB，`tail` 缓冲 64KB，
  两者都随作业线性增长；会话条目是会被 compaction 反复读取的，存状态而不是存输出。
- **恢复时直接 `tail -f` 接管日志**。跨进程的文件 tail 要额外的 watcher 生命周期，
  而目的只是「找得到、停得掉」。

## Consequences

- 报告不再因为收尾窗口丢失；投递失败在 `status` 里可见，而不是只剩一条沉默的作业。
- 重启后 `list` / `status` / `kill` 仍然认得那些作业，日志路径可见、可 `tail`，
  进程组还能被终止。代价是会话文件多出每个作业几条小条目（append-only，最新胜出）。
- 归档条目的 schema 是硬契约：`BASH_BG_ARCHIVE_VERSION` 变一次，旧条目全部被跳过，
  与 subagent 的 `ARCHIVE_VERSION` 同一套规则（先校验 version，再读字段）。
- `MAX_RESTORED_JOBS` 与 `MAX_RETAINED_COMPLETED_JOBS` 同为 64：归档是 append-only
  的，恢复侧必须有上限，否则长会话的每次启动都要回放全部历史。

## Verification

`packages/coding-agent/test/suite/regressions/bash-bg-delivery-and-archive.test.ts`：

- 空闲时完成的作业，报告经 `deliverMessage` 落地，归档记录里 `delivered === "started"`；
- `action=run` 完成的作业被归档，`logDeleted === false` 且日志文件里有输出；
- 归档记录（含 `serviceAlive: true`）恢复后出现在 `list`，`status` 给出日志路径；
- 非对象 / 更高 version / 缺字段的记录被跳过，恢复不炸，`list` 干净；
- 日志已丢失的记录仍然保留（`logDeleted: true`），不是藏起来。

`pnpm run check` 与 `node ./test.mjs` 全绿。
