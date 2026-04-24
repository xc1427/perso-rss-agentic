# Architecture

## What the System Does

A TypeScript pipeline that scrapes web sources without native RSS feeds and publishes them as RSS XML files via GitHub Pages. Sources are declared in YAML; scrapers are either hand-written TypeScript modules or generated on-demand by a Claude agent.

## Repository Layout

```
sources/                          # One YAML file per feed source
  claude-code.yml
  agents.yml
  claude-code-changelog.yml

scripts/
  generate-source.ts              # Anthropic SDK agent loop for auto-generating scrapers

src/
  update.ts                       # Pipeline entry point
  types.ts                        # Shared TypeScript types
  sources/
    claude-code.ts                # Hand-written scraper wrapper
    agents.ts
    claude-code-changelog.ts
    claudeCategory.ts             # HTML parsing logic for blog category pages
    claudeChangelog.ts            # Markdown parsing logic for the changelog feed
    generated/                    # Agent-generated scrapers (committed to git)
      .gitkeep
  render/
    rss.ts                        # RSS XML renderer

test/
  fixtures/                       # Minimal HTML / markdown snippets for parser tests
  claudeCategory.test.ts
  claudeChangelog.test.ts
  rss.test.ts

.github/workflows/
  update-feeds.yml                # Scheduled pipeline + GitHub Pages deployment
```

## Source Configuration

Each source is a YAML file in `sources/`:

```yaml
slug: claude-code
feedTitle: Claude Code Blog
feedDescription: Latest posts from the Claude Code blog
siteUrl: https://claude.com/blog/category/claude-code
fetchUrl: https://claude.com/blog/category/claude-code
```

`feedUrl` (`https://xc1427.github.io/perso-rss-agentic/{slug}.xml`) and `outputXml` (`public/{slug}.xml`) are computed at runtime from `slug`.

## Core Types

```typescript
type FeedSource = string

type FeedItem = {
  id: string           // stable, does not change between runs
  title: string
  url: string
  publishedAt: string  // ISO-8601
  summary?: string
  contentHtml?: string
  source: FeedSource   // equals FeedConfig.slug
}

type FeedConfig = {
  slug: string
  feedTitle: string
  feedDescription: string
  siteUrl: string
  feedUrl: string      // computed from slug
  fetchUrl: string
  outputXml: string    // computed from slug
}
```

## Scraper Contract

Every scraper module (hand-written or generated) exports:

```typescript
export async function fetchFeed(config: FeedConfig): Promise<FeedItem[]>
```

## Scraper Loading Priority

For each source `slug`, `update.ts` tries in order:

1. `src/sources/{slug}.ts` — hand-written (always wins if present)
2. `src/sources/generated/{slug}.ts` — previously generated (cached)
3. `scripts/generate-source.ts → generateScraper(slug, config)` — agent generates and writes to `src/sources/generated/{slug}.ts`, then imports it

## Output Validation

After `fetchFeed` returns, `update.ts` enforces:

- At least 1 item returned
- Each item has non-empty `id`, `title`, `url`, `publishedAt`
- `new Date(item.publishedAt)` produces a valid date

Validation failure is treated as a hard error (same as a thrown exception).

## Auto-Invalidation of Generated Scrapers

If `fetchFeed` throws or validation fails on a generated scraper, `update.ts` deletes `src/sources/generated/{slug}.ts`. The CI step that commits generated scrapers runs with `if: always()`, so deletions are committed even when the pipeline fails — the scraper will be regenerated on the next run.

## Agent-Generation Loop (`scripts/generate-source.ts`)

Uses `@anthropic-ai/sdk` with `claude-opus-4-7` and extended thinking (`budget_tokens: 10000`). Maximum 10 turns. Available tools:

| Tool | Description |
|---|---|
| `fetch_html` | HTTP GET, returns body capped at 80 KB |
| `fetch_with_browser` | Headless Chromium via playwright (optional dep); falls back gracefully |
| `run_code` | Executes TypeScript with `tsx`, returns stdout+stderr capped at 10 KB |
| `write_scraper` | Writes the final module to `src/sources/generated/{slug}.ts` and terminates the loop |

## Data Flow

```
sources/*.yml
  → update.ts reads configs
  → per source: loadScraper (hand-written | generated | auto-generate)
  → fetchFeed(config) → FeedItem[]
  → validateItems
  → renderRss → public/{slug}.xml
  → GitHub Actions uploads public/ as Pages artifact
  → GitHub Pages serves the XML files
```

## CI/Deployment

Workflow (`.github/workflows/update-feeds.yml`):

1. `npm install`
2. `npm test`
3. `npm start` — requires `ANTHROPIC_API_KEY` secret; writes `public/*.xml`
4. Commit `src/sources/generated/` changes back to git (`[skip ci]`, runs `if: always()`)
5. Upload `public/` as Pages artifact
6. Deploy to GitHub Pages

Required permissions: `contents: write`, `pages: write`, `id-token: write`.

## Failure Isolation

`update.ts` runs all sources under `Promise.allSettled`, so one source failing does not block others. The process exits non-zero if any source fails, causing the Actions job to be marked failed. Because XML files are not committed to git, the previously deployed artifacts remain live until the next successful run.

## Adding a New Source

Drop a YAML file in `sources/`. If no hand-written scraper exists for the slug, the pipeline auto-generates one on the first run and commits it. No other changes required.
