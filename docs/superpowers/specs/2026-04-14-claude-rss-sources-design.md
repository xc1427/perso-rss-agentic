# Claude RSS 源设计说明

日期：2026-04-14

## 1. 目标

本仓库用于维护一个个人 RSS 生成管线，把原本没有合适 RSS 的网页整理成可订阅的 RSS Feed。

V1 的目标是：

- 产出 3 个独立 RSS Feed
- 每天自动更新一次
- 公开发布，便于直接被 RSS 阅读器订阅
- 用一个小型代码仓库完成，便于后续继续加源
- 当某个源抓取或解析失败时，不破坏其他源的已发布结果

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

## 3. 总体方案

采用一个小型 TypeScript 项目，按“源类型”分别实现解析逻辑：

- 两个博客分类页走 HTML 抓取与解析
- changelog 走上游 markdown 源解析
- 所有源统一整理成同一种内部数据结构
- 再分别渲染成 3 个 RSS XML 文件

发布方式：

- GitHub Actions 负责定时执行
- GitHub Pages 负责托管生成后的 XML 文件

这个方案的重点是：

- 结构简单
- 改动边界清晰
- 新增源时只需要增加对应解析模块

## 4. 数据流

每次执行的流程如下：

1. 拉取所有源内容
2. 按源类型解析出条目
3. 归一化为统一的内部条目结构
4. 生成 JSON 快照与 RSS XML
5. 仅在生成结果变化时才更新产物
6. 将 `public/` 目录发布出去

## 5. 源设计

### 5.1 Claude Code 博客分类页

源地址：

- `https://claude.com/blog/category/claude-code`

处理方式：

- 抓取页面 HTML
- 提取页面中的文章卡片
- 提取标题、文章链接、发布日期，以及可用的摘要
- 使用文章链接作为稳定 ID

输出文件：

- `data/claude-code.json`
- `public/claude-code.xml`

### 5.2 Agents 博客分类页

源地址：

- `https://claude.com/blog/category/agents`

处理方式：

- 与 Claude Code 分类页共用同一类解析逻辑
- 使用独立配置区分 URL、标题与输出路径
- 使用文章链接作为稳定 ID

输出文件：

- `data/agents.json`
- `public/agents.xml`

### 5.3 Claude Code Changelog

源定义：

- 以 changelog 的 markdown 源作为解析输入

处理方式：

- 拉取 markdown 内容
- 按版本分段
- 提取版本号、日期和版本说明
- 使用版本号作为稳定 ID

输出文件：

- `data/claude-code-changelog.json`
- `public/claude-code-changelog.xml`

## 6. 内部数据模型

所有源统一转换为如下结构：

```ts
type FeedItem = {
  id: string
  title: string
  url: string
  publishedAt: string
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

公开产物：

- `public/claude-code.xml`
- `public/agents.xml`
- `public/claude-code-changelog.xml`

内部快照：

- `data/claude-code.json`
- `data/agents.json`
- `data/claude-code-changelog.json`

约定：

- XML 是对外订阅入口
- JSON 是内部检查与调试材料
- Feed 只保留面向订阅的最近一段内容
- 更长历史保留在内部 JSON，不强行塞进 RSS 主输出

## 8. 仓库结构

建议目录如下：

- `src/sources/claudeCategory.ts`
- `src/sources/claudeChangelog.ts`
- `src/types.ts`
- `src/render/rss.ts`
- `src/update.ts`
- `test/fixtures/`
- `test/`
- `data/`
- `public/`
- `.github/workflows/update-feeds.yml`

职责划分如下：

- `sources/`：各源的抓取与解析
- `types.ts`：公共类型
- `render/rss.ts`：RSS 渲染
- `update.ts`：一次更新任务的总入口

## 9. 部署设计

部署方案：

- 代码托管在 GitHub
- 定时任务运行在 GitHub Actions
- 生成后的 XML 由 GitHub Pages 对外提供

工作流要求：

- 支持每日定时执行
- 支持手动触发
- 先跑测试，再执行生成
- 只有结果变化时才更新产物

## 10. 失败处理

失败处理原则是“源级隔离”：

- 某个源失败，不影响其他源继续生成
- 某个源失败时，不用空结果覆盖上一次成功产物
- 只有当本次生成成功时，才替换对应输出

实现要求：

- 错误信息要带源名
- 文件写入要避免半写状态
- 不做不必要的部分提交

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

后续新增源时，优先沿用当前模式：

- 每个源单独建模块
- 共享抓取、日期处理和 RSS 渲染能力
- 当某个源必须依赖浏览器执行时，再单独引入 Playwright，不影响其他源

这样可以保证：

- 当前版本保持简单
- 后续扩展不需要推翻整体结构

## 13. V1 成功标准

满足以下条件即可认为 V1 完成：

- 本地可以生成 3 个 Feed
- GitHub Actions 可以按日更新
- 普通 RSS 阅读器可以直接订阅公开 URL
- 源内容没有变化时，不产生无意义更新
- 单个源失败时，不会破坏其他已发布结果
