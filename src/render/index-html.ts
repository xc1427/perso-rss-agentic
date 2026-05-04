import type { FeedConfig } from "../types.js"

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
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RSS feeds</title>
<style>
:root { color-scheme: light dark; }
body { font: 16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; }
h1 { font-size: 1.4rem; margin: 0 0 1.25rem; }
ul { list-style: none; padding: 0; margin: 0; }
li { padding: 0.4rem 0; border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
li:first-child { border-top: 0; }
a { color: inherit; text-decoration: none; }
a:hover { text-decoration: underline; }
li > a:first-child { font-weight: 600; }
</style>
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

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}
