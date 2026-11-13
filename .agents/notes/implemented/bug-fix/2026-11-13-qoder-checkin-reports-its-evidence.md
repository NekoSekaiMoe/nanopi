# Agent Note: Qoder 签到失败要说清自己带了什么身份、服务端给了什么

Status: implemented

## Problem

`no claimable campaign (1 campaign(s), none claimable)` 这句话在两种完全不同的处境下都会出现：

- 今天确实没有下发每日签到活动（活动结束了，或者这个账号拿到的是 SOTA 之类的别的包）；
- 国际站没认出这次请求是一台真实安装，把 `CLAIM_BENEFIT` 那格扣住了。

后果不一样：前者只能等，后者补一份抓包指纹就能领到。原本文案两者撞车，用户看到的都是一个"没领成"的行，
没有下一步可做。排查时也没有证据可看——只打了活动计数，没说自己带了哪些设备头，也没说服务端列了哪些活动。

qoder2api（Zhengyuuuui/qoder2api，`checkin.go:676` 附近）对同一件事的做法是：`no_campaign` 分支把
`fingerprint=%v`、`campaigns=%v`（`ACTION/STATUS` 列表）和截断的原始响应一起打到日志里。nanopi 的签到是
启动时的 dim 状态行，没有日志可翻，所以这些信息必须进 `QoderCheckinResult`，再由调用方决定读到哪。

## Decision

两处：

1. `checkinQoder` 的返回值多带证据：`fingerprint`（这次请求到底有没有带抓包身份）、`fingerprintFields`
   （带了哪几个）、`campaigns`（服务端列出的活动，形如 `CLAIM_BENEFIT/PENDING`）、`raw`（截断 400 字符的
   原始响应，只在没领到时填）。身份字段由 `QoderDeviceIdentity` 里真实有值的字段算出来，不是"调用方说过要带"。
2. `collectCheckinMessage` 在 `no_campaign` 时展开这些证据：
   `qoder (dabao1955): no claimable campaign (1 campaign(s), none claimable); no device identity; listed: SOTA_PACKAGE/CLAIMABLE`。
   其它状态（claimed / already_claimed / error）文案不变——它们本身就是结论。

## 设备身份按账号读，且读全

`QODER_MACHINE_TOKEN` / `QODER_MACHINE_TYPE` 之外补上 `QODER_MACHINE_ID`、`QODER_MACHINE_CODE`、
`QODER_CLIENT_VERSION`、`QODER_CLIENT_TYPE`、`QODER_MACHINE_HOSTNAME`、`QODER_MACHINE_OS`。
官方桌面端的签到请求不是只带 token 两个头，`cosy-version` / `cosy-machineid` / `cosy-machinehostname` /
`cosy-machineos` 都在（qoder2api `checkinHeaders` 实现同一组）。只带 token 恰恰是"看起来不像真客户端"的半个指纹。

取值顺序是**凭据里的值优先，进程环境兜底**。上一版是反过来的（`env?.X ?? process.env.X` 其实已经是凭据优先，
但只有两个字段，且写成两个 `??` 表达式，容易被读成环境变量是主路径）。写明是因为一台机器上两个 Qoder 账号
共用一个 `QODER_MACHINE_TOKEN` 会让上游看到"同一台设备登录两个账号"，这是最容易被判风险控制的形态。
CN 站仍然一个都不发：它拒绝伪造指纹，这条不变。

## Alternatives considered

**把原始响应直接拼进状态行。** 最省事，也最不可读：启动时的一行通知塞进 400 字符 JSON，把真正要看的
"有没有带身份"淹掉。所以 `raw` 留在结果里，状态行只花两个短字段（身份、活动列表）。

**在 coding-agent 侧解析 campaign 列表。** `run.ts` 只拿到 `@nanopi/pi-ai/qoder` 的结果对象，activity 的语义
（哪种 `actionType` 才算每日签到）属于 `checkin.ts`，放上面会让两处各判一次。

**让环境变量覆盖凭据。** 方便在临时排障时统一换指纹，但会让多账号场景静默地共用一台设备。排障可以改凭据文件，
或者手工传 `device`——不需要一个会污染正常路径的开关。

**自造一份指纹当默认值。** qoder2api 明确记录过：自造值无效，还能让 CN 站直接拒绝。缺指纹就只能报"没带"，
不能假装带了。

## Consequences

- 缺指纹的账号现在会被点名，用户知道下一步是补 `QODER_MACHINE_*`，而不是以为今天没活动。
- `QoderCheckinResult` / `QoderCheckinSummary` 是 `@nanopi/pi-ai/qoder` 的导出面，加了必填字段 `fingerprint`：
  自己构造这两个对象的调用方要跟着改。仓库里只有 `run.ts` 和测试构造它。
- 状态行在 `no_campaign` 时变长一截。这是刻意的：这一行只有在"没领到"时才需要用户动手。
