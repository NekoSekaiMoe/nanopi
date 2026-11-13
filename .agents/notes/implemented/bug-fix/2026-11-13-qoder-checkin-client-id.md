# Agent Note: 签到的 clienttype 跟着抓包版本走，不再各自硬编码

Status: implemented

## Problem

`qoderCheckinHeaders` 在没有抓包身份时写死 `cosy-clienttype: 10` + `cosy-version: 0.4.4`，有身份时又按 `10`
补全整组机器头。同一个 provider 的签名请求（`qoderDeviceHeaders`，`cosy.ts:128`）报的却是 `5` + `1.0.10`。
一个账号在 `/algo` 上像 IDE 客户端，在签到端点像 agent 客户端——上游按「账号 + 设备」聚类，这是自己造出来的
第二套身份。

qoder2api 把这一点作为开关处理（`checkin_antirisk.go:48` `CheckinFullDeviceHeaders` 默认 false，README 的理由是
「某些活动场景带完整设备头反而会被判非官方客户端」），而不是让两个端点互相矛盾。同时它的注释明确记了
`clienttype / version 必须与推理侧一致`。

还有一处隐含的错配：抓包里 `version` 是 `1.1.69` 时，代码仍然发 `clienttype: 10`——那是巧合正确（新版推理协议
就是 10）；抓包是 `0.4.8` 时同样发 `10`，就配错了：`0.4.x` 属于 IDE 那套 `5`。凑出来的是一个不存在的客户端。

## Decision

- `qoderCheckinHeaders` 无论是都带身份，都先发 `cosy-clienttype` / `cosy-version`。
- 有抓包身份时按版本推 clienttype：`qoderClientTypeFor`——`1.x` → `10`（下发每日签到的 agent 构建），其余 → `5`
  （IDE 构建）。显式给了 `QODER_CLIENT_TYPE` 就以显式值为准。
- 没有抓包身份时发 `5` + `0.4.4`，与签名请求的 IDE 身份同族。
- `parseCampaigns` 不再丢掉没有 `campaignId` 的条目：`(N campaign(s))` 里的 N 是用户判断「站点没下发」还是
  「下发了但没发给我」的唯一凭据，少算一条就是把证据改差。这类条目仍然无法领取。

## Alternatives considered

### Why not 照抄 qoder2api 的 `checkin_full_device_headers` 开关？

那个开关控制的是「带不带 `machinetoken` 整组」，默认关。nanopi 的模型是：抓到什么发什么，抓不到就一个机器头都不发。
再加一个「有身份但故意只发一半」的模式，等于给用户多一个会静默降低成功率的旋钮，而两种模式的差别没有一个能观测
的判据。真正该对齐的是「同一账号只有一套客户端身份」，那是无条件的。

### Why not 保留 `10` + `0.4.4` 当无抓包默认？

它是全球站现在实际在用的值，改了就是行为变更。但 `10` 的语义是 agent 构建，`0.4.4` 是 IDE 版本号，这组本身就自相
矛盾；而签名请求已经在用 `5` + `1.0.10`。两害相权，选与自家另一条请求一致的那个。

## Consequences

- 无抓包账号的签到请求从 `10` + `0.4.4` 变成 `5` + `0.4.4`。如果某个账号此前正是靠 `10` 拿到活动，这一改会让它退回
  `no_campaign`——诊断行会同时给出 `no device identity`，指向补抓包这条正路，而不是让人怀疑档位。
- `1.x` 抓包现在发 `clienttype: 10`；`0.4.x` 抓包发 `5`。抓包里带了 `cosy-clienttype` 的，行为完全不变。
- 少一条丢失入口的 campaign 不再被静默从计数里扣掉。
