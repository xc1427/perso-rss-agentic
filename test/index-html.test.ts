import { describe, it, expect } from "vitest"
import { renderIndexHtml } from "../src/render/index-html.js"
import type { FeedConfig } from "../src/types.js"

function cfg(slug: string, feedTitle: string, url: string): FeedConfig {
  return {
    slug,
    feedTitle,
    feedDescription: "",
    url,
    feedUrl: `https://example.github.io/rss/${slug}.xml`,
    outputXml: `public/${slug}.xml`,
  }
}

describe("renderIndexHtml", () => {
  it("emits a valid HTML5 doctype and a list", () => {
    const html = renderIndexHtml([cfg("a", "Alpha", "https://example.com/a")])
    expect(html).toMatch(/^<!doctype html>/i)
    expect(html).toContain("<ul>")
    expect(html).toContain("</ul>")
  })

  it("links each source to its relative xml file", () => {
    const html = renderIndexHtml([cfg("foo-bar", "Foo Bar", "https://example.com/foo")])
    expect(html).toContain('<a href="foo-bar.xml">Foo Bar</a>')
  })

  it("links to the original source URL", () => {
    const html = renderIndexHtml([cfg("foo", "Foo", "https://example.com/foo")])
    expect(html).toContain('<a href="https://example.com/foo">source</a>')
  })

  it("orders entries by feed title", () => {
    const html = renderIndexHtml([
      cfg("z", "Zeta", "https://example.com/z"),
      cfg("a", "Alpha", "https://example.com/a"),
      cfg("m", "Mu", "https://example.com/m"),
    ])
    const alphaIdx = html.indexOf("Alpha")
    const muIdx = html.indexOf("Mu")
    const zetaIdx = html.indexOf("Zeta")
    expect(alphaIdx).toBeLessThan(muIdx)
    expect(muIdx).toBeLessThan(zetaIdx)
  })

  it("escapes special characters in titles and URLs", () => {
    const html = renderIndexHtml([
      cfg("x", 'Title with <tag> & "quote"', "https://example.com/?a=1&b=2"),
    ])
    expect(html).toContain("Title with &lt;tag&gt; &amp; &quot;quote&quot;")
    expect(html).toContain("https://example.com/?a=1&amp;b=2")
    expect(html).not.toContain("<tag>")
  })

  it("handles an empty list without crashing", () => {
    const html = renderIndexHtml([])
    expect(html).toContain("<ul>")
    expect(html).toContain("</ul>")
  })
})
