# Agent Note: 离线模式先探测主机，能连上就照常下载 sidecar

Status: implemented

## Problem

两件事叠在一起，把「离线安装」变成了「没有图像后端」：

- 从 20261107 起 `full` 不内嵌任何 sidecar
  （[sidecars-download-in-full](./2026-11-06-sidecars-download-in-full.md)），
  下载路径成了唯一来源。
- `ensureSidecars` 在 `NANOPI_OFFLINE` 下直接 `continue`，只打一条 warning。

于是只要设了这个 flag，photon 的 wasm 和 TUI 的 prebuild 就永远不会装。容器、
CI、NPC 自己跑的会话都设它，而且设的理由通常是「启动时别去联网」而不是「这台
机器没有网」。issue #586 第一次把后果测出来：`read` 读图时 resize 阶段返回
`photon-unavailable`，附件被换成一行 `[Image omitted: …]`。

## Decision

离线模式下不再无条件跳过下载，而是先问一句「主机答不答」：

- `hostAnswers(url)` 对 manifest 里的每个 tarball URL 发一次 `OPTIONS`，单次尝试、
  4 秒预算。任何 HTTP 状态码都算可达——404 是主机答复了，那是下载自己重试要报的错。
- 一个 source 的 URL 列表里有任意一个可达，就走原来的下载/镜像重试路径；
  全都不达才打 warning 并降级。
- 探测结果按 URL 在进程内 memoize：每个 source 每次启动只探一次。

`NANOPI_OFFLINE` 因此回到它原本的意思：不要替用户拉取*可选*的东西（fd/rg）。
sidecar 不是可选的，它是 `full` 里图像能力和原生剪贴板的唯一来源。

## Alternatives considered

**保持原样，只在文档里写清「离线就没有图像」。** 归零改动，但把一条默认路径
的可用性交给一个用户根本不理解为「禁用图像」的 flag。

**让 `full` 重新内嵌 sidecar。** 直接违背上一轮换来的 1.24 MiB 收益，而且要在
每个平台把四个 prebuild 全塞进一个产物。

**离线时也直接下载，不探测。** 最坏情况下（DNS blackhole）每次启动等满 120 秒
下载预算，而离线模式存在的场景往往正是这种机器。探测把上限压到 4 秒，并且在
第一台可解析的主机上就结束。

**探测改成 `HEAD`/`Range` 下载 GET。** 少一次 `OPTIONS` 和下载之间的重复请求，
但 GitHub Releases 对 `OPTIONS` 的响应比 `HEAD` 稳定，且 `HEAD` 的语义在各 CDN 上
不一致。可达性只需要「有人应答」，用不到对象元数据。

**探测失败也继续尝试下载。** 那探测就毫无意义：它存在的唯一目的就是给离线机器
省掉那 120 秒。

## Consequences

- 收益：设了 `NANOPI_OFFLINE=1` 但能上网的机器（容器、CI、NPC 会话）第一次读图
  就能拿到 photon，TUI 也能拿到原生剪贴板。
- 代价：离线且主机不可达时，每个 source 多花最多 4 秒（一个 source 一个 URL 是
  常态，TUI 那个 source 有三个 URL，第一个不可解析就停）。启动是后台
  prefetch，不阻塞 TUI，但进程退出前可能仍在等。
- photon 的按需加载（`ensurePhotonWasmSidecar`）走同一个探测，所以「离线且不可达」
  时第一次读图会等一次探测，之后结果被 memoize。
- `packages/coding-agent/test/standalone.test.ts` 覆盖两条新分支：离线 + 可达时照常安装；离线 + 不可达时
  不发起下载并打那条新 warning。
