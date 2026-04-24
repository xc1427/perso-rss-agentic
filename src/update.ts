import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync, rmSync } from "node:fs"
import { parse as parseYaml } from "yaml"
import { renderRss } from "./render/rss.js"
import type { FeedConfig, FeedItem } from "./types.js"

const PAGES_BASE = "https://xc1427.github.io/perso-rss-agentic"
const SOURCES_DIR = "sources"

interface SourceYaml {
  slug: string
  feedTitle: string
  feedDescription: string
  url: string
}

type ScraperModule = { fetchFeed: (config: FeedConfig) => Promise<FeedItem[]> }

function loadConfigs(): FeedConfig[] {
  const files = readdirSync(SOURCES_DIR).filter((f) => f.endsWith(".yml"))
  return files.map((file) => {
    const raw = readFileSync(`${SOURCES_DIR}/${file}`, "utf-8")
    const yml = parseYaml(raw) as SourceYaml
    return {
      slug: yml.slug,
      feedTitle: yml.feedTitle,
      feedDescription: yml.feedDescription,
      url: yml.url,
      feedUrl: `${PAGES_BASE}/${yml.slug}.xml`,
      outputXml: `public/${yml.slug}.xml`,
    }
  })
}

async function loadScraper(slug: string, config: FeedConfig): Promise<ScraperModule> {
  // Try cached generated scraper
  try {
    return await import(`./sources/generated/${slug}.js`) as ScraperModule
  } catch {
    // no-op — fall through to agent generation
  }

  // Auto-generate via Anthropic agent
  console.log(`  No scraper found for ${slug} — generating via agent...`)
  const { generateScraper } = await import("../scripts/generate-source.js")
  await generateScraper(slug, config)
  return await import(`./sources/generated/${slug}.js`) as ScraperModule
}

function validateItems(items: FeedItem[], slug: string): void {
  if (items.length < 1) throw new Error(`${slug}: scraper returned no items`)
  for (const item of items) {
    if (!item.id?.trim()) throw new Error(`${slug}: item missing id`)
    if (!item.title?.trim()) throw new Error(`${slug}: item missing title`)
    if (!item.url?.trim()) throw new Error(`${slug}: item missing url`)
    if (!item.publishedAt?.trim()) throw new Error(`${slug}: item missing publishedAt`)
    if (isNaN(new Date(item.publishedAt).getTime())) {
      throw new Error(`${slug}: invalid publishedAt: ${item.publishedAt}`)
    }
  }
}

function writeFeed(filePath: string, content: string): void {
  const dir = filePath.split("/").slice(0, -1).join("/")
  if (dir) mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, content, "utf-8")
  console.log(`  written: ${filePath}`)
}

async function updateFeed(config: FeedConfig): Promise<void> {
  const scraper = await loadScraper(config.slug, config)

  let items: FeedItem[]
  try {
    items = await scraper.fetchFeed(config)
    validateItems(items, config.slug)
  } catch (err) {
    const generatedPath = `src/sources/generated/${config.slug}.ts`
    if (existsSync(generatedPath)) {
      rmSync(generatedPath)
      console.error(`  Deleted broken generated scraper: ${generatedPath}`)
    }
    throw err
  }

  writeFeed(config.outputXml, renderRss(items, config))
}

const configs = loadConfigs()

const results = await Promise.allSettled(
  configs.map(async (config) => {
    try {
      await updateFeed(config)
      console.log(`✓ ${config.slug}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`✗ ${config.slug}: ${msg}`)
      throw err
    }
  })
)

const failed = results.filter((r) => r.status === "rejected").length
if (failed > 0) {
  console.error(`\n${failed} source(s) failed.`)
  process.exit(1)
}
