import type { FeedConfig, FeedItem } from "../../types.js"

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function processInline(text: string): string {
  // **bold** → <strong>
  let result = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
  // `code` → <code> (must happen after bold so bold markers aren't inside code)
  result = result.replace(/`([^`]+)`/g, "<code>$1</code>")
  return result
}

/**
 * Convert a block of Markdown text to HTML.
 * Handles:
 *   - ## headings → <h2>
 *   - Consecutive "- item" lines → <ul><li>...</li></ul>
 *   - Inline **bold** and `code`
 */
function mdToHtml(md: string): string {
  const lines = md.split("\n")
  const parts: string[] = []
  let inList = false

  function closeList() {
    if (inList) {
      parts.push("</ul>")
      inList = false
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    if (!line) {
      closeList()
      continue
    }

    // Heading
    const hMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (hMatch) {
      closeList()
      const level = hMatch[1].length
      const text = processInline(escapeHtml(hMatch[2]))
      parts.push(`<h${level}>${text}</h${level}>`)
      continue
    }

    // List item (starts with "- " or "* ")
    const lMatch = line.match(/^[-*]\s+(.+)$/)
    if (lMatch) {
      if (!inList) {
        parts.push("<ul>")
        inList = true
      }
      let content = lMatch[1]
      // Handle doubled dash: "- - item" → treat as a single item
      const dMatch = content.match(/^[-*]\s+(.+)$/)
      if (dMatch) {
        content = dMatch[1]
      }
      parts.push(`<li>${processInline(content)}</li>`)
      continue
    }

    // Plain paragraph
    closeList()
    parts.push(`<p>${processInline(escapeHtml(line))}</p>`)
  }

  closeList()
  return parts.join("\n")
}

export async function fetchFeed(config: FeedConfig): Promise<FeedItem[]> {
  const resp = await fetch(config.url)
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${config.url}: ${resp.status} ${resp.statusText}`)
  }
  const md = await resp.text()

  // Split the markdown into sections by "## version" headings
  const lines = md.split("\n")
  const sections: { version: string; bodyLines: string[] }[] = []
  let currentVersion = ""
  let currentLines: string[] = []
  let inChangelog = false

  for (const line of lines) {
    const hMatch = line.match(/^##\s+(.+)$/)
    if (hMatch) {
      if (currentVersion) {
        sections.push({ version: currentVersion, bodyLines: currentLines })
      }
      currentVersion = hMatch[1].trim()
      currentLines = []
      inChangelog = true
    } else if (inChangelog) {
      currentLines.push(line)
    }
  }
  if (currentVersion) {
    sections.push({ version: currentVersion, bodyLines: currentLines })
  }

  const items: FeedItem[] = []
  const now = new Date().toISOString()

  for (const sec of sections) {
    const bodyMd = sec.bodyLines.join("\n").trim()
    const contentHtml = bodyMd ? mdToHtml(bodyMd) : undefined

    // Extract a plain-text summary from the first bullet point
    let summary: string | undefined
    for (const l of sec.bodyLines) {
      const trimmed = l.trim()
      const bMatch = trimmed.match(/^[-*]\s+(.+)$/)
      if (bMatch) {
        let text = bMatch[1]
        const dMatch = text.match(/^[-*]\s+(.+)$/)
        if (dMatch) text = dMatch[1]
        // Strip markdown formatting for plain-text summary
        summary = text
          .replace(/\*\*(.+?)\*\*/g, "$1")
          .replace(/`([^`]+)`/g, "$1")
          .trim()
        break
      }
    }

    items.push({
      id: sec.version,
      title: sec.version,
      url: config.url,
      publishedAt: now,
      source: config.slug,
      summary,
      contentHtml,
    })
  }

  return items
}
