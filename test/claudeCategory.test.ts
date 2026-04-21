import { readFileSync } from "node:fs"
import { describe, it, expect } from "vitest"
import { parseCategoryHtml } from "../src/sources/claudeCategory.js"

const html = readFileSync(new URL("./fixtures/claudeCategory.html", import.meta.url), "utf-8")
const BASE = "https://claude.com"

describe("parseCategoryHtml", () => {
  it("extracts the correct number of items", () => {
    const items = parseCategoryHtml(html, "claude-code", BASE)
    expect(items).toHaveLength(3)
  })

  it("extracts title correctly", () => {
    const items = parseCategoryHtml(html, "claude-code", BASE)
    expect(items[0].title).toBe("Claude Code 1.0 is here")
  })

  it("builds absolute URL from relative href", () => {
    const items = parseCategoryHtml(html, "claude-code", BASE)
    expect(items[0].url).toBe("https://claude.com/blog/claude-code-1-release")
  })

  it("uses url as stable id", () => {
    const items = parseCategoryHtml(html, "claude-code", BASE)
    expect(items[0].id).toBe(items[0].url)
  })

  it("parses ISO date from datetime attribute", () => {
    const items = parseCategoryHtml(html, "claude-code", BASE)
    expect(items[0].publishedAt).toBe("2024-03-15T00:00:00.000Z")
  })

  it("extracts summary from paragraph", () => {
    const items = parseCategoryHtml(html, "claude-code", BASE)
    expect(items[0].summary).toContain("general availability")
  })

  it("assigns correct source field", () => {
    const items = parseCategoryHtml(html, "agents", BASE)
    expect(items.every((i) => i.source === "agents")).toBe(true)
  })

  it("returns empty array for page with no articles", () => {
    const items = parseCategoryHtml("<html><body><p>Nothing here</p></body></html>", "claude-code", BASE)
    expect(items).toHaveLength(0)
  })
})
