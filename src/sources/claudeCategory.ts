import { load, type CheerioAPI, type AnyNode } from "cheerio"
import type { FeedItem, FeedSource } from "../types.js"

export async function fetchCategoryFeed(
  fetchUrl: string,
  source: FeedSource,
  baseUrl: string
): Promise<FeedItem[]> {
  const res = await fetch(fetchUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; rss-bot/1.0)" },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${fetchUrl}`)
  const html = await res.text()
  return parseCategoryHtml(html, source, baseUrl)
}

export function parseCategoryHtml(
  html: string,
  source: FeedSource,
  baseUrl: string
): FeedItem[] {
  const $ = load(html)
  const items: FeedItem[] = []
  const seen = new Set<string>()

  // Primary: article elements
  $("article").each((_, el) => {
    const item = extractFromContainer($, el, baseUrl, source)
    if (item && !seen.has(item.id)) {
      seen.add(item.id)
      items.push(item)
    }
  })

  // Fallback: links that point to individual blog posts (not category pages)
  if (items.length === 0) {
    $('a[href*="/blog/"]').each((_, el) => {
      const href = $(el).attr("href") ?? ""
      if (href.includes("/category/")) return
      const url = href.startsWith("http") ? href : `${baseUrl}${href}`
      if (seen.has(url)) return

      const title =
        $(el).find("h2, h3, h4").first().text().trim() ||
        $(el).text().trim()
      if (!title) return
      seen.add(url)

      const container = $(el).closest("section, div")
      const timeEl = container.find("time").first()
      const publishedAt =
        timeEl.attr("datetime") || timeEl.text().trim() || new Date().toISOString()
      const summary = container.find("p").first().text().trim() || undefined

      items.push({
        id: url,
        title,
        url,
        publishedAt: normalizeDate(publishedAt),
        summary,
        source,
      })
    })
  }

  return items
}

function extractFromContainer(
  $: CheerioAPI,
  el: AnyNode,
  baseUrl: string,
  source: FeedSource
): FeedItem | null {
  const container = $(el)
  const linkEl = container.find("a[href]").first()
  const href = linkEl.attr("href") ?? ""
  if (!href) return null

  const url = href.startsWith("http") ? href : `${baseUrl}${href}`
  const title =
    container.find("h2, h3, h4").first().text().trim() ||
    linkEl.text().trim()
  if (!title || !url) return null

  const timeEl = container.find("time").first()
  const publishedAt =
    timeEl.attr("datetime") || timeEl.text().trim() || new Date().toISOString()
  const summary = container.find("p").first().text().trim() || undefined

  return {
    id: url,
    title,
    url,
    publishedAt: normalizeDate(publishedAt),
    summary,
    source,
  }
}

function normalizeDate(raw: string): string {
  const d = new Date(raw)
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
}
