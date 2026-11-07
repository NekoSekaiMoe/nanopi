# Agent Note: 删除 llama.cpp 支持

Status: implemented

## Problem

`packages/coding-agent/src/modules/llama/` 是 2,425 行自有代码（client / provider /
managed supervisor / ui / huggingface / index），外加 `packages/ai/src/api/
llama-cpp-classify.ts` 的 486 行，以及 776 行测试。它提供的四件事：

1. managed supervisor：`--internal-llama-supervisor` 子进程、unix socket、按连接数
   计的空闲关停、`llamaCpp.*` 设置；
2. `/llama`：router 当前状态的唯一可见入口（load / unload / 下载 GGUF / 重连）；
3. Hugging Face 搜索与下载；
4. 动态目录：只列 router 当前装着或睡着的模型，decision model 挂
   `typesafe-system-one`、chat 模型挂 `llama-cpp-classify`。

这四件之外，`models.json` 早就覆盖了：`baseUrl` + `api: "openai-completions"` +
`contextWindow` 就是一行配置，router 自己按请求里的 model id 按需加载。成本不在行数，
在于它是唯一一个**和上游结构已经分叉却要长期跟上游 merge 的自有模块**：该目录 24 次
提交、8 位作者，全部来自上游，11 次是修 bug；`8e053a1f8 align codex identity and llama
merge cleanups` 就是 merge 税的凭证。

## Decision

按 issue [#584](https://cnb.cool/shinytale/nanopi/-/issues/584) 选的全删：

- `packages/coding-agent/src/modules/llama/` 整个目录、`BUILTIN_MODULES` 的
  `llama.cpp` 条目、`buildconfig.json` 的 `module/llama.cpp` 组件与 `moduleBundles`
  条目；
- `main.ts` 的 `--internal-llama-supervisor` 分支（supervisor 是这条 flag 拉起来的
  子进程，没有 flag 就没有进程模型）；
- `settings-schema.ts` 的 `LlamaCppSettingsSchema`、`SettingsSchema.llamaCpp`、
  `SettingsManager.getLlamaCppSettings()`，重新生成 `schemas/settings.schema.json`；
- `interactive-mode.ts` 的 `llamaCppPostLoginGuidance`：它是 `/login llama.cpp` 之后
  指向 `/llama` 的提示，provider 没了提示也就没有对象；通用分支已经覆盖
  「该 provider 没有默认模型」这一情形；
- `packages/ai` 的 `llama-cpp-classify` API（实现、`.lazy` 包装、`api/disabled`
  的 build stand-in、`KnownClassifierApi` 成员、测试、`apiSets.endpoint` 里的 id）；
- `docs/llama-cpp.md` 与导航项，`docs.json` 加 `llama-cpp.md → models.md` 的
  redirect，`models.md` 的本地模型一节改写成 `models.json` 写法。

**保留** `packages/ai` 里三处 llama.cpp 特判：`insufficient_system_resource` 可重试
（`utils/retry.ts`）、`exceeds the available context size` 溢出识别
（`utils/overflow.ts`）、`thinking_budget_tokens`（`compat-schema.ts`）。它们作用在
请求/响应本身，用户在 `models.json` 里自建的 llama-server 端点照样命中；删了是纯粹
的回归。同理保留 `openai-completions.ts` 里 `reasoning_content` 和无 `output_index`
的注释说明，那是适配层对同一批端点的既有处理。

`typesafe-system-one` 不动：OpenRouter / TypeSafe / Cloudflare / Vercel / opencode
都在用它，llama.cpp 的 decision model 走 `/v1/systemone` 时也是它。

## Alternatives considered

- **只删 managed + 下载，留 connect（约 1.1k 行）。** 省掉子进程、socket、空闲关停
  这块最容易出并发问题的地方（`2fba19271 simplify the managed supervisor`、
  `cc81b1176 route classify after auth resolution` 都在修它），但留下的 `client.ts`
  + `provider.ts` + 动态目录仍然是一条跟上游对齐的链路，只是变短。省一半 merge 税
  换一半的清晰度，不如不留。
- **全留，把本地 GGUF 当目标场景之一。** 前提是本地 GGUF 值得一条自有链路；router
  已给出按需加载，「自动发现」和「下载」是便利不是能力。
- **留 `llama-cpp-classify`，只删 provider 模块。** 它是 `@nanopi/pi-ai` 的公开
  API，第三方模块能直接拿来把任意 llama-server chat 模型当分类器。用户拍板跟着删：
  这套 logprob 读法的唯一已知消费者就是被删掉的 provider，公开面留着等于让继任者
  维护一个没人跑的 API。
- **只在 buildconfig 里关掉 `module/llama.cpp`，代码留着。** 组件关掉只是让 flavor
  不起作用，源码仍在树里，merge 税一分不少，还多一个「哪些 flavor 带它」的问题。
- **把 managed supervisor 挪进 `packages/extra`。** 与「删」相反的方向，且
  `packages/extra` 是运行模式/权限模块，进程托管的生命周期不属于它。

## Consequences

- GGUF 用户从 `/login llama.cpp` 变成在 `models.json` 写一条 provider：`baseUrl`
  指 router 的 `/v1`、`apiKey` 写什么（llama.cpp 没有 `--api-key` 就忽略）、
  `contextWindow` 写 `-c` 的值。不会自动发现 router 里的模型，也不能从 CLI 下载
  模型。
- `docs/models.md` 的本地模型一节现在给出这段 JSON；`docs/llama-cpp.md` 的旧链接
  被 redirect 到 `models.md`。
- `settings.json` 里遗留的 `llamaCpp` 键不再被校验也不再被读取。schema 有
  `additionalProperties: true`，所以它不报错，只是无效——这是删除功能时能给出的最
  安静的形状。
- `scripts/module-registry.test.mjs` 和 `scripts/build-modules.test.mjs` 拿
  `llama.cpp` 当样例模块名，改成 `ask-lite` / `pi-ui`；`args.test.ts`、
  `settings-manager.test.ts` 拿 `+llama` 当模块工具样例，改成 `+todo`，`--help`
  里的示例同步。
- `packages/coding-agent` 与 `packages/ai` 各一条 `### Removed`：一个记模块（命令、
  supervisor、设置、目录、文档），一个记 API。
