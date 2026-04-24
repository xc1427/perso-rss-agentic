export type FeedSource = string

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
  slug: string
  feedTitle: string
  feedDescription: string
  siteUrl: string
  feedUrl: string
  fetchUrl: string
  outputXml: string
}
