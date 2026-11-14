# Agent Note: 缺 photon 时图片原样送出，而不是丢掉

Status: implemented

## Problem

`resizeImageInProcess` 是这条链路上唯一能把图片重新编码的东西：它 load photon，
不成就返回 `{ ok: false, reason: "photon-unavailable" }`。`processImage` 把这个
reason 直接变成失败，调用方（`read`、`@file` 附件、prompt 里的图片、
`normalizeToolResultImages`）于是把附件换成一行占位文本：

```
[Image omitted: the image backend is unavailable, so the image could not be resized.]
```

结果是模型完全看不到图。而 photon 现在恰恰经常不在：

- `full` 从 20261107 起不再内嵌 sidecar，改成按需下载
  （[the sidecars-download-in-full note](../process/2026-11-06-sidecars-download-in-full.md)）。
- `ensureSidecars` 在 `NANOPI_OFFLINE` 下直接 `continue`，只打一条 warning。
  容器、CI、以及 NPC 自己的会话都开离线模式。

于是"离线安装不能看图"不是降级，是彻底看不见。issue #586 用一个容器的实测
问到了这条链路上。

## Decision

`processImage` 在 `photon-unavailable` 时不再一律失败，而是先问一句：这张图
是否已经满足 resize 阶段要守的两条限制？

- base64 payload 小于 `maxBytes`（默认 4.5 MB）
- 像素不超过 `maxWidth` × `maxHeight`（默认 2000 × 2000）

两条都过就原样送出，附一条 hint 说明没有缩放；有一条不过才继续丢弃。两条都
要查，因为 provider 拒绝的是整条请求：一张字节很小、但 3000 px 宽的图能过大
小检查，却照样被拒，这正是 resize 阶段存在的理由。像素从图片头里读，复用
`@nanopi/pi-tui` 的 `getImageDimensions`（PNG/JPEG/GIF/WebP 都有，BMP 除外——
BMP 在这条链路上已经被转成 PNG）。

限制的默认值不再两处各写一份：`image-resize-core.ts` 导出
`resolveImageResizeOptions`，resize 本身和这个放行判断共用它。放行判断在
`maxBytes` 上用的是 `<`，与 `resizeImageInProcess` 里"已经够小"的判断一致。

## Alternatives considered

**始终原样送出，不做任何检查。** 最简单，且"模型看到图"永远成立。但把
provider 会拒收的图片送出去，代价是整条会话请求失败——比丢一张图严重得多，
而且失败发生在模型这一侧，用户看不出是图片导致的。

**只查 payload 大小。** 少一次头解析，但漏掉像素上限：一张 4000×4000 的
纯色 PNG 只有几十 KB，provider 会因为尺寸拒绝整个请求。

**离线时也尝试下载。** 用户明确要"不要网络"，而且这么做的失败面更大：离线
环境里下载会等到超时，每次首次读图都要付一次。

**PHOTON 缺失时用纯 JS 缩放（如 `sharp` / 手写重采样）。** 是真正的修复，
但要引入一个原生依赖或一条重采样实现，且 `full` 的 10 MB 预算就是为砍掉这类
负载腾出来的。留作以后真需要时的方向。

**只在 `read` 工具里放行。** 修不了 prompt 附件和工具结果图片，而那两条走的是
同一个 `processImage`。

## Consequences

- 收益：离线安装（以及任何 photon sidecar 缺失的环境）里读图重新可用。图片
  不被缩放，token 消耗按照原图尺寸算。
- 代价：这条路径上 EXIF 方向不会被应用（`resizeImageInProcess` 里调用
  `applyExifOrientation` 的那半步没有替代）。带 EXIF 旋转的手机照片会以旋
  转前的方向进入对话。选它是因为"方向不对的图"和"根本没有图"差一个数量级。
- 像素检查是 BMP 之外的四类格式；一个头读不出来的图被当作"无法证明超大"而
  放行，代价是一次失败的请求，而不是悄悄隐藏文件。
- 回归测试在 `packages/coding-agent/test/image-process.test.ts`：小图放行并带 hint、超 payload 预算
  仍然丢弃、超像素上限仍然丢弃。既有的 `photon-unavailable` 那条（BMP 转换
  失败）没有变，因为它走的是 `normalizeImage` 的空返回，不是 resize 路径。
