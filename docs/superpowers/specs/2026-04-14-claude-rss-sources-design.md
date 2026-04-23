# Claude RSS 源设计说明

日期：2026-04-14
最后更新：2026-04-23

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

本期只覆盖以下 3 个源：

- `https://claude.com/blog/category/claude-code`
- `https://claude.com/blog/category/agents`
- `https://code.claude.com/docs/en/changelog`

本期明确不做：

- 聚合总 Feed
- 全量网页归档
- 本地保存博客全文
- 实时更新
- 通用爬虫平台化
- 智能体源生成（归入后续版本）

## 3. 总体方案

采用一个小型 TypeScript 项目，按"源类型"分别实现解析逻辑：

- 两个博客分类页走 HTML 抓取与解析
- changelog 走上游 markdown 源解析
- 所有源统一整理成同一种内部数据结构
- 再分别渲染成 3 个 RSS XML 文件

发布方式：

- GitHub Actions 负责定时执行
- XML 文件由 Actions 直接上传为 Pages Artifact，不写入 Git 仓库
- GitHub Pages 负责对外托管

这个方案的重点是：

- 结构简单
- 改动边界清晰
- 新增源时只需要增加对应解析模块

## 4. 数据流

每次执行的流程如下：

1. 拉取所有源内容
2. 按源类型解析出条目
3. 归一化为统一的内部条目结构
4. 渲染为 RSS XML 文件，写入本地 `public/` 目录
5. 由 GitHub Actions 将 `public/` 上传为 Pages Artifact
6. `deploy-pages` Action 将 Artifact 发布到 GitHub Pages

关键约定：

- XML 文件只存在于 Actions 运行时的临时磁盘上，**不提交到 Git**
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
type FeedItem = {
  id: string
  title: string
  url: string
  publishedAt: string  // ISO-8601
  summary?: string
  contentHtml?: string
  source: "claude-code" | "agents" | "claude-code-changelog"
}
```

字段约束：

- `id` 必须稳定，不能随运行变化
- `publishedAt` 统一使用 ISO-8601
- `summary` 主要用于博客分类页
- `contentHtml` 主要用于 changelog 条目内容

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
src/
  sources/
    claudeCategory.ts     # 博客分类页抓取与解析
    claudeChangelog.ts    # changelog markdown 解析
  render/
    rss.ts                # RSS XML 渲染
  types.ts                # 公共类型定义
  update.ts               # 更新任务总入口
test/
  fixtures/               # 解析测试用的最小 HTML / markdown 片段
  claudeCategory.test.ts
  claudeChangelog.test.ts
  rss.test.ts
.github/
  workflows/
    update-feeds.yml      # 定时更新 + 发布
docs/
  superpowers/specs/      # 设计文档
```

职责划分如下：

- `sources/`：各源的抓取与解析
- `types.ts`：公共类型
- `render/rss.ts`：RSS 渲染
- `update.ts`：一次更新任务的总入口

## 9. 部署设计

部署方案：

- 代码托管在 GitHub
- 定时任务运行在 GitHub Actions
- XML 由 Actions 上传 Pages Artifact，**不经过 git commit**
- GitHub Pages 负责对外服务

工作流（单个 `update` Job）：

1. checkout 代码
2. `npm install`
3. `npm test`（先跑测试）
4. `npm start`（生成 `public/*.xml`）
5. `upload-pages-artifact path: public/`
6. `deploy-pages`

不再有独立的 `deploy` Job，也不再有向 Git 提交的步骤。

## 10. 失败处理

失败处理原则是"源级隔离"：

- 某个源失败，不影响其他源继续生成
- 采用 `Promise.allSettled` 确保所有源独立运行
- 任一源失败时，进程以非零状态退出，Actions 标记为失败
- 由于 XML 不提交到 Git，失败时不存在"用旧结果兜底"的概念；上一次成功部署的结果仍然对外有效，直到下次成功部署覆盖

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

### 12.1 手写解析器模式（当前）

后续新增源时，优先沿用当前模式：

- 每个源单独建模块
- 共享抓取、日期处理和 RSS 渲染能力
- 当某个源必须依赖浏览器执行时，再单独引入 Playwright，不影响其他源

### 12.2 智能体生成解析器模式（规划中）

对于难以手写解析逻辑的新源，未来可引入智能体辅助生成：

**触发方式：**

在仓库 `sources/` 目录下提交一个 YAML 文件（如 `sources/my-blog.yml`），包含目标 URL 和 slug，即可触发 Actions 工作流启动智能体生成流程。

**智能体行为：**

由 `scripts/generate-source.ts` 实现一个完整的智能体循环（agent loop），使用 Anthropic SDK 调用 Claude：

- 工具集：`fetch_html`（HTTP 抓取）、`fetch_with_browser`（Playwright 无头浏览器，懒加载）、`run_code`（执行候选脚本验证输出）、`write_scraper`（写出最终脚本）
- 模型：`claude-opus-4-7`，启用 adaptive thinking
- 循环退出条件：调用 `write_scraper` 工具，或达到最大轮次

**生成产物：**

- 输出文件：`src/sources/generated/{slug}.ts`
- 结构与手写解析器一致，导出 `fetchFeed(config): Promise<FeedItem[]>`

**缓存与失效：**

- 已生成的脚本直接复用，无需重复生成
- 脚本运行时出现硬错误（HTTP 失败、解析崩溃）时，自动删除脚本并在下次 Actions 运行时重新生成
- 输出静默但内容明显不对时，由用户手动删除脚本触发重新生成

**验证合约（强制）：**

生成的脚本必须满足：

- 返回至少 1 条 `FeedItem`
- 每条 `FeedItem` 包含非空的 `id`、`title`、`url`、`publishedAt`
- `publishedAt` 可被 `new Date()` 解析为有效日期

验证不通过视为硬错误，与运行崩溃等同处理。

## 13. V1 成功标准

满足以下条件即可认为 V1 完成：

- 本地可以生成 3 个 Feed
- GitHub Actions 可以按日更新
- 普通 RSS 阅读器可以直接订阅公开 URL
- 源内容没有变化时，不产生无意义更新
- 单个源失败时，不会破坏其他已发布结果
