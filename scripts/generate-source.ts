import Anthropic from "@anthropic-ai/sdk"
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { FeedConfig, FeedItem } from "../src/types.js"

const MAX_TURNS = 15
const GENERATED_DIR = "src/sources/generated"
const USER_AGENT = "Mozilla/5.0 (compatible; rss-bot/1.0)"
const FETCH_TIMEOUT_MS = 30_000
const RUN_CODE_TIMEOUT_MS = 30_000

type ToolResult = { output: string; success: boolean }
type ToolCtx = { browser: unknown | null }

const TOOLS: Anthropic.Tool[] = [
  {
    name: "fetch_html",
    description: "HTTP GET the URL and return the response body (capped at 80K chars). Use this to inspect the page structure.",
    input_schema: {
      type: "object" as const,
      properties: { url: { type: "string", description: "URL to fetch" } },
      required: ["url"],
    },
  },
  {
    name: "fetch_with_browser",
    description: "Fetch a URL using a headless Chromium browser for JavaScript-heavy pages. Falls back gracefully if playwright is not installed.",
    input_schema: {
      type: "object" as const,
      properties: { url: { type: "string", description: "URL to fetch with headless browser" } },
      required: ["url"],
    },
  },
  {
    name: "run_code",
    description: "Execute TypeScript code with tsx and return stdout+stderr (capped at 10K chars). Use this to test a candidate scraper before finalising it.",
    input_schema: {
      type: "object" as const,
      properties: { code: { type: "string", description: "Complete TypeScript code to execute" } },
      required: ["code"],
    },
  },
  {
    name: "write_scraper",
    description: "Write the candidate scraper to disk. The file is then imported and its fetchFeed() is invoked against the real config; on validation failure the file is deleted and you must try again.",
    input_schema: {
      type: "object" as const,
      properties: { code: { type: "string", description: "Complete TypeScript module to write as the scraper" } },
      required: ["code"],
    },
  },
]

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  slug: string,
  config: FeedConfig,
  ctx: ToolCtx
): Promise<ToolResult> {
  switch (name) {
    case "fetch_html": {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      try {
        const res = await fetch(input.url as string, {
          headers: { "User-Agent": USER_AGENT },
          signal: controller.signal,
        })
        const text = await res.text()
        const body = text.slice(0, 80_000)
        return {
          output: `HTTP ${res.status} ${res.statusText}\n${body}`,
          success: res.ok,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { output: `fetch_html error: ${msg}`, success: false }
      } finally {
        clearTimeout(timer)
      }
    }

    case "fetch_with_browser": {
      try {
        if (!ctx.browser) {
          // Use a string variable so TypeScript doesn't statically resolve this optional dep
          const playwrightId: string = "playwright"
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pw = (await import(playwrightId)) as any
          ctx.browser = await pw.chromium.launch()
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const browser = ctx.browser as any
        const page = await browser.newPage({ userAgent: USER_AGENT })
        try {
          await page.goto(input.url as string, { timeout: FETCH_TIMEOUT_MS })
          // Prefer networkidle but don't hang indefinitely on long-poll sites
          await page
            .waitForLoadState("networkidle", { timeout: 10_000 })
            .catch(() => page.waitForLoadState("domcontentloaded", { timeout: 5_000 }))
            .catch(() => undefined)
          const content = (await page.content()) as string
          return { output: content.slice(0, 80_000), success: true }
        } finally {
          await page.close().catch(() => undefined)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { output: `fetch_with_browser unavailable or failed: ${msg}. Use fetch_html instead.`, success: false }
      }
    }

    case "run_code": {
      const code = input.code as string
      const tmpDir = mkdtempSync(join(tmpdir(), `${slug}-`))
      const tmpFile = join(tmpDir, "candidate.ts")
      writeFileSync(tmpFile, code, "utf-8")
      const result = spawnSync("npx", ["tsx", tmpFile], {
        encoding: "utf-8",
        timeout: RUN_CODE_TIMEOUT_MS,
        cwd: process.cwd(),
      })
      const output = (result.stdout ?? "") + (result.stderr ?? "")
      return {
        output: output.slice(0, 10_000) || "(no output)",
        success: result.status === 0,
      }
    }

    case "write_scraper": {
      const code = input.code as string
      mkdirSync(GENERATED_DIR, { recursive: true })
      const filePath = `${GENERATED_DIR}/${slug}.ts`
      writeFileSync(filePath, code, "utf-8")
      try {
        await validateGeneratedScraper(filePath, slug, config)
        return { output: `Wrote and validated ${filePath}`, success: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        rmSync(filePath, { force: true })
        return {
          output: `Wrote scraper but validation FAILED: ${msg}. File deleted. Inspect the prior tool outputs and try again with a different approach.`,
          success: false,
        }
      }
    }

    default:
      return { output: `Unknown tool: ${name}`, success: false }
  }
}

async function validateGeneratedScraper(filePath: string, slug: string, config: FeedConfig): Promise<void> {
  // Cache-bust so re-imports of the same path during one process see the new file.
  const url = pathToFileURL(resolve(filePath)).href + `?t=${Date.now()}`
  const mod = (await import(url)) as { fetchFeed?: (c: FeedConfig) => Promise<unknown> }
  if (typeof mod.fetchFeed !== "function") {
    throw new Error(`module does not export fetchFeed`)
  }
  const items = (await mod.fetchFeed(config)) as FeedItem[]
  if (!Array.isArray(items)) throw new Error("fetchFeed did not return an array")
  if (items.length < 1) throw new Error("fetchFeed returned 0 items")
  for (const item of items) {
    if (!item?.id?.trim?.()) throw new Error("item missing id")
    if (!item?.title?.trim?.()) throw new Error("item missing title")
    if (!item?.url?.trim?.()) throw new Error("item missing url")
    if (!item?.publishedAt?.trim?.()) throw new Error("item missing publishedAt")
    if (isNaN(new Date(item.publishedAt).getTime())) {
      throw new Error(`invalid publishedAt: ${item.publishedAt}`)
    }
    if (item.source !== slug) {
      throw new Error(`item.source must equal "${slug}", got "${item.source}"`)
    }
  }
}

export async function generateScraper(slug: string, config: FeedConfig): Promise<void> {
  const client = new Anthropic()
  const ctx: ToolCtx = { browser: null }

  const typeDefinitions = `type FeedSource = string

type FeedItem = {
  id: string
  title: string
  url: string
  publishedAt: string // ISO-8601
  summary?: string
  contentHtml?: string
  source: FeedSource
}

type FeedConfig = {
  slug: string
  feedTitle: string
  feedDescription: string
  url: string
  feedUrl: string
  outputXml: string
}`

  const userMessage = `Generate a TypeScript scraper for the source with slug "${slug}".

Source configuration:
${JSON.stringify(config, null, 2)}

Your scraper must:
1. Export: \`export async function fetchFeed(config: FeedConfig): Promise<FeedItem[]>\`
2. Fetch content from \`config.url\`
3. Return an array of FeedItem objects where:
   - \`source\` is set to \`config.slug\` ("${slug}")
   - \`publishedAt\` is a valid ISO-8601 date string
   - \`id\`, \`title\`, and \`url\` are non-empty strings

Type definitions to use (copy these into your module):
\`\`\`typescript
${typeDefinitions}
\`\`\`

Import types from: \`import type { FeedConfig, FeedItem } from "../../types.js"\`

Steps:
1. Use fetch_html to inspect the page at config.url. If the body is mostly empty/skeletal HTML, the page is JS-rendered — switch to fetch_with_browser.
2. Write and test a candidate with run_code — confirm it returns valid items.
3. Call write_scraper. The runtime will import the file and invoke fetchFeed against the real config; if validation fails the file is deleted and you must iterate.`

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage }]

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await client.messages.create({
        model: "deepseek-v4-flash",
        max_tokens: 16000,
        thinking: { type: "enabled", budget_tokens: 10000 },
        system:
          "You are an expert TypeScript developer generating RSS feed scrapers. Use the tools to understand the target page structure and write a working scraper. Always verify with run_code before calling write_scraper. If write_scraper reports validation failure, read the error carefully and try a different parsing strategy.",
        tools: TOOLS,
        messages,
      })

      messages.push({ role: "assistant", content: response.content })

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      )

      if (response.stop_reason === "end_turn" && toolUses.length === 0) {
        throw new Error(`Scraper agent gave up after ${turn + 1} turns without writing a scraper`)
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = []
      let scraperValidated = false

      for (const toolUse of toolUses) {
        console.log(
          `  [agent:${slug}] ${toolUse.name}(${JSON.stringify(toolUse.input).slice(0, 120)})`
        )
        const { output, success } = await executeTool(
          toolUse.name,
          toolUse.input as Record<string, unknown>,
          slug,
          config,
          ctx
        )
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: output })
        if (toolUse.name === "write_scraper" && success) scraperValidated = true
      }

      messages.push({ role: "user", content: toolResults })

      if (scraperValidated) return
    }

    throw new Error(`Scraper generation for ${slug} failed: max turns (${MAX_TURNS}) exceeded`)
  } finally {
    if (ctx.browser) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (ctx.browser as any).close().catch(() => undefined)
    }
  }
}
