# Agent Note: guard 开关带来源，静默降级改成显式确认

Status: implemented

## Problem

`gitGuard`/`shellGuard` 的生效值由两个文件深合并得出（`settings-store.ts` 里
项目层直接覆盖全局层），扩展在每个 session 起点读一次进内存。合并本身没问题，
问题是**合并的过程用户看不见**：

- 全局 `/gitguard on` 之后，项目 `.nanopi/extra/settings.json` 里那行
  `"gitGuard": false` 会把它顶掉，session 开局就是 off，连一条通知都没有。
- `/gitguard off` 只写全局文件，读的却是合并值，所以「我全局关的」和「实际生效的」
  可以长期不一致，且下一次 session 静默翻回去。

安全开关的 off 不该被另一层静默无视，用户也不能对着一个 off 猜是自己关的还是
项目里躺着一行。

## Decision

一个东西，三个视图。`effective = {value, source: global|project|session}`，
`source` 一路带到裸敲输出（`Git guard: off (project)`）、session 起点确认、
以及写侧提示。四个静默点（读覆盖、写错层、webui 隐形写入、session 档过期）都
是它的视图，不另起机制。

- **读**：`resolveGuardSwitch(cwd, key)` 逐层读原始值，保留「键不存在」和
  「显式 false」的区别。`loadExtraSettings` 仍是其余键的合并视图，不动。
- **确认**：只有「项目层显式 false、全局层不是 false」才弹，三选项 ——
  本次保持 off / 用全局值并修掉项目文件 / 阻止 shell 与 git 调用直到改配置。
  无 UI 的会话（print、json、subagent）取保守档（on）并打 warning，不改任何文件。
- **写**：`/gitguard on|off [global|project|session]`。裸敲只显示不切档。
  省略档位写「当前生效层」；`session` 只在内存，且**活过 reload**。
- **A3**：`explain` 之后那条 prompt 上的 `allow_session` 按 `allow_once` 处理。

## Alternatives considered

- **只做写侧三档**：修了写没修读，项目文件里那行照样静默生效，只是换了个入口。
  四档确认点本来就是同一条因果链，拆开做等于留三个同款坑。
- **生效值改成 `全局 OR 项目`**：默认是 on，OR 会让项目层永远无法关掉全局 ——
  造出「关不掉的开关」，比静默更糟。
- **headless 静默放行项目值**：没人能回答的弹窗不等于同意。取保守档并写日志，
  是唯一不假装用户表过态的做法。
- **`explain` 场景改文案而非语义**：webui 卡片上「本次会话允许 / 只允许这一次」
  两个按钮文案本来就分开了，问题在语义不在措辞，改字不动行为。
- **`session` 档 reload 时重置**：`gitGuardState` 在 `session_start` 整段重读，
  reload 也走这条，会话内的答案会被静默丢掉。改成「已答复过就保留」，
  否则一次扩展 reload 就变成一次重复盘问。

## Consequences

每个 session 起点多读两个 JSON（无确认时不弹窗，只多两次 `readFileSync`）。
确认弹窗只在项目层真的顶着全局值时出现，devcontainer 那类把 guard 关掉的项目
会看到一次；接受后本 session 不再问。

## 验证

`packages/extra/test/guard-switch.test.ts` 驱动真实 extension factory（假 API）断言三个视图：
裸敲带来源、项目层写入只落项目文件、`session` 档不落盘且活过 reload、
三选项各自的结果、headless 取保守档。`packages/extra/test/settings-store.test.ts` 单独断言
逐层读取与 `null` 删键。`packages/extra/test/permissions.test.ts` 断言 explain 后的
`allow_session` 不再进白名单，而普通 prompt 仍然会。

冒烟阶段抓到三个实现缺陷，都在这些用例里固定下来：默认层被误判成 project、
accept 答案写成了 on、`describeGuard` 把 session 覆盖和层值重复了一遍。
