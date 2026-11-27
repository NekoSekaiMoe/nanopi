# Agent Note: 模型可以自己发起一次出图，但钱由人放行

Status: implemented

Ref: shinytale/nanopi#757, shinytale/nanopi#750, shinytale/nanopi#753

## Problem

`generateImages()` 在树上有实现、有 registry 通路，却没有调用方：模型没有任何途径要一张图。
PR #753 曾经补过这个入口（`pi-image` 模块的 `generate_image` tool），但把自主性显式关掉了：

```
Use generate_image only when the user asks for an image.
```

#757 的目标正好相反：模型判断当前任务需要一张图，就自己生成。这不是改一句措辞——放开之后
模型能单方面发起一次付费 provider 请求，而现有的 `PermissionGate` 是按 tool 名拦「这一次调用」，
出图不在 `GATED_TOOL_NAMES` 里，等于没有任何闸门。

## Decision

**判据落在任务的产物上，不落在「模型觉得自己想画」。** guideline 从「用户要求时」改成：

```
Use generate_image when the task's output includes an image file (an og:image, a placeholder
for a component, a test fixture), or when the user asks for an image.
```

这一类之所以是唯一放开的，是因为它能从任务本身读出来（产物里有没有图片文件），事后可验证。
解释型示意图和「替身截图」不进 guideline：前者画歪了就是噪音，后者造出来的图会被当成真实证据。

**`generate_image` 进 `GATED_TOOL_NAMES`**（`packages/extra/src/extension.ts`）。判据交给模型，
放行交给人：非 yolo 会话第一次自主出图要过 `PermissionGate` 的四答。一次出图就是一次花钱，
闸门按调用拦是够的——`allow_once` 只放行这一次，模型再问还得再问人。

**入口只从 #753 捡 `pi-image` 的两个文件**（`src/modules/pi-image/src/{index,tool}.ts`）+ `BUILTIN_MODULES`
一行 + `buildconfig.json` 的组件/`moduleBundles` 条目 + tool 测试。#753 的 provider 侧
（`openai-codex-images`、`openai-responses-shared` 的钩子、`register-builtins` 的注册）与自主出图无关：
`openrouter-images` 在 main 上已经注册好，tool 直接调 `ctx.modelRegistry.generateImages()` 就能出图。
`base`/`minimal` 两个 flavor 显式关掉 `module/pi-image`，维持「最小构建只给 bash」的边界。

**不给 `path` 就不落盘，图只活在 transcript 里。** 这是 #753 的旧行为，本次不改：默认落盘意味着
模型在工作区写文件、或者引入一个「会话临时目录」的新概念，两者都超出「给它一个入口」的范围。
代价是 compaction 之后模型自己看不见那张图，等真有人抱怨再谈。

## Alternatives considered

- **每轮/每会话出图次数上限**：本来是为了拦「模型今天第 20 次自作主张」，但 `PermissionGate` 的
  `allow_once` 已经是这个语义——拒绝一次它就记不住，模型再问还得再问一遍人。自己发明一个计数层
  等于加第五种状态，收益比不上维护成本。
- **只允许视觉模型自主出图**：非视觉模型拿到的是占位符
  （`packages/ai/src/api/transform-messages.ts` 的 `(tool image omitted: ...)`），确实无法自检画得对不对，
  只能盲重试。但烧钱的闸门是人，不是 `model.input`；真要管，等出现真实浪费再加，现在加等于猜。
- **默认落盘到 `.nanopi/artifacts/` 或会话临时目录**：见 Decision 最后一段。落进工作区得和 `write`
  一个待遇，落进临时目录则要让模型下一轮知道路径，两件事都不属于本次的最小切法。
- **不暴露成 tool，让模型在 markdown 里写指令、由宿主渲染时生成**：入口形状换了个地方，判断与放行的
  分裂并没有消失，反而把「何时花钱」藏进了渲染路径。#757 讨论里选的是 tool。
- **顺手复活 #753 的 provider 侧**：那部分补的是 ChatGPT OAuth 的出图 provider，是「用谁的额度画」，
  不是「模型能不能自己画」。混进来会让这次 diff 从约 200 行变成 600 行。

## Consequences

- main 上第一次有了 `generateImages()` 的调用方，`docs/models.md` 里指向它的那段现在有落点。
- 自主出图的可信度上限就是 guideline 那一条判据：模型若把它解释宽了（比如为「解释一下这个状态机」
  画一张图），拦它的是 `PermissionGate` 的提示，不是代码。这是有意的取舍——判断归模型，放行归人。
- 模型看不见自己画的图这件事仍然成立。视觉模型越多这个问题越小，但在非视觉会话里自主出图
  目前只能在第一次就把 prompt 写对。
- 图不落盘，所以 compaction 之后那张图对模型自己也不再存在。要长期引用就得传 `path`，那是一次
  `write` 级的落盘动作。
- `base`/`minimal` 构建仍然没有出图入口。

## Testing

- `packages/coding-agent/test/pi-image-tool.test.ts`：结果同时带 image block 和一行说明；写盘并按
  mimeType 补扩展名；优先用会话自身 provider 的 image model；没有可用 image model 时的报错；
  provider 失败的文案透传；扩展名映射。
- `packages/extra/test/webui-mode-wiring.test.ts`：`generate_image` 在交互会话里会先问人（`asked: 1`），
  拒绝即拦下。
