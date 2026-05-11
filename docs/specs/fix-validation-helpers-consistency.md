# 修复：生成阶段验证与生产阶段使用一致的 helpers

## 背景

本文档记录了一次代码审查中发现的设计缺陷，以及对应的修复方向。
该修复应当在 PR 3（`helpers.fetchPage` SPA 修复）合并后，由重构 Agent 更新其计划时一并纳入考量。

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

## 与现有重构计划的关系

`docs/specs/monorepo-refactor.md` 中 **PR 3** 的当前描述如下：

> In `validateGeneratedScraper`: pass a `helpers` mock where `fetchPage` uses
> plain `fetch` (validation runs in-process, no browser needed)

**此描述需要更新。** PR 3 合并后，重构 Agent 应将 PR 3 中关于
`validateGeneratedScraper` 的计划修改为：接收并使用传入的生产 `helpers`，
而非构造 plain `fetch` mock。

## 给重构 Agent 的提示

- 本修复与 PR 3（`helpers.fetchPage` SPA 修复）高度相关，建议在 PR 3
  的实现阶段直接落地，而非单独开 PR。
- PR 3 合并后，请检查 `monorepo-refactor.md` 中 PR 3 的描述并更新，
  确保后续 PR（尤其是 PR 4 monorepo 迁移）的接口设计与本修复一致。
- 在 monorepo 迁移（PR 4）后，`helpers` 的构造位置可能从
  `update.ts` 移动到 `packages/core/src/pipeline.ts`，接口透传逻辑
  需相应调整，但核心原则不变：验证与生产使用同一 `helpers` 实例。
