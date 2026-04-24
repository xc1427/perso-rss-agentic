import { describe, it, expect } from "vitest"
import { renderRss } from "../src/render/rss.js"
import type { FeedConfig, FeedItem } from "../src/types.js"

const config: FeedConfig = {
  slug: "claude-code",
  feedTitle: "Claude Code Blog",
  feedDescription: "Latest posts",
  url: "https://claude.com/blog/category/claude-code",
  feedUrl: "https://example.github.io/rss/claude-code.xml",
  outputXml: "public/claude-code.xml",
}

const items: FeedItem[] = [
  {
    id: "https://claude.com/blog/post-1",
    title: "First Post",
    url: "https://claude.com/blog/post-1",
    publishedAt: "2024-03-15T00:00:00.000Z",
    summary: "A summary of the first post.",
    source: "claude-code",
  },
  {
    id: "https://claude.com/blog/post-2",
    title: "Post with <special> & \"chars\"",
    url: "https://claude.com/blog/post-2",
    publishedAt: "2024-02-01T00:00:00.000Z",
    contentHtml: "<p>Some <b>HTML</b> content.</p>",
    source: "claude-code",
  },
]

describe("renderRss", () => {
  it("produces valid XML declaration", () => {
    const xml = renderRss(items, config)
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/)
  })

  it("includes feed title", () => {
    const xml = renderRss(items, config)
    expect(xml).toContain("<title>Claude Code Blog</title>")
  })

  it("includes atom self-link", () => {
    const xml = renderRss(items, config)
    expect(xml).toContain('rel="self"')
    expect(xml).toContain(config.feedUrl)
  })

  it("renders item titles", () => {
    const xml = renderRss(items, config)
    expect(xml).toContain("<title>First Post</title>")
  })

  it("escapes special characters in title", () => {
    const xml = renderRss(items, config)
    expect(xml).toContain("Post with &lt;special&gt; &amp; &quot;chars&quot;")
  })

  it("uses summary as description when no contentHtml", () => {
    const xml = renderRss(items, config)
    expect(xml).toContain("A summary of the first post.")
  })

  it("wraps contentHtml in CDATA", () => {
    const xml = renderRss(items, config)
    expect(xml).toContain("<![CDATA[<p>Some <b>HTML</b> content.</p>]]>")
  })

  it("escapes CDATA terminator in contentHtml", () => {
    const xml = renderRss(
      [{ id: "x", title: "x", url: "https://x.com", publishedAt: new Date().toISOString(), contentHtml: "a]]>b", source: "test" }],
      config
    )
    expect(xml).toContain("<![CDATA[a]]]]><![CDATA[>b]]>")
    expect(xml).not.toContain("a]]>b")
  })

  it("renders empty feed without crashing", () => {
    const xml = renderRss([], config)
    expect(xml).toContain("<channel>")
  })
})
