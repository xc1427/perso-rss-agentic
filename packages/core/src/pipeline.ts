import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { renderRss } from "./render/rss.js"
import { renderIndexHtml } from "./render/index-html.js"
import { validateItems } from "./validate.js"
import { loadSources, readCachedSourceHash, type LoadedSource } from "./loader.js"
import type { FeedConfig, FeedItem, ScraperHelpers } from "./types.js"

export type RunPipelineOptions = {
  pagesBase: string
  sourcesDir: string
  generatedDir: string
  outputDir: string
}

type ScraperModule = {
  fetchFeed: (config: FeedConfig, helpers: ScraperHelpers) => Promise<FeedItem[]>
}

export async function runPipeline(opts: RunPipelineOptions): Promise<{ failed: number }> {
  const { pagesBase, sourcesDir, generatedDir, outputDir } = opts

  // One Playwright browser shared across all sources for the duration of the
  // run. Lazily provisioned on the first helpers.fetchPage call so SSR-only
  // runs never pay the launch cost. Closed in the top-level finally below.
  let browserInstance: unknown | null = null

  async function getBrowser(): Promise<any> {
    if (browserInstance) return browserInstance
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

  async function loadScraper(
    slug: string,
    config: FeedConfig,
    agentHints: string | undefined,
    sourceHash: string
  ): Promise<ScraperModule> {
    const filePath = resolve(generatedDir, `${slug}.ts`)
    const cachedHash = readCachedSourceHash(filePath)
    if (cachedHash !== sourceHash) {
      if (existsSync(filePath)) {
        const reason = cachedHash
          ? `source config changed (cached=${cachedHash}, current=${sourceHash})`
          : `cached scraper has no SOURCE_HASH header — regenerating to bind it to the current config`
        console.log(`  Invalidating cached scraper for ${slug}: ${reason}`)
        rmSync(filePath)
      }
    }

    const fileUrl = pathToFileURL(filePath).href

    try {
      return (await import(fileUrl)) as ScraperModule
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== "ERR_MODULE_NOT_FOUND") {
        console.error(
          `  Cached scraper for ${slug} failed to load: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }

    console.log(`  No scraper found for ${slug} — generating via agent...`)
    const { generateScraper } = await import("../scripts/generate-source.js")
    await generateScraper(slug, config, agentHints, sourceHash, helpers, generatedDir)
    return (await import(fileUrl)) as ScraperModule
  }

  function writeFeed(filePath: string, content: string): void {
    const dir = dirname(filePath)
    if (dir) mkdirSync(dir, { recursive: true })
    writeFileSync(filePath, content, "utf-8")
    console.log(`  written: ${filePath}`)
  }

  async function updateFeed(loaded: LoadedSource): Promise<void> {
    const { config, agentHints, sourceHash } = loaded
    const scraper = await loadScraper(config.slug, config, agentHints, sourceHash)

    let items: FeedItem[]
    try {
      items = await scraper.fetchFeed(config, helpers)
      validateItems(items, config.slug)
    } catch (err) {
      const filePath = resolve(generatedDir, `${config.slug}.ts`)
      if (existsSync(filePath)) {
        rmSync(filePath)
        console.error(`  Deleted broken generated scraper: ${filePath}`)
      }
      throw err
    }

    writeFeed(config.outputXml, renderRss(items, config))
  }

  const sources = loadSources({ sourcesDir, pagesBase, outputDir })

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
    writeFeed(resolve(outputDir, "index.html"), renderIndexHtml(succeeded))
  }

  const failed = results.filter((r) => r.status === "rejected").length
  if (failed > 0) {
    console.error(`\n${failed} source(s) failed.`)
  }

  return { failed }
}
