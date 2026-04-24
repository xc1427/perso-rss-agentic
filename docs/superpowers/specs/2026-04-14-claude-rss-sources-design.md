# Claude RSS 源设计说明

日期：2026-04-14
最后更新：2026-04-24

## 1. 目标

本仓库用于维护一个个人 RSS 生成管线，把原本没有合适 RSS 的网页整理成可订阅的 RSS Feed。

V1 的目标是：

- 产出 3 个独立 RSS Feed
- 每天自动更新一次
- 公开发布，便于直接被 RSS 阅读器订阅
- 用一个小型代码仓库完成，便于后续继续加源
- 当某个源抓取或解析失败时，不破坏其他源的已发布结果

长期方向是：支持用智能体（Agentic）方式自动为新 URL 生成对应的抓取解析脚本，减少人工编写解析逻辑的负担。

## 2. V1 范围

本期覆盖以下 3 个源：

- `https://claude.com/blog/category/claude-code`
- `https://claude.com/blog/category/agents`
- `https://code.claude.com/docs/en/changelog`

本期明确不做：

- 聚合总 Feed
- 全量网页归档
- 本地保存博客全文
- 实时更新
- 通用爬虫平台化

注：智能体源生成已在本期实现（参见第 12.2 节）。

## 3. 总体方案

采用一个小型 TypeScript 项目，按"源类型"分别实现解析逻辑：

- 两个博客分类页走 HTML 抓取与解析
- changelog 走上游 markdown 源解析
- 所有源统一整理成同一种内部数据结构
- 再分别渲染成 3 个 RSS XML 文件

新增源的方式：

- 在仓库根目录 `sources/` 下提交一个 YAML 配置文件
- Actions 运行时若没有现成解析器，自动调用智能体生成

发布方式：

- GitHub Actions 负责定时执行
- XML 文件由 Actions 直接上传为 Pages Artifact，不写入 Git 仓库
- GitHub Pages 负责对外托管

## 4. 数据流

每次执行的流程如下：

1. 读取 `sources/*.yml`，构建源配置列表
2. 为每个源动态加载解析器（手写 → 已生成 → 智能体生成）
3. 抓取并解析内容，归一化为统一的内部条目结构
4. 验证条目合法性
5. 渲染为 RSS XML 文件，写入本地 `public/` 目录
6. 由 GitHub Actions 将 `public/` 上传为 Pages Artifact
7. `deploy-pages` Action 将 Artifact 发布到 GitHub Pages

关键约定：

- XML 文件只存在于 Actions 运行时的临时磁盘上，**不提交到 Git**
- 生成的解析器脚本（`src/sources/generated/*.ts`）**提交到 Git** 以缓存复用
- 无 JSON 快照；不需要调试时直接查看 Actions 运行日志

## 5. 源设计

### 5.1 Claude Code 博客分类页

源地址：

- `https://claude.com/blog/category/claude-code`

处理方式：

- 抓取页面 HTML
- 提取页面中的文章卡片（优先 `<article>` 元素，兜底用 `a[href*="/blog/"]`）
- 提取标题、文章链接、发布日期，以及可用的摘要
- 使用文章链接作为稳定 ID

输出文件（仅存在于 Actions 临时环境）：

- `public/claude-code.xml`

### 5.2 Agents 博客分类页

源地址：

- `https://claude.com/blog/category/agents`

处理方式：

- 与 Claude Code 分类页共用同一类解析逻辑
- 使用独立配置区分 URL、标题与输出路径
- 使用文章链接作为稳定 ID

输出文件（仅存在于 Actions 临时环境）：

- `public/agents.xml`

### 5.3 Claude Code Changelog

源定义：

- 以 changelog 的 markdown 源作为解析输入

处理方式：

- 拉取 markdown 内容
- 按版本分段
- 提取版本号、日期和版本说明
- 使用版本号构成稳定 ID

输出文件（仅存在于 Actions 临时环境）：

- `public/claude-code-changelog.xml`

## 6. 内部数据模型

所有源统一转换为如下结构：

```ts
type FeedSource = string

type FeedItem = {
  id: string
  title: string
  url: string
  publishedAt: string  // ISO-8601
  summary?: string
  contentHtml?: string
  source: FeedSource
}

type FeedConfig = {
  slug: string          // 源标识符，与 YAML 文件名对应
  feedTitle: string
  feedDescription: string
  siteUrl: string
  feedUrl: string       // 由 slug 计算
  fetchUrl: string
  outputXml: string     // 由 slug 计算
}
```

字段约束：

- `id` 必须稳定，不能随运行变化
- `publishedAt` 统一使用 ISO-8601
- `summary` 主要用于博客分类页
- `contentHtml` 主要用于 changelog 条目内容
- `FeedItem.source` 与 `FeedConfig.slug` 一致

## 7. 输出约定

公开产物（由 GitHub Pages 对外提供）：

- `public/claude-code.xml`
- `public/agents.xml`
- `public/claude-code-changelog.xml`

产物约定：

- XML 文件**不提交到 Git 仓库**，由 GitHub Actions 每次生成后直接上传为 Pages Artifact 再发布
- 无 JSON 快照；牺牲本地调试便利性，换取仓库结构的简洁性
- `public/` 目录已加入 `.gitignore`

## 8. 仓库结构

```
sources/
  claude-code.yml             # 源配置（slug、URL、标题等）
  agents.yml
  claude-code-changelog.yml
scripts/
  generate-source.ts          # 智能体生成循环（Anthropic SDK）
src/
  sources/
    claude-code.ts            # 手写解析器 wrapper
    agents.ts
    claude-code-changelog.ts
    claudeCategory.ts         # 博客分类页抓取与解析逻辑
    claudeChangelog.ts        # changelog markdown 解析逻辑
    generated/
      .gitkeep                # 目录占位，生成的脚本提交到此处
      {slug}.ts               # 智能体生成的解析器（按需创建）
  render/
    rss.ts                    # RSS XML 渲染
  types.ts                    # 公共类型定义
  update.ts                   # 更新任务总入口
test/
  fixtures/                   # 解析测试用的最小 HTML / markdown 片段
  claudeCategory.test.ts
  claudeChangelog.test.ts
  rss.test.ts
.github/
  workflows/
    update-feeds.yml          # 定时更新 + 发布
docs/
  superpowers/specs/          # 设计文档
```

职责划分如下：

- `sources/`：YAML 源配置（一个文件 = 一个源）
- `scripts/generate-source.ts`：智能体生成新源解析器
- `src/sources/`：各源的解析器（手写或生成）
- `src/types.ts`：公共类型
- `src/render/rss.ts`：RSS 渲染
- `src/update.ts`：一次更新任务的总入口

## 9. 部署设计

部署方案：

- 代码托管在 GitHub
- 定时任务运行在 GitHub Actions
- XML 由 Actions 上传 Pages Artifact，**不经过 git commit**
- 生成的解析器脚本**由 Actions 提交到 Git**（带 `[skip ci]` 标签避免循环触发）
- GitHub Pages 负责对外服务

工作流（单个 `update` Job）：

1. checkout 代码
2. `npm install`
3. `npm test`（先跑测试）
4. `npm start`（使用 `ANTHROPIC_API_KEY`，生成 `public/*.xml`；如有新源则自动生成解析器）
5. 提交 `src/sources/generated/` 下的变更（即使 `npm start` 失败也执行，以保留删除操作）
6. `upload-pages-artifact path: public/`
7. `deploy-pages`

所需 Actions 权限：`contents: write`（用于提交生成的解析器）、`pages: write`、`id-token: write`

所需仓库 Secret：`ANTHROPIC_API_KEY`

## 10. 失败处理

失败处理原则是"源级隔离"：

- 某个源失败，不影响其他源继续生成
- 采用 `Promise.allSettled` 确保所有源独立运行
- 任一源失败时，进程以非零状态退出，Actions 标记为失败
- 由于 XML 不提交到 Git，失败时不存在"用旧结果兜底"的概念；上一次成功部署的结果仍然对外有效，直到下次成功部署覆盖

生成解析器的失败处理：

- 解析器运行时出现硬错误（HTTP 失败、解析崩溃、验证不通过）时，自动删除已生成的 `.ts` 文件
- 删除操作由 Actions 的 "Commit generated scrapers" 步骤（`if: always()`）提交到 Git
- 下次 Actions 运行时重新触发智能体生成

## 11. 测试策略

测试重点放在解析稳定性，而不是框架复杂度。

至少包含：

- Claude Code 分类页解析测试
- Agents 分类页解析测试
- changelog markdown 解析测试
- RSS 渲染的基本正确性测试

测试材料建议：

- 用小型 fixture 保存代表性 HTML 或 markdown
- 只保留解析所需的最小输入

## 12. 可扩展性

### 12.1 手写解析器模式

新增源时，优先沿用手写模式：

- 在 `sources/` 下新建 YAML 配置
- 在 `src/sources/{slug}.ts` 实现 `fetchFeed(config): Promise<FeedItem[]>`
- 手写解析器始终优先于生成解析器

### 12.2 智能体生成解析器模式（已实现）

对于没有手写解析器的新源，系统自动调用智能体生成解析器。

**触发方式：**

在仓库 `sources/` 目录下提交一个 YAML 文件（如 `sources/my-blog.yml`），包含目标 URL 和 slug，即可在下次 Actions 运行时自动触发智能体生成。

**解析器加载优先级：**

```
1. src/sources/{slug}.ts（手写，优先）
2. src/sources/generated/{slug}.ts（已生成，缓存复用）
3. scripts/generate-source.ts → 生成并写入 src/sources/generated/{slug}.ts
```

**智能体行为：**

由 `scripts/generate-source.ts` 实现完整的智能体循环（agent loop），使用 Anthropic SDK 调用 Claude：

- 工具集：`fetch_html`（HTTP 抓取）、`fetch_with_browser`（Playwright 无头浏览器，懒加载）、`run_code`（用 tsx 执行候选脚本验证输出）、`write_scraper`（写出最终脚本）
- 模型：`claude-opus-4-7`，启用 extended thinking（budget_tokens: 10000）
- 最大轮次：10 轮
- 循环退出条件：调用 `write_scraper` 工具

**生成产物：**

- 输出文件：`src/sources/generated/{slug}.ts`
- 结构与手写解析器一致，导出 `fetchFeed(config: FeedConfig): Promise<FeedItem[]>`
- 生成后提交到 Git 供后续复用

**缓存与失效：**

- 已生成的脚本直接复用，无需重复生成
- 脚本运行时出现硬错误（HTTP 失败、解析崩溃、验证不通过）时，自动删除脚本并在下次 Actions 运行时重新生成
- 输出静默但内容明显不对时，由用户手动删除脚本触发重新生成

**验证合约（强制）：**

生成的脚本必须满足：

- 返回至少 1 条 `FeedItem`
- 每条 `FeedItem` 包含非空的 `id`、`title`、`url`、`publishedAt`
- `publishedAt` 可被 `new Date()` 解析为有效日期

验证不通过视为硬错误，与运行崩溃等同处理，触发脚本删除与重新生成。

## 13. V1 成功标准

满足以下条件即可认为 V1 完成：

- 本地可以生成 3 个 Feed
- GitHub Actions 可以按日更新
- 普通 RSS 阅读器可以直接订阅公开 URL
- 单个源失败时，不会破坏其他已发布结果
- 新增源只需提交一个 YAML 文件，无需手写解析器

注：由于采用 Artifact 直接发布方案，每次 Actions 运行都会重新部署，即使内容未变化。对个人项目而言，每日幂等部署是可接受的代价。
