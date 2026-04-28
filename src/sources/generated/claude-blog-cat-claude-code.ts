import type { FeedConfig, FeedItem } from "../../types.js"
import * as cheerio from "cheerio"

export async function fetchFeed(config: FeedConfig): Promise<FeedItem[]> {
  const resp = await fetch(config.url)
  const html = await resp.text()
  const $ = cheerio.load(html)

  const items: FeedItem[] = []

  // The blog listing is inside a tab panel with card_blog_wrap cards
  const cards = $(".tab_panel .card_blog_wrap")

  cards.each((_i: number, el: any) => {
    const $el = $(el)

    // --- title ---
    const titleEl = $el.find(".card_blog_title")
    const title = titleEl.text().trim()
    if (!title) return // skip empty

    // --- link (from the clickable overlay anchor) ---
    const wrapper = $el.closest(".w-dyn-item")
    let linkHref = wrapper.find(".clickable_link").first().attr("href") || ""
    if (!linkHref) return // skip items without a link
    const url = new URL(linkHref, config.url).href

    // --- date ---
    const dateText = $el.find(".u-text-style-caption.u-foreground-tertiary.u-mb-1-5").first().text().trim()
    let publishedAt = ""
    if (dateText) {
      const d = new Date(dateText)
      if (!isNaN(d.getTime())) {
        publishedAt = d.toISOString()
      }
    }
    if (!publishedAt) return // skip items without valid date

    // --- image ---
    let imageUrl: string | undefined
    const imgEl = $el.find(".card_blog_illo").first()
    const src = imgEl.attr("src")
    if (src) {
      imageUrl = new URL(src, config.url).href
    }

    // --- id ---
    const id = url

    items.push({
      id,
      title,
      url,
      publishedAt,
      source: config.slug,
      ...(imageUrl ? { imageUrl } : {}),
    })
  })

  return items
}
