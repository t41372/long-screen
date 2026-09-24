# 历史记录索引

这个目录保存已经完成、不再更新的过程性文档：交接日志、review 修复记录、迁移前的评估。它们记录的是写作当时的状态，会和现在的代码不一致；不要把这里的进度、耗时、加速比数字当成当前基线。当前架构、能力边界、测试方法见 `docs/ARCHITECTURE.md`、`docs/CAPABILITIES.md`、`docs/TESTING.md`、`docs/FORMAT.md`。

## 目录

- [2026-09-22-rust-wasm-assessment.md](2026-09-22-rust-wasm-assessment.md) — 迁移前写的评估：为什么要把算法迁到 Rust/Wasm、隔离原型的实测数字、迁移顺序与验收标准。迁移已完成；这份文档记录的是当时还没做、需要论证的状态。
- [2026-09-rust-migration-log.md](2026-09-rust-migration-log.md) — 上面那份评估之后，几轮交接的持续更新日志：逐模块迁移进度、每一轮的基准数字、Safari 崩溃与隐私浏览排查、WebGPU 评估结论。曾经是接手前必读的文档；现在架构已经稳定，先读 `docs/ARCHITECTURE.md`。
- [2026-09-review.md](2026-09-review.md) — 一轮内部代码 review（下称"2026-09 review"）之后，已验证修复与性能记录的汇总。不是 review 本身的完整清单（那份没有单独存档），只是这一轮已经落实的部分。

## `F5`–`F28`、`E1`–`E5`、`P0`/`P1` 是什么

测试文件（尤其 `tests/unit/engine-failure.test.ts`、`tests/unit/layers.test.ts`、`tests/unit/media.test.ts`、`tests/unit/export.test.ts`、`tests/browser/decode.test.ts` 等）里，测试名和注释仍然带着这些标签，例如：

```text
tests/unit/layers.test.ts:70:     // F5: a fixed header at high DPI where the native per-frame displacement is strictly below one analysis pixel
tests/unit/media.test.ts:272:    Deno.test('demux: MP4 E3 — fragmentPackets rejects a tfhd sample-description-index other than 1, ...')
tests/unit/engine-failure.test.ts:236: Deno.test('engine P0: a natural scan EOF before the declared frame count is partial and journaled', ...)
```

这些标签来自 2026-09 review：`F` 大概率是它指出的发现（finding）编号，`E` 是它列出的边界情况（edge case）编号，`P0`/`P1` 是它给的优先级。仓库里能找到的、对这次 review 最完整的记录就是 [2026-09-review.md](2026-09-review.md)，但那份文档本身按主题（已落实的修复）组织，不是按 `F`/`E`/编号列的清单——这次 review 的原始逐条清单没有单独存档，找不到 `F5` 到底对应哪一句原话。可以确定的是：这些标签只是"哪个测试对应 review 指出的哪一条"的追溯记号，不是本仓库自己发明的编号体系；新增测试不必也不应该延续这套编号——它属于那一轮 review，不是一个持续维护的分类法。`grep -rn "\bF[0-9]\+\b\|\bE[0-9]\+\b\|\bP[01]\b" tests/` 能找到当前仍带标签的全部测试。
