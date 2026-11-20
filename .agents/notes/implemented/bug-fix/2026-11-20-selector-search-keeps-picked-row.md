# Agent Note: 搜索框里的光标移动不再重置选择器选中项

Status: implemented

## Problem

`/login`、`/logout`、`/resume` 和设置面板的搜索框共用一个输入模型：可打印字符改 query，方向键移动输入框光标。问题在于组件把「任意输入事件」都当成「query 变了」，于是 `handleInput` 后无条件重新过滤并把 `selectedIndex` 归零。

一个可复现的序列是：先按 ↓ 选到第二个 provider，再输入 `openai`，回车落到旧行号对应的 provider；或者输入 `o` 后按 ↓，再按 ← 挪一下光标，选中项立刻跳回第一行。这不是 fuzzy filter 的排序问题，而是「query 未变却重跑过滤」造成的选中态丢失。

## Decision

过滤函数的入口仍然保持「有 query 就把最佳匹配放在第 0 行，清掉 query 就 clamp 旧位置」的契约；变化发生在调用侧：只有 `Input.getValue()` 前后不同才重跑过滤。

- `OAuthSelectorComponent`、`ModelSelectorComponent`、`ThinkingSelectorComponent`、`ScopedModelsSelectorComponent`、`SettingsList` 和 `SessionSelectorComponent` 在 `handleInput` 里先记录旧 query，再交给输入框，只有值变化才调用对应的 filter/refresh。
- 方向键、左右光标、删除键这些不改变查询内容的按键只更新输入框状态，不再重建候选列表。
- session selector 额外只在非空 trimmed query 时把选中项归零，保留 threaded/tree 视图和异步加载期间的旧选择逻辑。

## Alternatives considered

- **过滤函数里保留旧选中项**：例如按 id 找回上一次选中的 provider。失败时仍然要有回退规则，且「输入新词后选最佳匹配」会被破坏；状态找回应该属于调用时机，不属于过滤本身。
- **在输入框层拦截方向键**：能让这几个组件不复过滤，但方向键绑定由 TUI 统一管理，组件内另起一套会把 keybinding 配置割裂成两套事实来源。
- **全部改成 SelectList**：足以覆盖 thinking 和 settings，但 oauth/model/session 各自有状态标签、scope、异步加载等定制渲染，迁移成本远大于这次的选中态修复。

## Consequences

- 输入新 query 仍然落到 best match；方向键或光标移动不再抢走用户刚选中的行。
- `packages/coding-agent/test/oauth-selector.test.ts`、`packages/coding-agent/test/model-selector.test.ts`、`packages/coding-agent/test/thinking-selector.test.ts`、`packages/coding-agent/test/scoped-models-selector.test.ts` 和 `packages/tui/test/settings-list.test.ts` 增加回归用例，覆盖 best-match 重置与 unchanged-query 保持两条路径。
