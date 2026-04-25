import type { FeedConfig, FeedItem } from "../../types.js";

/**
 * Fetches the Claude Code CHANGELOG.md from GitHub and parses it into FeedItems.
 * Each `## X.Y.Z` heading becomes one item. Since the changelog does not
 * include dates, the current date is used as publishedAt.
 */
export async function fetchFeed(config: FeedConfig): Promise<FeedItem[]> {
  const res = await fetch(config.url);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch ${config.url}: ${res.status} ${res.statusText}`,
    );
  }

  const text = await res.text();
  const lines = text.split("\n");

  const items: FeedItem[] = [];
  let currentVersion = "";
  let currentLines: string[] = [];

  // Matches "## 1.2.3" or "## 1.2.3-beta.1" style headings
  const versionRegex = /^##\s+(\d+\.\d+\.\d+(-[\w.]+)?)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(versionRegex);

    if (match) {
      // Finalise the previous version, if any
      if (currentVersion) {
        items.push(buildItem(currentVersion, currentLines, config.slug));
      }

      currentVersion = match[1];
      currentLines = [];
    } else if (currentVersion && line.trim()) {
      currentLines.push(line);
    }
  }

  // Last version
  if (currentVersion) {
    items.push(buildItem(currentVersion, currentLines, config.slug));
  }

  return items;
}

/** Build a FeedItem from a parsed version section. */
function buildItem(
  version: string,
  lines: string[],
  source: string,
): FeedItem {
  const contentText = lines.map((l) => l.trim()).filter(Boolean).join("\n");

  // GitHub auto-generates heading anchors by stripping dots: "2.1.119" → "#21119"
  const anchorId = version.replace(/\./g, "");
  const url = `https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#${anchorId}`;

  const summary =
    contentText.length > 300
      ? contentText.substring(0, 300).replace(/\n/g, " ") + "..."
      : contentText.replace(/\n/g, " ") || undefined;

  return {
    id: version,
    title: `Version ${version}`,
    url,
    publishedAt: new Date().toISOString(),
    summary,
    contentHtml: contentText || undefined,
    source,
  };
}
