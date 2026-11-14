# Agent Note: 会话写入失败不再污染内存，读取失败不再静默消失

Status: implemented

## Problem

会话的持久化和发现各有一条"失败就当没发生"的路径，形状不同，后果都是用户看不到真相。

**写入**（`SessionManager._appendEntry`）：先把 entry 推进 `fileEntries`、推进 `leafId`，再
`_persist(entry)`。目录被删掉、盘写满时 `_persist` 抛错，但内存已经往前走了一步：agent 继续在一条
**从没落盘的** entry 上往下长，用户重开会话看到的消息比模型以为自己发过的少。同类的
`appendCompaction` 在 `!flushed` 分支里也是先 push 再 persist。

**读取**（`SessionManager.list` / `listAll` / `listSessionsFromDir`）：坏文件 `catch` 后 `return null`，
直接从列表里消失；目录读不动时 `catch` 后 `return []`，和"这里确实没有会话"长得一模一样。
用户看到的是"我的会话没了"，而不是"有一个文件读不了，因为第 4 行 JSON 是坏的"。

## Decision

三条不变量：

1. **先落盘，再提交内存。** `_persist` 先于 `fileEntries.push` 与 `leafId` 推进。`_persist` 的
   `!flushed` 分支此时还看不到 `entry` 自己，所以它显式把 `[...this.fileEntries, entry]` 写进新文件，
   并用模块级 `isConversationEntry` 判断"这条是不是对话"——原先靠 `fileEntries` 里已经有对话来判断，
   顺序调换之后那道判断会漏掉第一个 user 消息（#10000 的回归）。
2. **加载进来的数组要复制。** `_loadEntries` 现在 `entries.slice()`。调用方（测试 fixture、
   preloaded entries）持有自己的数组，append 不该在它背后把它撑大。
3. **读不动就说，不假装为空。** `SessionListProgress` 多一个可选参数
   `errors?: readonly SessionDiscoveryError[]`；坏文件通过 `onError` 回调汇总，目录读失败直接
   `throw`（`AbortError` 照旧优先）。选择器用头部一行"N session file(s) could not be read"加列表
   底部逐条路径+原因展示，两处都不再需要用户去猜。

## Alternatives considered

**写入失败时回滚内存（catch 里 pop 掉 entry）。** 要点在于 `_persist` 一部分成功：`!flushed` 分支
里 `openSync(..., "wx")` 建了文件、写了几行才失败，回滚内存会留下一个内存里没有、磁盘上残缺的文件，
比现在更难解释。把顺序反过来没有"部分成功"这个状态——抛错就是什么都没发生。

**目录读失败继续 `return []`，只把错误挂在 progress 上。** 调用方（`/resume`、`/import`、webui）
靠 `[]` 区分不了"空"和"读不了"，而这个区分恰恰是这次要给的。选择器现在捕获这个 reject 并显示目录名
与系统错误码，比一行"没有会话"更有用。

**把 `SessionDiscoveryError` 换成一条格式化好的字符串。** 列表底部要按行折行、要能只显示路径或只显示
原因，结构化的 `{ path, message }` 让渲染层自己决定，也让测试能断言对象而不是去 match 文本。

## Consequences

收益：写入失败的会话不会再出现"模型记得、磁盘不记得"的分叉；坏会话文件与坏目录都会在 UI 上留下一句
可行动的话。

代价：

- append 抛错现在会传回调用方。上层本来就有 try/catch 的地方（交互式的消息落盘）行为不变，
  但这是行为变化，不是纯重构。
- 一次 `limit` 读不再统计文件总行数（见同期 `read` 的改动），提示语从
  "N more lines in file" 变成 "Stopped after N line(s) at the requested limit"。
- `SessionManager.listAll` 对不可读的 sessions 根目录改为 reject，与 `list` 一致。

回归测试：`packages/coding-agent/test/session-manager/file-operations.test.ts` 新增四条——
写入失败后 `getEntries()` 与 `getLeafId()` 不变、加载的数组不被撑大、坏文件被报告为
`{ path, message }`、不可读目录 reject。
