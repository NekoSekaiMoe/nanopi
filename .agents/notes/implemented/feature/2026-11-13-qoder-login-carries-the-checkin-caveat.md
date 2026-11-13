# Agent Note: `/login qoder` 先说清签到需要一份抓来的设备身份

Status: implemented

## Problem

Qoder 国际站只把每日签到活动发给"看起来像真实安装"的请求，而判断依据是 `cosy-machinetoken` /
`cosy-machinetype` 两个头。这两个值只能从官方客户端抓，登录流程拿不到、也推不出来。

结果是：用户 `/login qoder` 成功，模型列表正常刷新，然后在会话启动时看到

```
Qoder daily check-in · qoder (dabao1955): no claimable campaign (1 campaign(s), none claimable); no device identity; listed: VIEW_DETAILS/CLAIMABLE
```

这条已经在 #715 里做到能自证（说了没带身份、说了服务端给了什么），但它出现的位置在登录**之后**。
登录那一刻用户没有任何提示说"签到还差一步配置"，唯一的补法（往凭据 `env` 里写三个变量）也只能靠翻
issue 才知道。

登录对话框是唯一一个用户主动盯着、并且正在被要求提供东西的地方，缺的注意事项应该在那里。

## Decision

`OAuthAuth` 多一个可选字段 `notice?: readonly string[]`：条目是"关于账号、而不是关于某个登录步骤"的说明。
Qoder 的两个 provider 里，`qoder`（国际站）声明四条：

- 登录不配置签到；没有抓包身份，国际站不发活动。
- 从桌面端抓 `cosy-machinetoken` / `cosy-machinetype` / `cosy-version`，落成 `QODER_MACHINE_TOKEN` /
  `QODER_MACHINE_TYPE` / `QODER_CLIENT_VERSION`。
- 自造值比不传更糟（CN 站直接拒，国际站扣活动）；`/qoder-checkin` 的状态行会说清了哪几个字段。
- 凭据里没有时会回落进程环境，于是这台机器上所有账号共用一份抓包。

`qoder-cn` 不声明：CN 站本来就不需要指纹，给它的用户看这条只会误导。

三处渲染，都只做展示、不做交互：

- TUI：`/login` 打开 `LoginDialogComponent` 时把 notice 放在标题下面（dialog 只是渲染文本，光标和流程不变）。
- CLI：`nanopi auth login --provider qoder` 在流程开始提问前逐行打印。
- 文档：`packages/coding-agent/docs/providers.md` 新增 `### Qoder` 小节，写清取值来源与"别自造"。

`notice` 走 `lazyOAuth` 透传，所以不必为了显示一行字去 `load()` 整个 OAuth 实现。

## Alternatives considered

**把注意事项塞进 `loginQoder` 的某个 `interaction.notify({ type: "info" })`。** 位置对，时机不对：
`auth_url` 事件会 `showAuth()`，那个方法会先 `contentContainer.clear()`，notice 在浏览器渲染前就被冲掉；
挪到 `auth_url` 之后发也没用，用户这时候已经在浏览器里了，回到终端只看到"等待授权"。注意事项要出现在
**用户知道自己要做什么之前**，也就是对话框刚打开那一刻。

**把 `QODER_MACHINE_*` 做成登录流程里的提问步骤。** 这是上一轮遗留的提议，这次明确不做：登录当时手上
没有抓包（用户是先登录、看到签到失败、才去抓），强制填只能诱导用户编一个——而上游明确惩罚自造指纹。
登录流程不该提一个它无法验证、且编错更糟的问题。

**只写文档，不改代码。** 文档没人读是常态，而这行提示的价值全在"用户看到签到失败之前"。两个都要。

## Consequences

- 每打开一次 `/login qoder` 就看到四条 warning 色文本，对不需要签到的用户是噪音。这是刻意的：失败的
  代价（沉默的 `no_campaign`）比四行字高。`qoder-cn` 没有这条，是权衡后的例外，不是遗漏。
- `notice` 是 `OAuthAuth` 导出面上的新可选字段，外部 provider 实现可以自带文案；`lazyOAuth` 的入参同名
  字段必须同步，否则懒加载的 provider 会把文案丢掉。
- 文案是硬编码英文，和 CLI 其它提示一致；没有走 i18n。
- 回归测试在 `packages/coding-agent/test/auth-login.test.ts`：断言 CLI 在流程提问前打印 notice 第一行。
