import { fetchCategoryFeed } from "./claudeCategory.js"
import type { FeedConfig, FeedItem } from "../types.js"

export async function fetchFeed(config: FeedConfig): Promise<FeedItem[]> {
  return fetchCategoryFeed(config.fetchUrl, config.slug, config.siteUrl)
}
