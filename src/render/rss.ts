import type { FeedConfig, FeedItem } from "../types.js"

const MAX_ITEMS = 50

export function renderRss(items: FeedItem[], config: FeedConfig): string {
  const buildDate = toRfc822(new Date())
  const itemsXml = items
    .slice(0, MAX_ITEMS)
    .map(renderItem)
    .join("\n")

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(config.feedTitle)}</title>
    <link>${esc(config.siteUrl)}</link>
    <description>${esc(config.feedDescription)}</description>
    <atom:link href="${esc(config.feedUrl)}" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${buildDate}</lastBuildDate>
${itemsXml}
  </channel>
</rss>`
}

function renderItem(item: FeedItem): string {
  const description = item.contentHtml
    ? `<![CDATA[${item.contentHtml}]]>`
    : item.summary
    ? esc(item.summary)
    : ""

  return `    <item>
      <title>${esc(item.title)}</title>
      <link>${esc(item.url)}</link>
      <guid isPermaLink="false">${esc(item.id)}</guid>
      <pubDate>${toRfc822(new Date(item.publishedAt))}</pubDate>
      <description>${description}</description>
    </item>`
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function toRfc822(d: Date): string {
  return d.toUTCString()
}
