# Agent Note: models.json 里超出构型 API 集的模型按警告跳过

Status: implemented

## Problem

`minimal` 构型只带 `openai-completions`（`buildconfig.json` `apiSets.openai`）。
用户把一份写给 `full` 的 `models.json` 拿过去，`provider-composer.ts` 的
`modelFromJson` 会在 `isApiIncluded(api)` 为假时抛错，而 `composeProvider`
把所有抛错都吞成 per-provider 的 composition error：

```text
Provider "nvidia": Provider nvidia, model deepseek-v4-flash: api "openai-responses"
is not included in this build (included: openai-completions)
```

后果是**整个 provider 掉线**，包括同文件里那几条 `openai-completions` 的模型。
对一个只想要「一个 endpoint 形状」的 SKU 来说这个结果不对：文件本身没坏，
坏的是构型和文件的交集。

## Decision

模型级 `api` 缺失时不再抛错，改为 skip + 警告：

- `modelFromJson` 抛 `DroppedApiModelError`（模块内私有类），
  `applyModelsJson` 捕获它、把消息记进 `SkippedApiModels` 收集器，继续下一条模型。
  provider 的其他模型照常加载。
- provider 级 `api`（`config.api`）缺失仍然是硬错误：该 provider 下所有没写
  自己 `api` 的模型都会继承它，skip 只会留下一个空 provider，没有意义。
- `findModelDefaults` 只在「本构型带得动的 api」里选继承用的默认值，否则一条
  被 skip 的模型可能把自己的 `openai-responses` 传给后面没写 api 的兄弟模型，
  把刚过滤掉的东西又复活回来。
- 收集器按 provider 去重：`applyModelsJson` 在每次 catalog 读取时都会重跑，
  否则同一条 skip 会被列 N 次。
- `ModelRuntime.getWarnings()` 输出 `models.json: provider X, model Y: ...`，
  `getError()` 不掺进来。展示面：interactive 启动与 reload 时 `showWarning`、
  `/model` 选择器刷新后列警告行、`--list-models` 打到 stderr。
  `--auth check` 仍然只看 `getError()`，警告不改变 readiness。

## Alternatives considered

- **整份 `models.json` 一次校验完再加载**：过滤逻辑要在 composer 之外重写一份，
  而 composer 已经是「builtin + models.json + extension」三层合并的唯一入口。
- **把 provider 级缺失也降级成警告**：会留下一个没有任何模型、只剩 auth 的
  provider，`getError()` 里那些真正需要用户动手的信息也就跟着没了。
- **只在 CLI 打印、不做运行时 API**：`/model` 与 webui 也需要同一个列表，
  再各自解析一遍错误字符串比多一个 getter 更脆。
