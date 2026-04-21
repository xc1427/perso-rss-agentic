import { readFileSync } from "node:fs"
import { describe, it, expect } from "vitest"
import { parseChangelogMarkdown } from "../src/sources/claudeChangelog.js"

const md = readFileSync(new URL("./fixtures/claudeChangelog.md", import.meta.url), "utf-8")
const SOURCE_URL = "https://example.com/CHANGELOG.md"

describe("parseChangelogMarkdown", () => {
  it("extracts the correct number of versions", () => {
    const items = parseChangelogMarkdown(md, SOURCE_URL)
    expect(items).toHaveLength(3)
  })

  it("extracts version heading as title", () => {
    const items = parseChangelogMarkdown(md, SOURCE_URL)
    expect(items[0].title).toBe("1.3.0 (2024-03-20)")
  })

  it("parses date from heading", () => {
    const items = parseChangelogMarkdown(md, SOURCE_URL)
    expect(items[0].publishedAt).toBe("2024-03-20T00:00:00.000Z")
  })

  it("uses version-anchored url as stable id", () => {
    const items = parseChangelogMarkdown(md, SOURCE_URL)
    expect(items[0].id).toBe(`${SOURCE_URL}#1.3.0`)
  })

  it("sets source to claude-code-changelog", () => {
    const items = parseChangelogMarkdown(md, SOURCE_URL)
    expect(items.every((i) => i.source === "claude-code-changelog")).toBe(true)
  })

  it("renders contentHtml with list items", () => {
    const items = parseChangelogMarkdown(md, SOURCE_URL)
    expect(items[0].contentHtml).toContain("<li>Added support for MCP servers</li>")
  })

  it("renders contentHtml with section headings", () => {
    const items = parseChangelogMarkdown(md, SOURCE_URL)
    expect(items[0].contentHtml).toContain("<h3>New Features</h3>")
  })

  it("returns empty array for empty input", () => {
    expect(parseChangelogMarkdown("", SOURCE_URL)).toHaveLength(0)
  })
})
