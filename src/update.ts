import { writeFileSync, mkdirSync } from "node:fs"
import { fetchCategoryFeed } from "./sources/claudeCategory.js"
import { fetchChangelogFeed, CHANGELOG_URL } from "./sources/claudeChangelog.js"
import { renderRss } from "./render/rss.js"
import type { FeedConfig, FeedItem } from "./types.js"

const PAGES_BASE = "https://xc1427.github.io/perso-rss-agentic"

const CONFIGS: FeedConfig[] = [
  {
    source: "claude-code",
    feedTitle: "Claude Code Blog",
    feedDescription: "Latest posts from the Claude Code blog",
    siteUrl: "https://claude.com/blog/category/claude-code",
    feedUrl: `${PAGES_BASE}/claude-code.xml`,
    fetchUrl: "https://claude.com/blog/category/claude-code",
    outputXml: "public/claude-code.xml",
  },
  {
    source: "agents",
    feedTitle: "Claude Agents Blog",
    feedDescription: "Latest posts from the Claude Agents blog",
    siteUrl: "https://claude.com/blog/category/agents",
    feedUrl: `${PAGES_BASE}/agents.xml`,
    fetchUrl: "https://claude.com/blog/category/agents",
    outputXml: "public/agents.xml",
  },
  {
    source: "claude-code-changelog",
    feedTitle: "Claude Code Changelog",
    feedDescription: "Version updates for Claude Code",
    siteUrl: "https://code.claude.com/docs/en/changelog",
    feedUrl: `${PAGES_BASE}/claude-code-changelog.xml`,
    fetchUrl: CHANGELOG_URL,
    outputXml: "public/claude-code-changelog.xml",
  },
]

async function updateFeed(config: FeedConfig): Promise<void> {
  let items: FeedItem[]

  if (config.source === "claude-code-changelog") {
    items = await fetchChangelogFeed(config.fetchUrl)
  } else {
    items = await fetchCategoryFeed(config.fetchUrl, config.source, config.siteUrl)
  }

  writeIfChanged(config.outputXml, renderRss(items, config))
}

function writeIfChanged(filePath: string, content: string): void {
  const dir = filePath.split("/").slice(0, -1).join("/")
  if (dir) mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, content, "utf-8")
  console.log(`written: ${filePath}`)
}

const results = await Promise.allSettled(
  CONFIGS.map(async (config) => {
    try {
      await updateFeed(config)
      console.log(`✓ ${config.source}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`✗ ${config.source}: ${msg}`)
      throw err
    }
  })
)

const failed = results.filter((r) => r.status === "rejected").length
if (failed > 0) {
  console.error(`\n${failed} source(s) failed.`)
  process.exit(1)
}
