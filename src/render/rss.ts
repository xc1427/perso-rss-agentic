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
    <link>${esc(config.url)}</link>
    <description>${esc(config.feedDescription)}</description>
    <atom:link href="${esc(config.feedUrl)}" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${buildDate}</lastBuildDate>
${itemsXml}
  </channel>
</rss>`
}

function renderItem(item: FeedItem): string {
  const description = item.contentHtml
    ? `<![CDATA[${item.contentHtml.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`
    : item.summary
    ? esc(item.summary)
    : ""

  const descriptionLine = description ? `\n      <description>${description}</description>` : ""
  const enclosureLine = item.imageUrl
    ? `\n      <enclosure url="${esc(item.imageUrl)}" length="0" type="${guessImageMime(item.imageUrl)}"/>`
    : ""

  return `    <item>
      <title>${esc(item.title)}</title>
      <link>${esc(item.url)}</link>
      <guid isPermaLink="false">${esc(item.id)}</guid>
      <pubDate>${toRfc822(new Date(item.publishedAt))}</pubDate>${enclosureLine}${descriptionLine}
    </item>`
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function guessImageMime(url: string): string {
  const ext = url.toLowerCase().match(/\.(jpe?g|png|gif|webp|svg|avif)(?:[?#]|$)/)?.[1]
  switch (ext) {
    case "png": return "image/png"
    case "gif": return "image/gif"
    case "webp": return "image/webp"
    case "svg": return "image/svg+xml"
    case "avif": return "image/avif"
    default: return "image/jpeg"
  }
}

function toRfc822(d: Date): string {
  return d.toUTCString()
}
