# Architecture

## What the System Does

A TypeScript pipeline that scrapes web sources without native RSS feeds and publishes them as RSS XML files via GitHub Pages. Sources are declared in YAML; scrapers are generated on-demand by a Claude agent and cached in git.

## Repository Layout

```
sources/                          # One YAML file per feed source
  claude-blog-cat-claude-code.yml
  claude-blog-cat-agents.yml
  claude-code-changelog.yml

scripts/
  generate-source.ts              # Anthropic SDK agent loop for auto-generating scrapers

src/
  update.ts                       # Pipeline entry point
  types.ts                        # Shared TypeScript types
  sources/
    generated/                    # Agent-generated scrapers (committed to git)
      .gitkeep
  render/
    rss.ts                        # RSS XML renderer

test/
  rss.test.ts

.github/workflows/
  update-feeds.yml                # Scheduled pipeline + GitHub Pages deployment
```

## Source Configuration

Each source is a YAML file in `sources/`:

```yaml
slug: claude-blog-cat-claude-code
feedTitle: "Claude Blog (category: claude-code)"
feedDescription: Latest posts in the Claude blog "claude-code" category
url: https://claude.com/blog/category/claude-code
```

`feedUrl` (`https://xc1427.github.io/perso-rss-agentic/{slug}.xml`) and `outputXml` (`public/{slug}.xml`) are computed at runtime from `slug`. `url` is both the fetch target and the RSS `<link>` value; for sources like the changelog it points to the raw content URL.

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
  imageUrl?: string    // absolute http(s) URL of a representative image
  source: FeedSource   // equals FeedConfig.slug
}

type FeedConfig = {
  slug: string
  feedTitle: string
  feedDescription: string
  url: string
  feedUrl: string      // computed from slug
  outputXml: string    // computed from slug
}
```

## Scraper Contract

Every generated scraper exports:

```typescript
export async function fetchFeed(config: FeedConfig): Promise<FeedItem[]>
```

## Scraper Loading

For each source `slug`, `update.ts` tries in order:

1. `src/sources/generated/{slug}.ts` — previously generated (cached in git)
2. `scripts/generate-source.ts → generateScraper(slug, config)` — agent generates and writes to `src/sources/generated/{slug}.ts`, then imports it

## Hand-Written Scrapers

Hand-written scrapers are not part of the current design. All scrapers are agent-generated to keep the loading path simple and uniform. A hand-written scraper layer may be introduced later as an escape hatch for cases where the generated scraper is persistently flawed and manual intervention is needed.

## Output Validation

After `fetchFeed` returns, `update.ts` enforces:

- At least 1 item returned
- Each item has non-empty `id`, `title`, `url`, `publishedAt`
- `new Date(item.publishedAt)` produces a valid date
- `item.source` equals the source's `slug`
- `imageUrl`, when present, is a non-empty absolute `http(s)` URL

Validation failure is treated as a hard error (same as a thrown exception). The agent runs the same validation in-process immediately after `write_scraper` and reports failures back to itself for iteration.

## Auto-Invalidation of Generated Scrapers

If `fetchFeed` throws or validation fails, `update.ts` deletes `src/sources/generated/{slug}.ts`. The CI step that commits generated scrapers runs with `if: always()`, so deletions are committed even when the pipeline fails — the scraper will be regenerated on the next run.

> **Module cache caveat:** Node's ESM `import()` caches a successfully loaded module in-process. If a scraper is imported, then deleted from disk after a validation failure, the in-memory module remains live for the duration of that process run. This is safe because the process always exits (success or `process.exit(1)`) before any retry could occur. Do not introduce intra-process retry logic that re-imports the same slug — it would silently execute the stale cached module instead of the regenerated one.

## Agent-Generation Loop (`scripts/generate-source.ts`)

Uses `@anthropic-ai/sdk` with `deepseek-v4-flash` (via DeepSeek's Anthropic-compatible API) and extended thinking (`budget_tokens: 10000`). Maximum 10 turns. Available tools:

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
  → per source: loadScraper (cached generated | auto-generate)
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

Drop a YAML file in `sources/`. The pipeline auto-generates a scraper on the first run and commits it. No other changes required.
