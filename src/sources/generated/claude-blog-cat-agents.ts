import * as cheerio from "cheerio";
import type { FeedConfig, FeedItem } from "../../types.js";

export async function fetchFeed(config: FeedConfig): Promise<FeedItem[]> {
  const html = await fetch(config.url).then((r) => r.text());
  const $ = cheerio.load(html);

  const items: FeedItem[] = [];

  // Blog posts are rendered as <article class="card_blog_list_wrap"> elements
  // inside a Webflow CMS collection list
  $("article.card_blog_list_wrap").each((_idx, el) => {
    const $el = $(el);

    // --- title ---
    const title = $el.find("h3.card_blog_list_title").text().trim();
    if (!title) return;

    // --- URL ---
    const href = $el.find("a.clickable_link").attr("href") || "";
    const url = href ? new URL(href, config.url).href : "";
    if (!url) return;

    // --- published date ---
    // The date is stored in a hidden div with fs-list-field="date"
    // Format: "Month DD, YYYY" (e.g. "April 30, 2026")
    const dateText = $el.find('[fs-list-field="date"]').text().trim();
    let publishedAt = "";
    if (dateText) {
      const parsed = new Date(dateText);
      if (!isNaN(parsed.getTime())) {
        publishedAt = parsed.toISOString();
      }
    }
    if (!publishedAt) return;

    // --- id ---
    // Use the URL as a stable, unique identifier
    const id = url;

    items.push({
      id,
      title,
      url,
      publishedAt,
      source: config.slug,
      // No image available in the listing view
      // No summary/excerpt available in the listing view
    });
  });

  return items;
}
