import type { FeedConfig } from "../types.js"
import { esc } from "./escape.js"

export function renderIndexHtml(configs: FeedConfig[]): string {
  const items = configs
    .slice()
    .sort((a, b) => a.feedTitle.localeCompare(b.feedTitle))
    .map((c) => {
      const feedHref = `${c.slug}.xml`
      return `    <li><a href="${esc(feedHref)}">${esc(c.feedTitle)}</a> &mdash; <a href="${esc(c.url)}">source</a></li>`
    })
    .join("\n")

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>RSS feeds</title>
</head>
<body>
<h1>RSS feeds</h1>
<ul>
${items}
</ul>
</body>
</html>
`
}

