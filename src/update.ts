import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import { createHash } from "node:crypto"
import { parse as parseYaml } from "yaml"
import { renderRss } from "./render/rss.js"
import { renderIndexHtml } from "./render/index-html.js"
import type { FeedConfig, FeedItem, ScraperHelpers } from "./types.js"
import { validateItems } from "./validate.js"
import { GENERATOR_FORMAT_VERSION } from "../scripts/generate-source.js"

const PAGES_BASE = "https://xc1427.github.io/perso-rss-agentic"
const SOURCES_DIR = "sources"
const GENERATED_DIR = "src/sources/generated"
// Header line written at the top of every generated scraper. The hash binds
// the file to the source-config snapshot it was generated from; if the YAML
// changes, the hash mismatches and the cached file is discarded.
const SOURCE_HASH_HEADER_RE = /^\/\/ SOURCE_HASH: ([a-f0-9]+)\b/

interface SourceYaml {
  slug: string
  feedTitle: string
  feedDescription: string
  url: string
  // Free-form per-source guidance injected into the scraper-generator prompt.
  // Not visible to the runtime scraper — purely a generation-time escape hatch.
  agentHints?: string
}

type LoadedSource = { config: FeedConfig; agentHints?: string; sourceHash: string }

type ScraperModule = { fetchFeed: (config: FeedConfig, helpers: ScraperHelpers) => Promise<FeedItem[]> }

function computeSourceHash(yml: SourceYaml): string {
  // Only the fields that influence generation belong in the hash. Derived
  // fields (feedUrl, outputXml) are intentionally excluded — their values are
  // a pure function of slug, so they add nothing. The format version is mixed
  // in so structural contract bumps invalidate every cached scraper at once.
  const canonical = JSON.stringify({
    formatVersion: GENERATOR_FORMAT_VERSION,
    slug: yml.slug,
    feedTitle: yml.feedTitle,
    feedDescription: yml.feedDescription,
    url: yml.url,
    agentHints: yml.agentHints ?? null,
  })
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16)
}

function readCachedSourceHash(slug: string): string | null {
  const filePath = `${GENERATED_DIR}/${slug}.ts`
  if (!existsSync(filePath)) return null
  const firstLine = readFileSync(filePath, "utf-8").split("\n", 1)[0] ?? ""
  return firstLine.match(SOURCE_HASH_HEADER_RE)?.[1] ?? null
}

function loadConfigs(): LoadedSource[] {
  const files = readdirSync(SOURCES_DIR).filter((f) => f.endsWith(".yml"))
  return files.map((file) => {
    const raw = readFileSync(`${SOURCES_DIR}/${file}`, "utf-8")
    const yml = parseYaml(raw) as SourceYaml
    const config: FeedConfig = {
      slug: yml.slug,
      feedTitle: yml.feedTitle,
      feedDescription: yml.feedDescription,
      url: yml.url,
      feedUrl: `${PAGES_BASE}/${yml.slug}.xml`,
      outputXml: `public/${yml.slug}.xml`,
    }
    const sourceHash = computeSourceHash(yml)
    return yml.agentHints
      ? { config, agentHints: yml.agentHints, sourceHash }
      : { config, sourceHash }
  })
}

async function loadScraper(
  slug: string,
  config: FeedConfig,
  agentHints: string | undefined,
  sourceHash: string
): Promise<ScraperModule> {
  // Cache invalidation: if the cached scraper's header hash doesn't match the
  // current source config, drop it before the import attempt. A missing
  // header (legacy scraper) is treated as a mismatch — we don't know what it
  // was generated from, so we regenerate to bind it to the current config.
  const cachedHash = readCachedSourceHash(slug)
  if (cachedHash !== sourceHash) {
    const generatedPath = `${GENERATED_DIR}/${slug}.ts`
    if (existsSync(generatedPath)) {
      const reason = cachedHash
        ? `source config changed (cached=${cachedHash}, current=${sourceHash})`
        : `cached scraper has no SOURCE_HASH header — regenerating to bind it to the current config`
      console.log(`  Invalidating cached scraper for ${slug}: ${reason}`)
      rmSync(generatedPath)
    }
  }

  // Try cached generated scraper
  try {
    return await import(`./sources/generated/${slug}.js`) as ScraperModule
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== "ERR_MODULE_NOT_FOUND") {
      // The file exists but is broken (syntax error, bad import). Surface it
      // instead of silently regenerating — a poisoned cached scraper would
      // otherwise be regenerated on every run.
      console.error(`  Cached scraper for ${slug} failed to load: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Auto-generate via Anthropic agent
  console.log(`  No scraper found for ${slug} — generating via agent...`)
  const { generateScraper } = await import("../scripts/generate-source.js")
  await generateScraper(slug, config, agentHints, sourceHash)
  return await import(`./sources/generated/${slug}.js`) as ScraperModule
}

function writeFeed(filePath: string, content: string): void {
  const dir = dirname(filePath)
  if (dir) mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, content, "utf-8")
  console.log(`  written: ${filePath}`)
}

// One Playwright browser shared across all sources for the duration of the
// run. Lazily provisioned on the first `helpers.fetchPage` call so SSR-only
// runs don't pay the launch cost. Closed in the top-level finally below.
let browserInstance: unknown | null = null

async function getBrowser(): Promise<any> {
  if (browserInstance) return browserInstance
  // Use a string variable so TypeScript doesn't statically resolve this optional dep.
  const playwrightId: string = "playwright"
  const pw = (await import(playwrightId)) as any
  browserInstance = await pw.chromium.launch()
  return browserInstance
}

async function fetchPage(url: string): Promise<string> {
  const browser = await getBrowser()
  const page = await browser.newPage()
  try {
    await page.goto(url, { timeout: 30_000 })
    // Same load-state strategy as fetch_with_browser: prefer networkidle but
    // don't hang on long-poll sites — fall back to domcontentloaded.
    await page
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => page.waitForLoadState("domcontentloaded", { timeout: 5_000 }))
      .catch(() => undefined)
    return (await page.content()) as string
  } finally {
    await page.close().catch(() => undefined)
  }
}

const helpers: ScraperHelpers = { fetchPage }

async function updateFeed(loaded: LoadedSource): Promise<void> {
  const { config, agentHints, sourceHash } = loaded
  const scraper = await loadScraper(config.slug, config, agentHints, sourceHash)

  let items: FeedItem[]
  try {
    items = await scraper.fetchFeed(config, helpers)
    validateItems(items, config.slug)
  } catch (err) {
    const generatedPath = `${GENERATED_DIR}/${config.slug}.ts`
    if (existsSync(generatedPath)) {
      // The in-process ESM module cache still holds this module after deletion.
      // Safe only because the process exits before any retry — never re-import the same slug in-process.
      rmSync(generatedPath)
      console.error(`  Deleted broken generated scraper: ${generatedPath}`)
    }
    throw err
  }

  writeFeed(config.outputXml, renderRss(items, config))
}

const sources = loadConfigs()

let results: PromiseSettledResult<FeedConfig>[]
try {
  results = await Promise.allSettled(
    sources.map(async (loaded) => {
      try {
        await updateFeed(loaded)
        console.log(`✓ ${loaded.config.slug}`)
        return loaded.config
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`✗ ${loaded.config.slug}: ${msg}`)
        throw err
      }
    })
  )
} finally {
  if (browserInstance) {
    await (browserInstance as any).close().catch(() => undefined)
  }
}

const succeeded = results
  .filter((r): r is PromiseFulfilledResult<FeedConfig> => r.status === "fulfilled")
  .map((r) => r.value)

if (succeeded.length > 0) {
  writeFeed("public/index.html", renderIndexHtml(succeeded))
}

const failed = results.filter((r) => r.status === "rejected").length
if (failed > 0) {
  console.error(`\n${failed} source(s) failed.`)
  process.exit(1)
}
