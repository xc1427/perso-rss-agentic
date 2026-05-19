# 修复：生成阶段验证与生产阶段使用一致的 helpers

## 背景

本文档记录了一次代码审查中发现的设计缺陷，以及对应的修复方向。

**当前状态（2026-05-11）：** PR 3（`pr/3-helpers-fetch-page`）已实现
`helpers.fetchPage` 的大部分基础设施，但尚未解决本文描述的问题，
且其 generator prompt 中显式将该问题作为已知限制加以绕过（见下文）。
本修复应直接落地于 PR 3 的实现中，在 PR 3 合并前完成。

## 发现的问题

### 场景描述

`scripts/generate-source.ts` 中的 `write_scraper` 工具在写入爬虫文件后，
会立即在同一进程内调用 `validateGeneratedScraper()` 进行验证。
然而，该验证函数构造的 `helpers` 对象如下：

```typescript
const helpers: ScraperHelpers = {
  fetchPage: async (u: string) => (await fetch(u)).text(),
}
```

即 `helpers.fetchPage` 使用的是普通 `fetch`，**不经过浏览器渲染**。

而在生产阶段（`src/update.ts`），传给爬虫的 `helpers.fetchPage` 使用的是
真实的 Playwright headless browser，会执行 JavaScript、等待 `networkidle`。

### 产生的后果：假阴性（False Negative）

对于以 SPA 方式渲染的网站（无 `__NEXT_DATA__` JSON island，内容须 JS 执行后才出现）：

1. Agent 正确地生成了一个使用 `helpers.fetchPage(url)` 的爬虫（这是正确做法）。
2. 验证阶段调用 `helpers.fetchPage`，但底层是普通 `fetch`，返回的是骨架 HTML。
3. 爬虫从骨架 HTML 中解析不到任何条目，验证失败，文件被删除。
4. Agent 收到失败反馈，被迫放弃正确方案，转而尝试其他方式。

结果：**验证阶段惩罚了 Agent 的正确行为**，形成误导性的反馈循环，
使 Agent 趋向于生成不使用 `helpers.fetchPage` 的爬虫。
这类爬虫在生产环境中面对真实 SPA 页面时，可能返回空结果或数据不完整。

### 根本原因

生成阶段（`generateScraper`）与生产阶段（`update.ts` 的 `updateFeed`）
运行在同一进程中，但二者使用了不同的 `helpers` 实现：

| 阶段 | `helpers.fetchPage` 实现 |
|------|--------------------------|
| 生成时验证（`validateGeneratedScraper`） | 普通 `fetch`（无 JS 渲染） |
| 生产运行（`update.ts`） | Playwright headless browser |

## 提议的修复方案

### 核心思路

将生产阶段使用的 `helpers` 对象从 `update.ts` 传入 `generateScraper()`，
再透传给 `validateGeneratedScraper()`，使验证与生产使用完全相同的实现。

### 接口变更

`generateScraper` 的签名从：

```typescript
generateScraper(slug, config, agentHints, sourceHash): Promise<void>
```

变更为：

```typescript
generateScraper(slug, config, agentHints, sourceHash, helpers: ScraperHelpers): Promise<void>
```

`validateGeneratedScraper` 的签名从：

```typescript
validateGeneratedScraper(filePath, slug, config): Promise<void>
```

变更为：

```typescript
validateGeneratedScraper(filePath, slug, config, helpers: ScraperHelpers): Promise<void>
```

### 调用侧变更

**`src/update.ts`**：在调用 `generateScraper` 时传入已构造好的 `helpers`：

```typescript
await generateScraper(slug, config, agentHints, sourceHash, helpers)
```

**`scripts/generate-source.ts`**：`validateGeneratedScraper` 不再自行构造
mock helpers，直接使用传入的 `helpers`：

```typescript
const items = (await mod.fetchFeed(config, helpers)) as FeedItem[]
```

### 保证

修复后，若一个爬虫通过了生成时验证，则可以保证它是在与生产环境
**完全相同**的 `helpers` 实现下通过的，消除假阴性，反馈循环也将准确反映生产行为。

## PR 3 已完成的部分

PR 3（`pr/3-helpers-fetch-page`，commit `2c0b1c8`）已实现：

- `src/types.ts`：导出 `ScraperHelpers` 类型
- `src/update.ts`：构造带 Playwright 的 `helpers` 对象，传入 `scraper.fetchFeed(config, helpers)`，
  共享 browser 实例，`finally` 中关闭
- `scripts/generate-source.ts`：`GENERATOR_FORMAT_VERSION = "1"` 导出；
  `validateGeneratedScraper` 签名更新为接受 `ScraperHelpers`；
  generator prompt 中说明 `helpers.fetchPage` 的使用场景

## PR 3 尚未解决的部分（本修复的目标）

PR 3 的 `validateGeneratedScraper` 仍构造 plain `fetch` mock，
并在 generator prompt 中将此作为已知限制向 agent 披露：

> *"write_scraper validates it against an in-process `fetch`-backed mock of
> `helpers.fetchPage`, so a scraper that needs a real browser may not validate
> even when it would work in production; degrade gracefully if you must."*

这是一个绕过方案，而非真正的修复。它要求 agent 围绕验证器的缺陷进行设计，
而不是让验证器如实反映生产行为。

## 与现有重构计划的关系

`docs/specs/monorepo-refactor.md` 中 **PR 3** 的 Changes 节描述如下：

> In `validateGeneratedScraper`: pass a `helpers` mock where `fetchPage` uses
> plain `fetch` (validation runs in-process, no browser needed)

**此描述需要更新为本修复的方案。**

## 给重构 Agent 的提示

- **立即行动：** 在 PR 3 合并前，将本修复落地于 `pr/3-helpers-fetch-page` 分支，
  具体改动见"接口变更"节。同时从 generator prompt 中删除上述已知限制的说明，
  因为修复后该限制不再成立。
- **合并后：** 更新 `monorepo-refactor.md` 中 PR 3 的 Changes 节，
  将 `validateGeneratedScraper` 的描述改为"接收并使用传入的生产 `helpers`"。
- **PR 4 monorepo 迁移后：** `helpers` 的构造位置将从 `update.ts`
  移动到 `packages/core/src/pipeline.ts`，接口透传逻辑需相应调整，
  但核心原则不变：验证与生产使用同一 `helpers` 实例。
