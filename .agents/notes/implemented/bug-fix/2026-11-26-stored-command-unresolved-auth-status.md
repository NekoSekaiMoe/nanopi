# Agent Note: 存储 !command 凭据解析失败不再与解析成功混为 configured

Status: implemented

## Problem

Issue #816（上游 #12164）：`getProviderAuthStatus()` 只看 `storedProviders` 里有没有 provider id 就返回 `{ configured: true, source: "stored" }`，不校验存储凭据里的 `!command` 能不能解析出值。于是 `auth.json` 里存了 `!printf ''`（空输出）或失败的 shell 命令时，`/login` 的 provider 行仍显示 ✓ configured，用户以为能用，真正发请求时 `getAuth()` 才返回 undefined。

本地复现（models.json 定义 provider + 存储 `!command` 凭据）：
- 命令成功：`checkAuth()` 返回 `{ type: "api_key", source: "stored credential" }`，`getAuth()` 拿到 key，状态 `configured: true / stored`。
- 命令失败：`checkAuth()` 返回 `undefined`，`getAuth()` 返回 `undefined`，状态**仍是** `configured: true / stored`。

可用性检查其实已经知道两者的差别（`runAvailabilityPass()` 把失败的 check 从 `snapshot.auth` 里删掉），只是 `getProviderAuthStatus()` 在查 `snapshot.auth` 之前先被 `storedProviders` 短路了。

## Decision

在快照里新增 `unresolvedStoredProviders`，把「有记录但解析失败」和「解析成功」建成两个可区分的状态：

- `runAvailabilityPass()` 每次跑完，对本轮成功检查、又在 `storedProviders` 里的 provider：check 有值就从 unresolved 集合里移除，check 为空就加进去；再统一删掉已无存储凭据或已有 auth check 的 id。这样集合只装「有存储记录、且最近一次检查确实没解析出 auth」的 provider。
- `getProviderAuthStatus()` 先查该集合，命中就返回 `{ configured: false, source: "stored", unresolved: true }`；否则沿用原来的 `storedProviders → configuredRequestAuthStatus → snapshot.auth` 顺序。
- `AuthStatus` 增加可选 `unresolved?: boolean`，供 UI/诊断在未来把它渲染成 `stored key did not resolve` 之类的提示（本次不接 UI 文案，先把状态语义拆开）。

关键约束：只有「本轮检查过且 check 为空」才算失败。新注册的 provider、检查尚未跑完、或可用性检查超时/报错的 provider 不进这个集合，仍按有记录处理。这样避免把「还没验证」误判成「验证失败」，也保住 provider 尚未注册时（如 #7301 的 stale-provider）有存储凭据即 configured 的既有契约。

## Alternatives considered

- **`getProviderAuthStatus()` 里直接调用 `resolveConfigValue()` 校验命令**：这是同步 getter，跑 shell 会阻塞调用方（`/login` 构建 selector、`diagnostic-bundle` 拼诊断都会调），还会和可用性检查重复执行有副作用的 `!command`。否决。
- **让 `check()` 对 `!command` 实际执行命令（上游 #12454 的另一种打法）**：`check()` 的语义是「凭据来源已登记」，被 `auth-check.ts` 的 `invalid_state` 判断和 `markProvisionallyConfigured()` 的兜底共用；改它会把「命令暂时失败」升级成「配置错误」，影响面远超一处状态显示。否决，改用独立的快照集合表达「最近一次解析失败」。
- **存储凭据一律按 `snapshot.auth` 判定，去掉 `storedProviders` 短路**：可用性检查是异步且有超时/失败路径的，检查未跑完时 provider 会短暂显示未配置；#7301 的场景里 provider 根本没注册，`snapshot.auth` 永远没有它的条目。否决，保留 `storedProviders` 作为兜底，只附加 unresolved 标记。

## Consequences

- `getProviderAuthStatus()` 对「存储 `!command` 解析失败」从 `configured: true` 变为 `configured: false / unresolved: true`。`/login` selector 不再显示 ✓ configured；这是本次要的行为变化。
- `unresolved` 目前只落进 `AuthStatus`，`interactive-mode` 的 selector 仍未把它渲染成专门文案；接文案时可先用这个标志区分「完全没配置」和「有记录但没解析出来」。
- 回归测试 `packages/coding-agent/test/stored-command-auth-status.test.ts` 覆盖两例：命令成功 → configured，命令失败（空输出）→ configured:false + unresolved:true，并核对 `checkAuth()`/`getAuth()` 的表现一致。
- 验证：`pnpm exec vitest --run test/stored-command-auth-status.test.ts`（2 passed），`test/suite/regressions/7301-stalled-availability-refresh.test.ts`（3 passed），`test/model-registry.test.ts`（88 passed）均通过。
