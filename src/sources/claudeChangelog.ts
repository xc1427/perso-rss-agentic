import type { FeedItem } from "../types.js"

// Raw markdown URL for the Claude Code changelog.
// Update this to the actual raw source URL once known.
export const CHANGELOG_URL =
  "https://raw.githubusercontent.com/anthropics/claude-code/refs/heads/main/CHANGELOG.md"

export async function fetchChangelogFeed(fetchUrl: string = CHANGELOG_URL): Promise<FeedItem[]> {
  const res = await fetch(fetchUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; rss-bot/1.0)" },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${fetchUrl}`)
  const md = await res.text()
  return parseChangelogMarkdown(md, fetchUrl)
}

export function parseChangelogMarkdown(markdown: string, sourceUrl: string): FeedItem[] {
  const items: FeedItem[] = []

  // Split on ## headings — each heading is one version entry
  const sections = markdown.split(/^(?=## )/m).filter((s) => s.startsWith("## "))

  for (const section of sections) {
    const newlineIdx = section.indexOf("\n")
    const heading = (newlineIdx === -1 ? section : section.slice(0, newlineIdx))
      .replace(/^## /, "")
      .trim()
    const body = newlineIdx === -1 ? "" : section.slice(newlineIdx + 1).trim()

    if (!heading) continue

    // Extract version: "1.2.3", "v1.2.3", "1.2.3 (2024-01-15)", etc.
    const versionMatch = heading.match(/^v?([\d.]+)/)
    const version = versionMatch ? versionMatch[1] : heading

    // Extract date from heading or fall back to the first date-like string in the body
    const dateMatch =
      heading.match(/(\d{4}-\d{2}-\d{2})/) ||
      body.match(/(\d{4}-\d{2}-\d{2})/)
    const publishedAt = dateMatch
      ? new Date(dateMatch[1]).toISOString()
      : new Date().toISOString()

    items.push({
      id: `${sourceUrl}#${version}`,
      title: heading,
      url: sourceUrl,
      publishedAt,
      contentHtml: mdToHtml(body),
      source: "claude-code-changelog",
    })
  }

  return items
}

function mdToHtml(md: string): string {
  const lines = md.split("\n")
  const out: string[] = []
  let inList = false

  for (const line of lines) {
    if (line.startsWith("#### ")) {
      if (inList) { out.push("</ul>"); inList = false }
      out.push(`<h4>${xmlEsc(line.slice(5).trim())}</h4>`)
    } else if (line.startsWith("### ")) {
      if (inList) { out.push("</ul>"); inList = false }
      out.push(`<h3>${xmlEsc(line.slice(4).trim())}</h3>`)
    } else if (line.startsWith("- ")) {
      if (!inList) { out.push("<ul>"); inList = true }
      out.push(`<li>${xmlEsc(line.slice(2).trim())}</li>`)
    } else if (line.trim() === "") {
      if (inList) { out.push("</ul>"); inList = false }
    } else if (line.trim()) {
      if (inList) { out.push("</ul>"); inList = false }
      out.push(`<p>${xmlEsc(line.trim())}</p>`)
    }
  }

  if (inList) out.push("</ul>")
  return out.join("\n")
}

function xmlEsc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
}
