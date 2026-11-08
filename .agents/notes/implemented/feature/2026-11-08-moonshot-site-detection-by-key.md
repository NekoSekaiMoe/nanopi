# Agent Note: 按 key 认出站点（Moonshot 中国 / 国际）

Status: implemented

## Problem

`2026-11-06-duplicate-catalogs-moonshot-cn-and-ollama-cloud` 把 China catalog 删了，
理由仍成立：同一批 6 个模型 id、同一份价格，只差 `baseUrl`。但那条笔记给国内用户
的答案只有一句「自己在 `models.json` 里改 `baseUrl`」，而这个改动**不能猜**：

- `api.moonshot.ai` 与 `api.moonshot.cn` 的 key 互不通用，端点点错就是 401；
- webui 的「从接口拉取模型」在 `AddProviderForm` 里只发一枚 `base_url`，预设默认值
  是国际站点。拿着中国 key 的用户点「拉取」只会看到 401，然后要自己去查应该填哪个
  域名——问题 #598 问的正是这件事：合并之后用户怎么选。

## Decision

**把「选站点」变成一次探测：先问中国站点模型列表，拿得到就是中国站点，拿不到就是
国际站点。**

- `packages/coding-agent/src/core/model-listing.ts` 新增 `SiteEndpoints` 与
  `resolveSiteBaseUrl`：按 `[site, global]` 顺序调 `fetchModelListing`，**返回非空列表**
  的那个 host 胜出，并把它的 `models` 一起带回，调用方不用再请求一次。
- 「有模型」而不是「HTTP 2xx」作为判据：代理会回 200 + 空 `data`，那读成中国站点
  就错了。
- 两个站点都不认这把 key 时，抛**中国站点**的错误：那是国内用户最可能想用的站点，
  也是单一 host 厂商（没有 `site`）唯一会产生的错误，避免把级联失败盖成国际站点的 401。
- 预设表里 `moonshot` 多一个 `site_endpoints`（`vendor` / `site` / `global`），
  `default_base_url` 仍是国际端点——那是没探测时的提交值，也正是内置 catalog 的
  `baseUrl`。`/providers/discover-models` 收到 `preset` 就改走探测，并把
  `{models, base_url, site}` 回给页面；页面把 `base_url` 写回输入框再保存。
- `AccountCard` 用 `site_endpoints.site` 的 host 给已有 account 打「（中国站点）」。

探测是**请求级**的，不落盘、不进 `KnownProvider`：`moonshotai` 仍然只有一个 catalog。
`resolveSiteBaseUrl` 是唯一做站点判断的地方，以后 siliconflow（`.com` / `.cn`）
这类厂商加一行 `site_endpoints` 即可，不用再动前端。

## Alternatives considered

- **恢复 `moonshotai-cn` catalog。** 回到「同一批模型两份打包 + 选择器里两条」，
  正是上一条笔记否掉的方案；而且用户仍要判断自己的 key 属于哪一条。
- **在添加表单里加一个「中国/国际」下拉。** 这就是把「用户自己去查」换成「用户自己
  去选」，选错还是 401。key 已经是唯一的真相来源，再问一次只会多一个出错点。
- **用状态码判定（中国站点 401 → 国际）。** 差别只在网络与网关的表现：代理回 200 空
  列表时状态码说「行」，列表说「不行」，而真正能用的判据是「回没回模型」。
- **并行探测两个 host。** 省一次 RTT，但一半请求带着用户的 key 打到一个注定 401 的
  站点；顺序探测在成功路径上只有一次请求，失败路径本来就是异常。
- **编辑页也总是探测。** 编辑页的 base URL 是已有值，用户填了 host 就是他的选择；
  只有留空时才探测，否则每次「拉取模型」都可能把用户手写的网关地址改掉。

## Consequences

- 中国 key 在 webui 里只需粘 key + 点「拉取模型」，`baseUrl` 自动变成
  `https://api.moonshot.cn/v1` 并随账号保存；国际 key 行为不变。
- `/providers/discover-models` 的响应从裸数组变成 `{models, base_url?, site?}`，
  页面同步改了（`discoverProviderModels` 返回 `DiscoveredModelsResult`）。
- CLI / `models.json` 手写用户没有变化：探测只服务 webui 的添加与编辑流程，
  运行时仍按保存下来的 `baseUrl` 请求。
- 探测失败的错误信息里带的是 host 与实际状态码（`… answered 401`），
  这和 `fetchModelListing` 现有措辞一致，页面直接展示。
