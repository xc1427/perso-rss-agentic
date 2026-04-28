import Anthropic from "@anthropic-ai/sdk"
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { FeedConfig, FeedItem } from "../src/types.js"

const MAX_TURNS = 15
const GENERATED_DIR = "src/sources/generated"
// Cloudflare and similar WAFs block User-Agents containing "bot". Use a real
// browser UA so inspection requests aren't rejected before the agent can see
// the page structure.
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
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
      return {
        output: formatRunCodeOutput(result),
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

function formatRunCodeOutput(result: ReturnType<typeof spawnSync>): string {
  // Errors and tracebacks tend to land at the *end* of stderr; helpful debug logs
  // tend to land at the *end* of stdout. Concatenating from the start with an
  // overall budget would bury the most important text. Tail each stream separately
  // and lead with the exit status so the agent can act on it without parsing.
  const STDERR_BUDGET = 5_000
  const STDOUT_BUDGET = 5_000

  const tail = (s: string, budget: number): string =>
    s.length > budget ? `…(truncated, last ${budget} chars)…\n${s.slice(-budget)}` : s

  const stderr = String(result.stderr ?? "").trim()
  const stdout = String(result.stdout ?? "").trim()

  const exitLabel =
    result.status === 0
      ? "exit 0 (ok)"
      : result.signal
      ? `killed by ${result.signal} (likely timeout)`
      : `exit ${result.status} (failure)`

  const parts: string[] = [`[${exitLabel}]`]
  if (stderr) parts.push(`--- stderr ---\n${tail(stderr, STDERR_BUDGET)}`)
  if (stdout) parts.push(`--- stdout ---\n${tail(stdout, STDOUT_BUDGET)}`)
  if (!stderr && !stdout) parts.push("(no output)")
  return parts.join("\n")
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
    if (item.imageUrl !== undefined) {
      if (typeof item.imageUrl !== "string" || !item.imageUrl.trim()) {
        throw new Error("imageUrl, when present, must be a non-empty string")
      }
      if (!/^https?:\/\//i.test(item.imageUrl)) {
        throw new Error(`imageUrl must be an absolute http(s) URL: ${item.imageUrl}`)
      }
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
  imageUrl?: string  // optional absolute URL of a representative image
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
   - \`imageUrl\` (optional): if the listing already exposes a per-item thumbnail
     (e.g. an \`<img>\` inside each card, or a \`background-image\` in inline CSS),
     populate it with an **absolute** http(s) URL. If only a relative URL is
     available, resolve it against \`config.url\` with \`new URL(rel, config.url).href\`.
     Do **not** fetch each detail page just to grab og:image — keep this scraper
     to a single listing-page request. If no image is available, omit the field.

Type definitions to use (copy these into your module):
\`\`\`typescript
${typeDefinitions}
\`\`\`

Import types from: \`import type { FeedConfig, FeedItem } from "../../types.js"\`

Runtime available to your scraper and to run_code:
- Node 20 with global \`fetch\` (no \`node-fetch\` needed)
- \`cheerio\` for HTML parsing — use \`import * as cheerio from "cheerio"\` then \`cheerio.load(html)\`
- TypeScript via \`tsx\` (the file is executed directly)

NOT available (do not import these — you will get "Cannot find module"):
- \`jsdom\`, \`puppeteer\`, \`axios\`, \`node-html-parser\`, or any other npm package outside of cheerio
- \`playwright\` is installed but only usable through the \`fetch_with_browser\` tool; do not import it from a scraper

Tips for JS-rendered / Next.js pages (common for blog listing pages):
- Inspect the fetch_html body for \`<script id="__NEXT_DATA__" type="application/json">{...}</script>\`. The JSON inside often contains the listing items in \`props.pageProps\` — parsing it is faster and more stable than DOM scraping.
- If no JSON island is present and the listing is empty in the raw HTML, fall back to fetch_with_browser, then parse the rendered DOM with cheerio.

Anti-bot blocks (HTTP 403, "Just a moment...", "Attention Required! | Cloudflare"):
- If fetch_html returns 403 or a Cloudflare challenge page, fetch_html cannot reach this site. Do NOT keep retrying fetch_html with different paths — the WAF will keep blocking it. Switch immediately to fetch_with_browser, which uses headless Chromium and typically clears the challenge.
- If fetch_with_browser also returns blocked content, your scraper still has to work in production. The production scraper uses Node's default \`fetch\` (no custom User-Agent), which often passes when fetch_html does not. Generate the scraper based on whatever signal you can extract (best-effort selectors from a partially loaded page, an exposed JSON endpoint, or a sitemap) and let write_scraper validate it against the real fetch path.

Empty-listing fallbacks:
- If your selector matches the structure but yields 0 items inside the listing container, your selector is probably looking inside the wrong wrapper. Re-inspect the HTML and try a sibling/parent selector. Do NOT broaden the selector to the whole page — the scraper must return items belonging to *this* config.url, not unrelated posts.
- The scraper must return at least one item or validation will fail and the file will be deleted.

Reading run_code output:
- Format: \`[exit X (ok|failure)] --- stderr --- … --- stdout --- …\`. Each stream is tail-trimmed (last 5 KB shown).
- Always read \`exit\` first; if non-zero, the issue is almost always in stderr (module-not-found, TypeScript syntax error, runtime exception).
- If a previous run_code reported "Cannot find module 'X'", X is not installed — switch strategy, do not re-import it.
- If a selector returned 0 results, the selector is wrong or the page is JS-rendered — change approach, do not retry the same selector.

Steps:
1. fetch_html the page once. If the body is empty/skeletal, either parse \`__NEXT_DATA__\` or fetch_with_browser.
2. Use run_code to dump 1–2 sample items as JSON and confirm fields look right.
3. Call write_scraper. It imports the file (cache-busted), invokes fetchFeed with the real config, and runs the same validation as production. On failure the file is deleted and you must iterate within the remaining turns — never retry the exact code that just failed.`

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage }]

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await client.messages.create({
        model: "deepseek-v4-flash",
        max_tokens: 16000,
        thinking: { type: "enabled", budget_tokens: 10000 },
        system:
          "You are an expert TypeScript developer generating RSS feed scrapers. Tool results are structured: run_code returns an exit label, then stderr (errors) and stdout (logs), each tail-trimmed. Read the exit label first, then stderr — that is where module-not-found errors, TS syntax errors, and runtime exceptions land. Never retry the exact same code or import that just failed; change strategy. Verify with run_code before write_scraper. write_scraper writes the file, imports it, runs production validation, and reports any failure back to you.",
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
