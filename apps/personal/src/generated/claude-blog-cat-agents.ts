// SOURCE_HASH: 8127fb767db205fc
// 由 packages/core/scripts/generate-source.ts 生成；来源配置或生成格式变化时自动重新生成。禁止手动编辑。
import * as cheerio from "cheerio"
import type { FeedConfig, FeedItem, ScraperHelpers } from "@rss-agentic/core"

const BASE = "https://claude.com"
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

type ListingItem = {
  url: string
  title: string
  dateText: string
  excerpt: string
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

function toIso(...candidates: (string | undefined)[]): string {
  for (const c of candidates) {
    if (!c) continue
    const t = Date.parse(c.trim())
    if (!Number.isNaN(t)) return new Date(t).toISOString()
  }
  return new Date().toISOString()
}

/** Extract the full article body as HTML from a detail page. */
function extractBody($: cheerio.CheerioAPI, itemUrl: string): string {
  const parts: string[] = []
  $("article")
    .find(".text-rich-text")
    .each((_, el) => {
      const $el = $(el)
      if (!$el.hasClass("w-richtext")) return
      const html = $el.html()
      if (html && html.trim()) parts.push(html)
    })

  let body = parts.join("\n").trim()
  if (!body) {
    // Fallback: any rich-text block that isn't the hero subheading / newsletter disclaimer
    const fallback: string[] = []
    $(".text-rich-text").each((_, el) => {
      const $el = $(el)
      const cls = $el.attr("class") || ""
      if (/subheading|disclaimer|Newsletter/i.test(cls)) return
      const html = $el.html()
      if (html && html.trim().length > 300) fallback.push(html)
    })
    body = fallback.join("\n").trim()
  }

  if (!body) return ""

  // Drop heavy inline base64 lazy-load placeholders injected as style attributes.
  body = body.replace(/\sstyle="[^"]*data:image[^"]*"/gi, "")

  // Resolve any relative URLs inside the body against the item URL.
  body = body.replace(/\s(href|src)="(\/[^"]*)"/gi, (_m, attr: string, rel: string) => {
    try {
      return ` ${attr}="${new URL(rel, itemUrl).href}"`
    } catch {
      return ` ${attr}="${rel}"`
    }
  })

  return body
}

export async function fetchFeed(config: FeedConfig, _helpers: ScraperHelpers): Promise<FeedItem[]> {
  const html = await fetchHtml(config.url)
  const $ = cheerio.load(html)

  const seen = new Set<string>()
  const listing: ListingItem[] = []

  $('a[href^="/resources/articles/"]').each((_, el) => {
    const $a = $(el)
    const href = $a.attr("href")
    if (!href) return
    const title = $a.find("h3").first().text().trim()
    if (!title) return
    if (seen.has(href)) return
    seen.add(href)

    let url: string
    try {
      url = new URL(href, BASE).href
    } catch {
      return
    }

    listing.push({
      url,
      title,
      dateText: $a.find('[class*="ResourceCard"][class*="__meta"]').first().text().trim(),
      excerpt: $a.find('p[class*="ResourceCard"][class*="__excerpt"]').first().text().trim(),
    })
  })

  const items = await Promise.all(
    listing.map(async (entry): Promise<FeedItem> => {
      const item: FeedItem = {
        id: entry.url,
        title: entry.title,
        url: entry.url,
        publishedAt: toIso(entry.dateText),
        source: config.slug,
      }
      if (entry.excerpt) item.summary = entry.excerpt

      try {
        const detailHtml = await fetchHtml(entry.url)
        const $$ = cheerio.load(detailHtml)

        const ogImage = $$('meta[property="og:image"]').attr("content")
        if (ogImage && ogImage.trim()) {
          try {
            item.imageUrl = new URL(ogImage.trim(), entry.url).href
          } catch {
            /* ignore malformed image URL */
          }
        } else {
          const firstImg = $$("article").find("img").first().attr("src")
          if (firstImg && firstImg.trim()) {
            try {
              item.imageUrl = new URL(firstImg.trim(), entry.url).href
            } catch {
              /* ignore */
            }
          }
        }

        const published = $$('meta[property="article:published_time"]').attr("content")
        item.publishedAt = toIso(published, entry.dateText)

        const body = extractBody($$, entry.url)
        if (body) item.contentHtml = body
      } catch {
        // Graceful degradation: keep listing-level fields for this item.
      }

      return item
    })
  )

  return items.filter((i) => i.id && i.title && i.url)
}
