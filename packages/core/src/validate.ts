import type { FeedItem } from "./types.js"

export function validateItems(items: FeedItem[], slug: string): void {
  if (items.length < 1) throw new Error(`${slug}: scraper returned no items`)
  for (const item of items) {
    if (!item.id?.trim()) throw new Error(`${slug}: item missing id`)
    if (!item.title?.trim()) throw new Error(`${slug}: item missing title`)
    if (!item.url?.trim()) throw new Error(`${slug}: item missing url`)
    if (!item.publishedAt?.trim()) throw new Error(`${slug}: item missing publishedAt`)
    if (isNaN(new Date(item.publishedAt).getTime())) {
      throw new Error(`${slug}: invalid publishedAt: ${item.publishedAt}`)
    }
    if (item.source !== slug) {
      throw new Error(`${slug}: item.source must equal "${slug}", got "${item.source}"`)
    }
    if (item.imageUrl !== undefined) {
      if (typeof item.imageUrl !== "string" || !item.imageUrl.trim()) {
        throw new Error(`${slug}: imageUrl, when present, must be a non-empty string`)
      }
      if (!/^https?:\/\//i.test(item.imageUrl)) {
        throw new Error(`${slug}: imageUrl must be an absolute http(s) URL: ${item.imageUrl}`)
      }
    }
  }
}
