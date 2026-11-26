# Agent Note: Cloudflare 默认模型随 generated catalog 改到 GLM 5.3

Status: implemented

## Problem

`packages/coding-agent/src/core/model-resolver.ts` 把 Cloudflare Workers AI 和
Cloudflare AI Gateway 的默认模型钉在 `@cf/moonshotai/kimi-k2.6` 及其 gateway 前缀形式。
当前 models.dev 的 `cloudflare-workers-ai` 目录已经没有这个模型，generator 因此不再生成它。

结果是三处失败：

- `packages/coding-agent/test/model-resolver.test.ts` 的 pinned default 检查断言默认 id 在生成目录里存在。
- `packages/coding-agent/test/model-runtime-cloudflare-compat.test.ts` 用同一个已消失的 gateway id 取模型，得到 `undefined`。
- 用户没有显式指定模型时，Cloudflare provider 会解析到一个不存在的默认模型。

## Decision

两个默认模型都改为 `@cf/zai-org/glm-5.3`；Gateway 仍走它现有的
`workers-ai/` 镜像前缀，得到 `workers-ai/@cf/zai-org/glm-5.3`。
compat 测试也改用这个 id。

GLM 5.3 是当前 Workers AI 目录里工具调用、推理、文本输入输出都具备的模型，
且已有 gateway 的镜像生成路径。保留 `workers-ai/` 前缀使请求仍命中 Cloudflare 的
`/compat/chat/completions` 端点，不改变这次测试要验证的 auth header 与 endpoint 行为。

## Alternatives considered

- **在 generator 里手工补回 Kimi K2.6**：否。当前目录没有它的元数据（价格、上下文、工具支持），
  补一条手工记录只是把一个已被上游移除的 id 重新冻进本地目录；下次模型退役还会重复。
- **只改 compat 测试，保留旧默认**：否。`packages/coding-agent/test/model-resolver.test.ts`
  的失败说明默认解析本身已经指向不存在的模型，测试只是把真实问题暴露出来。
- **把默认改到另一个仍受支持的 Kimi 变体**：否。当前 gateway 目录的 Moonshot 条目是 K3 系列，
  没有 K2.6 的替代品；Workers AI 侧也没有 Moonshot 条目。选择与现有测试目标更接近、且同时存在于两侧目录的 GLM 5.3。
- **删掉这两个默认**：否。那会让两个 provider 退化为必须显式指定模型，属于额外行为变化，不是这次目录漂移需要的修复。

## Consequences

- 显式指定旧 Kimi id 的用户仍可传自定义模型 id；本次只改变未显式指定模型时的默认值。
- Cloudflare 默认模型的推理能力与 token 计费特征随 GLM 5.3 变化；这是跟随生成目录的必然结果。
- 三个失败用例恢复通过， pinned default 检查继续保证所有 provider 默认值都能在生成目录里解析。
