export type FeedSource = string

export type FeedItem = {
  id: string
  title: string
  url: string
  publishedAt: string // ISO-8601
  summary?: string
  contentHtml?: string
  imageUrl?: string // absolute URL to a representative image, if available
  source: FeedSource
}

export type FeedConfig = {
  slug: string
  feedTitle: string
  feedDescription: string
  url: string
  feedUrl: string
  outputXml: string
}

export type ScraperHelpers = {
  // Always renders the page in a headless browser. Use only for SPA sources
  // whose listing is empty in the raw HTML (no `__NEXT_DATA__` JSON island,
  // no SSR'd markup); plain `fetch` is faster and preferred otherwise.
  fetchPage: (url: string) => Promise<string>
}
