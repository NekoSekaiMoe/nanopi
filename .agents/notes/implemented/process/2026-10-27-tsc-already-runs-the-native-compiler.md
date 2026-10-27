# Agent Note: tsc 换成 tsgo 这条提案在这个仓库里已经落地了

Status: implemented

## Problem

Issue #322 想「把 tsc 换成 v7 的 tsgo」。听起来像一次工具链迁移：换包、
换 bin 名、逐个核对 `tsc -p tsconfig.build.json` 的调用点。

实际核对下来，迁移这件事在依赖升级那一批里已经完成了一半，只差证据：

- 根 `package.json` 与 `packages/extra/package.json` 的 `typescript` 已经是
  **7.0.2**。TS 7 的 npm 包发布的就是 Go 原生实现，`node_modules/typescript/bin/tsc`
  只有十几行：解析 `@typescript/typescript-<platform>-<arch>/lib/tsc` 后
  `process.execve` 过去。也就是说 `tsc` 这个名字下面跑的就是 tsgo，
  仓库里的 `tsc --noEmit`、`tsc -p tsconfig.build.json` 全部调用点不用改。
- `@typescript/typescript-linux-{arm64,x64}@7.0.2` 在 `pnpm-lock.yaml` 里是
  `typescript@7.0.2` 的 `optionalDependencies`，装完即用。
- 独立 npm 包 `tsgo` 不存在（registry 返回 404）。换名没有可换的落点。

## Decision

不换包，也不加 `tsgo` 别名。补一条回归测试把「跑的是原生编译器」这件事锁住：

`scripts/check-native-tsc.test.mjs` 读 `node_modules/typescript/package.json`，
要求 `bin` 恰好是 `{ tsc }`，且平台包 `@typescript/typescript-<platform>-<arch>`
连同一份可执行的 `lib/tsc` 能解析到。老 TS（5.9.3，`lib/tsc.js` 是 JS 实现）
满足不了第一条，`pnpm` 漏装平台包时满足不了第二条。

测试接在 `pnpm run test:scripts` 后面：那里的测试按 glob 展开，新文件自动进 CI。

## Measured

现有配置下根程序的规模与耗时（`tsc --noEmit --diagnostics`，
2 核 amd64 CNB runner）：

- 4011 个文件、74.8 万行、144 万个类型、724 万次实例化
- check 3.6s、emit 0.8s、总 6.1s，内存 1.8 GB，墙钟 7.4-7.7s

对照 `packages/webui`（仍是 `typescript@5.9.3`，该包有自己的 tsconfig，
不在根 include 里）：同一份代码 5.9.3 与 7.0.2 都干净通过，可以按需切换，
急不起来。

## Alternatives considered

- **把 `typescript` 依赖改名为 `@typescript/native-preview` + `tsgo` bin**：
  这是 TS 7 正式发布前的预览分发方式，现在已经是历史。改名等于把 7.0.2 降回
  预览版，并且要把 `scripts/*.mjs` 里的 `typescript/unstable/*` API import
  一起跟着换路径。
- **把 `packages/webui` 的 5.9.3 也提到 7.0.2**：可以，但和这个 issue 无关。
  webui 的 tsc 是 `next build` 的类型检查前置，锁 5.9.3 是当时按 Next 16 的
  兼容面选的，验证过没问题再动，不搭这趟车。
- **再加一条 `typecheck:native` 脚本调 `tsgo`**：仓库里没有第二个可指向的
  二进制，多出来的脚本只会让 `pnpm run check` 多一次全量编译。

## Consequences

类型检查已经是原生实现，剩下的收益只能从「少检查一点」或「增量」里拿：
`tsc --noEmit` 在这个规模下没有增量缓存（`--incremental` 与 `noEmit` 不并存），
真正想再快，方向是拆 program（例如把 `packages/ai/src/providers` 的 51 个
provider 目录单独成一个 project reference），不是换编译器。

代价是这条测试盯的是 `node_modules` 的包布局：TS 上游换 bin 名或换平台包命名
（`bin` 变成 `{ tsc, tsgo }` 之类）时它会红。红的时候先看上游 changelog，
再决定是放宽断言还是跟进新布局，别直接把断言删掉。
