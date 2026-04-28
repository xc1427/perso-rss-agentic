import * as cheerio from "cheerio";
import type { FeedConfig, FeedItem } from "../../types.js";

function parseDate(dateStr: string): string {
  // Handle formats like "Apr 22, 2026" or "April 22, 2026"
  const trimmed = dateStr.trim();
  const parsed = new Date(trimmed);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }
  // Fallback: try to parse with some flexibility
  const months: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04",
    may: "05", jun: "06", jul: "07", aug: "08",
    sep: "09", oct: "10", nov: "11", dec: "12",
  };
  const match = trimmed.match(
    /(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})/i
  );
  if (match) {
    const monthAbbr = match[1].substring(0, 3).toLowerCase();
    const month = months[monthAbbr] || "01";
    const day = match[2].padStart(2, "0");
    const year = match[3];
    return `${year}-${month}-${day}T00:00:00.000Z`;
  }
  return new Date().toISOString();
}

export async function fetchFeed(config: FeedConfig): Promise<FeedItem[]> {
  const res = await fetch(config.url);
  const html = await res.text();
  const $ = cheerio.load(html);

  const items: FeedItem[] = [];

  // Each blog post is inside a .blog_cms_item.w-dyn-item
  $(".blog_cms_item.w-dyn-item").each((_i, el) => {
    const $el = $(el);

    // --- Title ---
    const title = $el.find(".card_blog_title").text().trim();
    if (!title) return;

    // --- URL ---
    let url = $el.find('a[fs-list-element="item-link"]').attr("href") || "";
    if (!url) {
      url = $el.find(".clickable_link").attr("href") || "";
    }
    if (!url) return;
    if (!url.startsWith("http")) {
      url = new URL(url, "https://claude.com").href;
    }

    // --- ID ---
    // Use the URL path as a stable ID
    const urlObj = new URL(url);
    const id = urlObj.pathname.replace(/\/$/, "") || url;

    // --- Published date ---
    // Prefer the hidden fs-list-field="date" which has full month name
    let dateStr = $el.find('[fs-list-field="date"]').text().trim();
    if (!dateStr) {
      // Fall back to visible date
      dateStr = $el
        .find(".card_blog_content .u-text-style-caption.u-foreground-tertiary")
        .first()
        .text()
        .trim();
    }
    const publishedAt = parseDate(dateStr);

    // --- Image ---
    let imageUrl: string | undefined;
    const imgSrc = $el.find(".card_blog_illo").attr("src");
    if (imgSrc) {
      imageUrl = imgSrc.startsWith("http")
        ? imgSrc
        : new URL(imgSrc, "https://claude.com").href;
    }

    // --- Summary ---
    let summary: string | undefined;
    // The visible date line sometimes includes a description, but mostly not.
    // We can grab the category tag as extra info
    const category = $el.find('[fs-list-field="category"]').text().trim();
    if (category) {
      summary = `Category: ${category}`;
    }

    items.push({
      id,
      title,
      url,
      publishedAt,
      source: config.slug,
      ...(imageUrl ? { imageUrl } : {}),
      ...(summary ? { summary } : {}),
    });
  });

  return items;
}
