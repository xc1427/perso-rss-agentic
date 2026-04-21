export type FeedSource = "claude-code" | "agents" | "claude-code-changelog"

export type FeedItem = {
  id: string
  title: string
  url: string
  publishedAt: string // ISO-8601
  summary?: string
  contentHtml?: string
  source: FeedSource
}

export type FeedConfig = {
  source: FeedSource
  feedTitle: string
  feedDescription: string
  siteUrl: string
  feedUrl: string
  fetchUrl: string
  outputXml: string
  outputJson: string
}
