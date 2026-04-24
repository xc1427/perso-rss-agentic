import Anthropic from "@anthropic-ai/sdk"
import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FeedConfig } from "../src/types.js"

const MAX_TURNS = 10
const GENERATED_DIR = "src/sources/generated"

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
    description: "Write the final verified scraper to disk. Only call this after run_code confirms it returns valid FeedItem objects.",
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
  slug: string
): Promise<string> {
  switch (name) {
    case "fetch_html": {
      const res = await fetch(input.url as string, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; rss-bot/1.0)" },
      })
      const text = await res.text()
      return `HTTP ${res.status}\n${text.slice(0, 80_000)}`
    }

    case "fetch_with_browser": {
      try {
        // Use a string variable so TypeScript doesn't statically resolve this optional dep
        const playwrightId: string = "playwright"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pw = (await import(playwrightId)) as any
        const browser = await pw.chromium.launch()
        const page = await browser.newPage()
        await page.goto(input.url as string)
        await page.waitForLoadState("networkidle")
        const content = await page.content()
        await browser.close()
        return content.slice(0, 80_000) as string
      } catch {
        return "playwright not available — use fetch_html instead"
      }
    }

    case "run_code": {
      const code = input.code as string
      const tmpDir = mkdtempSync(join(tmpdir(), `${slug}-`))
      const tmpFile = join(tmpDir, "candidate.ts")
      writeFileSync(tmpFile, code, "utf-8")
      const result = spawnSync("npx", ["tsx", tmpFile], {
        encoding: "utf-8",
        timeout: 30_000,
        cwd: process.cwd(),
      })
      const output = (result.stdout ?? "") + (result.stderr ?? "")
      return output.slice(0, 10_000) || "(no output)"
    }

    case "write_scraper": {
      const code = input.code as string
      mkdirSync(GENERATED_DIR, { recursive: true })
      writeFileSync(`${GENERATED_DIR}/${slug}.ts`, code, "utf-8")
      return `Written to ${GENERATED_DIR}/${slug}.ts`
    }

    default:
      return `Unknown tool: ${name}`
  }
}

export async function generateScraper(slug: string, config: FeedConfig): Promise<void> {
  const client = new Anthropic()

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
   - \`source\` is set to \`config.slug\`
   - \`publishedAt\` is a valid ISO-8601 date string
   - \`id\`, \`title\`, and \`url\` are non-empty strings

Type definitions to use (copy these into your module):
\`\`\`typescript
${typeDefinitions}
\`\`\`

Import types from: \`import type { FeedConfig, FeedItem } from "../../types.js"\`

Steps:
1. Use fetch_html to inspect the page at config.url
2. Write and test a candidate with run_code — confirm it returns valid items
3. Call write_scraper with the final working code`

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage }]

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 16000,
      thinking: { type: "enabled", budget_tokens: 10000 },
      system:
        "You are an expert TypeScript developer generating RSS feed scrapers. Use the tools to understand the target page structure and write a working scraper. Always verify with run_code before calling write_scraper.",
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
    let scraperWritten = false

    for (const toolUse of toolUses) {
      console.log(`  [agent:${slug}] ${toolUse.name}(${JSON.stringify(toolUse.input).slice(0, 120)})`)
      const result = await executeTool(toolUse.name, toolUse.input as Record<string, unknown>, slug)
      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result })
      if (toolUse.name === "write_scraper") scraperWritten = true
    }

    messages.push({ role: "user", content: toolResults })

    if (scraperWritten) return
  }

  throw new Error(`Scraper generation for ${slug} failed: max turns (${MAX_TURNS}) exceeded`)
}
