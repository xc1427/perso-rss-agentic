# RSS 条目按时间排序

## 背景 (Context)

RSS 阅读器中显示的 Claude Code Changelog 条目顺序不直观（截图中 `2.1.122` 排在 `2.1.123` 之前，且后续顺序近乎随机）。

**已确认的事实**：`src/sources/generated/claude-code-changelog.ts` 中所有条目都使用 `publishedAt: new Date().toISOString()`——所有条目的 `<pubDate>` 完全相同。CHANGELOG.md 本身没有逐条日期，agent 因此回退到了"当前时间"。

**未确认的假设**：当所有 `<pubDate>` 相等时，Inoreader 的展示顺序由什么决定？是 XML 中 `<item>` 的出现顺序？还是 `<guid>`/`<title>`？还是 Inoreader 自己的"首次见到时间"？我们不应当只凭直觉去猜。

**用户硬约束**：禁止针对单个 feed 的临时 hack。可接受的最低方案是"在 sources 中加入 prompt 插入机制——类似插件"，即通过每个源 YAML 注入针对该源的额外提示给生成 agent。

## 阶段一：实证验证 Inoreader 排序行为（先做）

构造 4 个**受控**的静态 RSS XML，部署到 GitHub Pages，让用户在 Inoreader 中订阅观察。

### 4 个测试变体

每个变体一个独立 channel，5 条 item。Title 中显式标注变体名 + 序号，方便用户在 Inoreader 中辨认。`<guid>` 设为唯一字符串。

| 变体 | `<pubDate>` 设置 | XML 中 item 顺序 | 期望观察到的现象（如果 Inoreader 按 pubDate 排，XML 顺序为次级 tiebreaker） |
|---|---|---|---|
| **A** | 5 条全部相同 | `[A1, A2, A3, A4, A5]` | A1 在最上 |
| **B** | 5 条全部相同 | `[B5, B4, B3, B2, B1]` | B5 在最上 |
| **C** | 严格降序、各不相同 | `[C5(最新), C4, C3, C2, C1(最旧)]` | C5 在最上（基线，sanity check） |
| **D** | 严格降序、各不相同 | XML 顺序倒转：`[D1(最旧), D2, D3, D4, D5(最新)]` | D5 在最上（pubDate 主导） |

**判读规则**：

- 若 A 显示 `A1` 在上、B 显示 `B5` 在上：Inoreader 在 pubDate 相同时**确实**用 XML item 顺序作 tiebreaker。⇒ 修复方向：**让 scraper 按"最新在前"的顺序返回 items**（再加一道按 pubDate 降序的稳定排序作保险）。无需为每个 item 编造不同的时间戳。
- 若 A 显示 `A1` 在上、B 也显示 `B1` 在上（或都按字母 / guid 顺序）：tiebreaker 不是 XML 顺序。⇒ 修复方向：**必须为每个 item 生成不同的 `publishedAt`**（如基于 index 单调递减）。
- 若 A 与 B 显示顺序完全混乱、无规律：Inoreader 用了 first-seen-time 一类内部状态。⇒ 修复方向同上：**必须不同 pubDate**。
- C 与 D 都应正确显示 latest-on-top；如果不是，假设"按 pubDate 降序排"本身就不成立，需重新设计。

### 部署机制

`.gitignore` 修改为 `public/*` + `!public/test-sorting-*.xml`（例外），4 个探针 XML 已 commit 到 `claude/sort-rss-by-time-t4Xie` 分支：

- `public/test-sorting-A.xml`
- `public/test-sorting-B.xml`
- `public/test-sorting-C.xml`
- `public/test-sorting-D.xml`

手动触发 `Update RSS Feeds` workflow（`gh workflow run update-feeds.yml --ref claude/sort-rss-by-time-t4Xie`），Pages 部署后可在以下 URL 访问：

```
https://xc1427.github.io/perso-rss-agentic/test-sorting-A.xml
https://xc1427.github.io/perso-rss-agentic/test-sorting-B.xml
https://xc1427.github.io/perso-rss-agentic/test-sorting-C.xml
https://xc1427.github.io/perso-rss-agentic/test-sorting-D.xml
```

用户在 Inoreader 中订阅 A/B/C/D 四个 URL，记录每个 feed 内 5 条 item 的实际显示顺序，反馈结果，然后进入阶段二。

## 阶段二：根据观察结果选定真正的修复

### 共通改动（无论观察如何都做）

**(a) `update.ts` 加一道按 pubDate 降序的稳定排序**

在 `validateItems` 之后、`renderRss` 之前：

```ts
items = items
  .map((item, idx) => ({ item, idx }))
  .sort((a, b) => {
    const ta = new Date(a.item.publishedAt).getTime()
    const tb = new Date(b.item.publishedAt).getTime()
    if (tb !== ta) return tb - ta // newest first
    return a.idx - b.idx           // stable: preserve scraper order on ties
  })
  .map(({ item }) => item)
```

**(b) `sources/{slug}.yml` 增加可选 `scraperHints` 字段**

- `src/types.ts`：`FeedConfig` 加 `scraperHints?: string`
- `src/update.ts`：`SourceYaml` 加 `scraperHints?: string`；`loadConfigs()` 透传
- `scripts/generate-source.ts`：当 `config.scraperHints` 存在时，将其原文（逐字、不改写）作为独立块追加到 `userMessage`，用标题包裹：

  ```
  ## Source-specific hints

  ${config.scraperHints}
  ```

**(c) `ARCHITECTURE.md` 补排序约定**

> Scrapers should return items in **newest-first** order. `update.ts` additionally sorts by `publishedAt` (descending, stable) before rendering.

### 分支 1：Inoreader 把 XML 顺序作 tiebreaker（A→A1 在上、B→B5 在上）

根因是 scraper 返回顺序不对，修复：

- `sources/claude-code-changelog.yml` 加 `scraperHints`：
  > CHANGELOG.md 版本从新到旧排列，按文件顺序返回 items（不要重排），pubDate 可以共享 `new Date().toISOString()`。

- 删除 `src/sources/generated/claude-code-changelog.ts` 触发重生成。

### 分支 2：Inoreader 不把 XML 顺序作 tiebreaker

必须为每条 item 生成不同的 `publishedAt`，修复：

- `scripts/generate-source.ts` 全局 prompt 加通用说明：
  > 若 source 无逐条日期，用 `new Date(Date.now() - i * 1000).toISOString()` 按 index 生成单调时间戳，不得让所有 item 共享同一 `Date.now()`。

- `sources/claude-code-changelog.yml` 加 `scraperHints`：
  > CHANGELOG.md 无版本日期，按文件顺序（newest-first）为每条 item 设 `publishedAt = new Date(Date.now() - i * 1000).toISOString()`。

- 删除 `src/sources/generated/claude-code-changelog.ts` 触发重生成。

## 关键文件

阶段一（已完成）：
- `.gitignore`（已修改为 `public/*` + 例外）
- `public/test-sorting-{A,B,C,D}.xml`（已 commit 到分支）

阶段二（共通）：
- `src/types.ts`
- `src/update.ts`
- `scripts/generate-source.ts`
- `ARCHITECTURE.md`

阶段二（按分支）：
- `sources/claude-code-changelog.yml`（加 `scraperHints`）
- `src/sources/generated/claude-code-changelog.ts`（删除，触发重生成）

## 验证

**阶段一**：用户在 Inoreader 中订阅并回报各 feed 的实际显示顺序。

**阶段二**：
1. `npm test` 通过。
2. 本地 `npm start` 触发 changelog scraper 重生成；查 `logs/agent-claude-code-changelog.log` 确认 hints 被逐字注入。
3. 检查重生成的 scraper 与 `public/claude-code-changelog.xml`，确认与所选分支逻辑一致。
4. 用户在 Inoreader 中验证 `2.1.123` 排在 `2.1.122` 之前。
5. 回归：检查 blog feeds 的 `<pubDate>` 与之前一致（它们有真实日期，稳定排序不应影响）。

**清理**：阶段二完成后，删除 4 个 `public/test-sorting-*.xml` 及 `.gitignore` 中的例外行，dispatch 一次 workflow 清掉 Pages 上的测试文件。
