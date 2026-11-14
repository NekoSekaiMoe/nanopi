# Agent Note: 笔记里的测试路径带包前缀，命令示例例外

Status: implemented

## Problem

198 篇笔记里，测试路径有两种写法并存：

- 裸写法（`test/` 开头、不带包名）：46 篇、74 处，去重 64 个路径。
- 带前缀 `packages/<pkg>/test/…`：49 篇、65 处。
- 7 篇两种都写。

裸写法今天**恰好**都解析得通：64 个去重路径里有 62 个在 `packages/*/test/` 下唯一命中。这个「唯一」不是设计，是运气——`packages/agent` 现在没有 `tools.test.ts`，谁加一个，所有裸 `tools.test.ts` 立刻变成两义。

笔记从仓库根读，读者没有「我在哪个包里」的先验。归一下包名就要 62 次 `find`。

另外两处是过时事实，不是风格问题：`implemented/simplification/2026-10-11-remove-chord-evals-telemetry.md` 引的 `packages/ai/test/telemetry-options.test.ts` 随 `92babce71` 删了，`implemented/simplification/2026-10-12-apply-patch-edit-mutual-exclusion-prompt-trim.md` 引的 `packages/coding-agent/test/pi-fake-codex-apply-patch.test.ts` 随 `96ad1e846` 删了。两篇正文本身就是在讲删它们，引用是历史证据。

## Decision

**散文里引用测试文件一律写 `packages/<pkg>/test/<path>`。** 两个例外：

1. **命令示例保留裸写。** 所在的段落里有 `pnpm vitest` / `pnpm exec vitest` / `pnpm run test` / `vitest` / `cd packages/<pkg>` / `--filter <pkg>`，归属由命令本身给出。段落而非行——`pnpm exec vitest --run a b c` 会折行。`AGENTS.md` 的 `pnpm exec vitest --run` 加裸 `test/specific.test.ts`、末尾注明 from the package root，属于这一档，不动。代码块整段不查——那里是命令和输出，不是散文。
2. **已删除的测试照写全路径并标注。** 形如 `packages/<pkg>/test/foo.test.ts`（已删除，随 `<commit>`）。上面两处按这个形式改掉，正文其余判断不动。

**门禁加在 `verify-agent-note-tree.ts`**（散文裸路径 → 报错 + 建议路径），不落在 `verify-agent-note-format.ts`：那边只管头块和骨架，「正文里引用的事实对不对」是树这侧的活。

建议路径靠磁盘索引：`packages/*/test/**/*.ts` 里唯一命中就给 `packages/<pkg>/test/<rel>`，命中不到或撞名多于一个就给 `packages/<pkg>/test/<rel>`（`<pkg>` 留空）让人自己补——猜一个包名比不猜更坏，这正是要消灭的那类运气。

**同批把 65 处裸路径机械刷成带前缀。** 脚本按磁盘索引映射，映射不到的两处人工处理成「已删除」形式，diff 只碰路径与这两个句子的措辞。

## Why a gate and not prose discipline

散文纪律会腐化，而且腐化得无声：以后新写的笔记照旧裸写，读者照旧要猜，没人会红。这条规则的特殊之处是**它完全可以机械判定**——裸路径就在正文里，包归属就在磁盘上，不存在「值不值得带前缀」的语义判断。凡是能机械判的就别交给自觉，这与 `check-agent-notes` 那条不失败提醒的分工不同：提醒判不了的事才归人。

误报面也小：命令上下文按段落识别，模式收窄到「真的在跑测试或 cd 进包」，代码块整段跳过。三次实测（带前缀、已删除形式、`pnpm exec vitest --run test/…` 折行示例）都不报，「`pnpm run build`, and `test/webui-auth.test.ts`」这种提一句 build 的散文照报——第一版把 `pnpm` 单列成关键词时它被漏过去了。

## Alternatives considered

**一律不查正文，只写在 `references/note-format.md` 里当散文纪律。** 最省事，也最确定会腐化：这次能刷完 65 处，下次新笔记没人看规则就白刷。而且这条规则判得死，没有 `check-agent-notes` 那种「该不该写笔记」的模糊地带。

**放进 `verify-agent-note-format.ts`。** 那个脚本的职责是头块与骨架（行 1-3、`## Problem` 是否首节、`## Alternatives considered` 是否存在），全是单篇内部的结构事实。正文里的路径指向仓库别处的真实文件，属于跨文件事实，放树这一侧更合适，也和现有的「笔记间相对链接是否存在」同类。

**刷路径单独开 PR，先只落规则。** 规则和存量不一致的话门禁一落地就是红的，红着也修不了自己——198 篇里 74 处违规，没人会照着报错一条条改。规则与存量必须同一批落地，这和被否掉的做法正好相反。

**把裸写法统一改成「相对笔记自身位置」。** 笔记在 `.agents/notes/implemented/<class>/`，从那里到 `packages/*/test/` 要 `../../../../`，比包前缀更难读，也更难机械校验。

## Consequences

- 门禁红了有明确修法：报错里直接给建议路径，复制粘贴即可。
- 磁盘索引每次校验遍历 `packages/*/test`，198 篇笔记下耗时仍是毫秒级；代价随测试文件数线性增长，可接受。
- 命令示例例外靠正则，不完美：一段散文里写到 `vitest` 的行内提及就会整段放过。宁可漏报，不要为了抓漏逼人把命令拆成多段。
- 「已删除」形式不在脚本校验范围内（`verify-agent-note-tree` 只查笔记间 Markdown 链接），所以它既不会被误判成死链，也不会被发现写错——这是有意接受的缺口。
- `packages/<pkg>` 的包名拼错也不会被脚本抓到，同上：脚本只判「有没有前缀」，不判「前缀对不对」。
