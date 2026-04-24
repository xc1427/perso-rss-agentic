import { fetchChangelogFeed } from "./claudeChangelog.js"
import type { FeedConfig, FeedItem } from "../types.js"

export async function fetchFeed(config: FeedConfig): Promise<FeedItem[]> {
  return fetchChangelogFeed(config.fetchUrl)
}
