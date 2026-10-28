# Agent Note: 预设提示词走 `--preset` 与 `PRESET_PROMPTS.md`

Status: implemented

## Problem

提示词的三个入口都不适合"多份可选"：`SYSTEM.md` 只有一份且替换基座，`APPEND_SYSTEM.md` 也只有一份，命令行只能用 `--append-system-prompt <text>` 现打现传。想在项目里存几份可切换的提示词，只能来回改同一个文件，或者把长文本塞进命令行。

## Decision

新增 preset 通道，语义是"追加一段"而不是"换掉整段"：

- `--preset <file>` 加载该文件；`--preset <name>` 依次找 `.nanopi/presets/<name>.md`、`<agent-dir>/presets/<name>.md`。
- 没有 `--preset` 时，受信任项目的 `.nanopi/PRESET_PROMPTS.md` 生效，其次 `<agent-dir>/PRESET_PROMPTS.md`；显式 `--preset` 覆盖两者。
- preset 内容排在 `--append-system-prompt` 之前，落在 `<addendum>` 段，因此单次追加可以修正 preset 而不必改文件。
- 名字没匹配到任何文件时只打印告警并跳过，不把名字当字面文本注入 —— `--append-system-prompt` 的"存在即读文件、否则当文本"规则对 preset 不适用。

实现集中在 `DefaultResourceLoader`：`resolvePresetSource()` 做路径/名字解析，`discoverPresetFile()` 做约定文件发现，两者在 `load()` 里合并进 `appendSystemPrompt` 数组。

## Alternatives considered

### Why not 替换基座（`customPrompt`）？

`SYSTEM.md` 已经是替换通道，且替换会在 `buildSystemPromptSections` 里跳过 `tools`/`rules`/`docs` 三个 section。把 preset 也做成替换，等于给用户一个悄悄丢掉工具清单和规则的开关，不如保留一条干净的追加通道。

### Why not 只做 `--preset`，不做约定文件？

约定文件让"这个项目默认用哪份提示词"随仓库走，不需要每个人记住参数。代价是多一个隐式加载点，因此它跟 `SYSTEM.md` 一样要求项目受信任，并在文档里写清优先级。

### Why not 放进 `settings.json`？

设置层面向偏好，改完还要重启；preset 是随会话选择的提示词来源，和 `appendSystemPrompt` 同一条链更自然。

## Consequences

多一条隐式加载路径，排查提示词来源时看 `getAppendSystemPromptSources()` 能拿到实际文件。没有文件监听，改了 preset 要等下次启动才生效，和 `APPEND_SYSTEM.md` 一致。

## Testing

`test/preset-prompt.test.ts` 覆盖默认发现、未受信项目忽略、显式覆盖、名字解析、排序、缺失名字不注入；`test/args.test.ts` 覆盖参数解析与和 `--append-system-prompt` 的独立性。
