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
    index-html.ts                 # public/index.html renderer (directory of feeds)

test/
  rss.test.ts
  index-html.test.ts

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
# Optional — see "Per-Source Escape Hatch" below
agentHints: |
  Always fetch each detail page in parallel — the listing cards only contain
  placeholder illustrations.
  - imageUrl: use the first `<meta property="og:image">` on the detail page.
  - summary: first ~200 words from `.post-body` plain text.
```

`feedUrl` (`https://xc1427.github.io/perso-rss-agentic/{slug}.xml`) and `outputXml` (`public/{slug}.xml`) are computed at runtime from `slug`. `url` is both the fetch target and the RSS `<link>` value; for sources like the changelog it points to the raw content URL.

### Per-Source Escape Hatch: `agentHints`

`agentHints` is an optional free-form block of guidance injected into the scraper-generator prompt for that one source. Use it when a source needs guardrails or preferences that don't belong in the global prompt: site-specific selectors that aren't obvious, fallback strategies, or fields the listing page hides that must be pulled from the detail page.

`agentHints` is **generation-time only**: it never reaches the runtime scraper or the rendered RSS XML. It refines, but does not override, the validation requirements enforced by the global prompt and `update.ts`.

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

For each source, `update.ts` does the following before invoking the scraper:

1. Compute a sha256 of the source-config-relevant YAML fields (`slug`, `feedTitle`, `feedDescription`, `url`, `agentHints`); take the first 16 hex chars as the **source hash**.
2. If `src/sources/generated/{slug}.ts` exists and its first line matches `// SOURCE_HASH: <hash>`, import it and use it.
3. Otherwise — file missing, header missing, or hash mismatched — delete any stale file and call `scripts/generate-source.ts → generateScraper(slug, config, agentHints, sourceHash)`. The agent writes a fresh scraper carrying the current hash; `update.ts` then imports it.

## Generated Scrapers Are Not Source Code

Files under `src/sources/generated/` are agent output, bound to a specific source-config snapshot via the `// SOURCE_HASH:` header. They are not source code and must not be hand-edited:

- Manual edits will be silently overwritten the next time the file is regenerated (validation failure, source-hash drift, or deliberate prompt change).
- Hand-edits also obscure which behaviors the generator can reliably produce, making the prompt harder to evolve.

To change scraper behavior, edit one of the inputs the generator reads:

- The **global generator prompt** in `scripts/generate-source.ts` for changes that should apply to every source.
- The **per-source `agentHints`** in `sources/{slug}.yml` for site-specific guardrails or preferences. This is the supported per-source escape hatch — see "Source Configuration" above.

A hand-written scraper layer may still be introduced later for cases where neither lever can produce a working scraper, but it is not part of the current design.

## Output Validation

After `fetchFeed` returns, `update.ts` enforces:

- At least 1 item returned
- Each item has non-empty `id`, `title`, `url`, `publishedAt`
- `new Date(item.publishedAt)` produces a valid date
- `item.source` equals the source's `slug`
- `imageUrl`, when present, is a non-empty absolute `http(s)` URL

Validation failure is treated as a hard error (same as a thrown exception). The agent runs the same validation in-process immediately after `write_scraper` and reports failures back to itself for iteration.

## Cache Invalidation

A cached `src/sources/generated/{slug}.ts` is invalidated and regenerated in two cases:

1. **Source-config drift.** Each generated scraper carries `// SOURCE_HASH: <hex>` as its first line — a sha256 of `{slug, feedTitle, feedDescription, url, agentHints}` at generation time. Before the import attempt, `update.ts` recomputes the hash from the current YAML and compares. On mismatch (or when the header is missing — e.g. a legacy scraper of unknown provenance), the cached file is deleted and regenerated under the current config. Editing any hashed YAML field — including `agentHints` — therefore triggers regeneration on the next run with no manual cleanup. Derived runtime fields (`feedUrl`, `outputXml`) are excluded from the hash because they are pure functions of `slug`.

2. **Runtime failure.** If `fetchFeed` throws or output validation fails, `update.ts` deletes the cached scraper.

The CI step that commits generated scrapers runs with `if: always()`, so deletions in either case are committed even when the pipeline fails — the scraper will be regenerated on the next run.

> **Module cache caveat:** Node's ESM `import()` caches a successfully loaded module in-process. If a scraper is imported, then deleted from disk after a validation failure, the in-memory module remains live for the duration of that process run. This is safe because the process always exits (success or `process.exit(1)`) before any retry could occur. Do not introduce intra-process retry logic that re-imports the same slug — it would silently execute the stale cached module instead of the regenerated one.

## Agent-Generation Loop (`scripts/generate-source.ts`)

Uses `@anthropic-ai/sdk` with `deepseek-v4-flash` (via DeepSeek's Anthropic-compatible API) and extended thinking (`budget_tokens: 10000`). Maximum 15 turns. Available tools:

| Tool | Description |
|---|---|
| `fetch_html` | HTTP GET with a 30 s timeout, returns `HTTP <status>\n<body>` capped at 80 KB; non-2xx is reported back as a tool failure |
| `fetch_with_browser` | Headless Chromium via playwright (optional dep) reused across calls within one generation; `try/finally`-closes the page; falls back from `networkidle` to `domcontentloaded` so SPAs don't hang |
| `run_code` | Executes TypeScript with `tsx` (30 s timeout). Returns a structured result: an exit-status label, then `stderr` (errors, tail-trimmed to 5 KB), then `stdout` (logs, tail-trimmed to 5 KB). Stderr-first because compile errors, module-not-found, and tracebacks land there |
| `write_scraper` | Prepends a `// SOURCE_HASH: <hex>` header (computed from the current source config — see "Cache Invalidation") and a "do not hand-edit" notice, writes the candidate to `src/sources/generated/{slug}.ts`, then immediately imports it (cache-busted URL) and runs the same validation as `update.ts`. On success the loop returns. On failure the file is deleted and the validation error is fed back to the agent so it can iterate within the remaining turns. |

## Data Flow

```
sources/*.yml
  → update.ts reads configs
  → per source: loadScraper (cached generated | auto-generate)
  → fetchFeed(config) → FeedItem[]
  → validateItems
  → renderRss → public/{slug}.xml
  → after all sources: renderIndexHtml(succeeded) → public/index.html
  → GitHub Actions uploads public/ as Pages artifact
  → GitHub Pages serves the XML files and the index
```

The index page lists only sources whose feed was generated successfully on this run, so it never links to a missing `.xml`. If every source fails, no index is written.

## CI/Deployment

Workflow (`.github/workflows/update-feeds.yml`):

Triggers: scheduled cron (`0 6 * * *`) and manual `workflow_dispatch` only — no `push`/`pull_request`. A `concurrency` group (`update-feeds`, `cancel-in-progress: false`) prevents a manual dispatch from racing the cron.

Steps:

1. `npm install`
2. Restore `~/.cache/ms-playwright` from the Actions cache (keyed by `package.json` hash)
3. `npx playwright install --with-deps chromium`
4. `npm test`
5. `npm start` — needs `ANTHROPIC_API_KEY` (sourced from the `DEEPSEEK_API_KEY` secret) and `ANTHROPIC_BASE_URL` (sourced from the `DEEPSEEK_ANTHROPIC_COMPAT_BASE_URL` env variable); writes `public/*.xml`
6. Commit `src/sources/generated/` changes back to git (`[skip ci]`, runs `if: always()`, pushes to `origin HEAD:$GITHUB_REF_NAME`)
7. Upload `public/` as Pages artifact (runs with `if: always() && hashFiles('public/*.xml') != ''` so a partial-failure run still deploys the feeds that did succeed; skipped only when zero feeds were written, in which case the previous live deployment is preserved)
8. Deploy to GitHub Pages (same condition as step 7)

Required permissions: `contents: write`, `pages: write`, `id-token: write`.

## Failure Isolation

`update.ts` runs all sources under `Promise.allSettled`, so one source failing does not block others. The process exits non-zero if any source fails, which marks the Actions job as failed — but the upload + deploy steps still run (`if: always()`) as long as at least one feed XML was written, so partial successes ship to Pages. If every source fails, no XML is written, the upload + deploy steps are skipped, and the previously deployed artifacts remain live until the next run with at least one success.

## Adding a New Source

Drop a YAML file in `sources/` with at minimum `slug`, `feedTitle`, `feedDescription`, and `url`. The pipeline auto-generates a scraper on the first run and commits it. No other changes required.

If the global generator prompt isn't enough for the site (e.g. listing-page images are placeholders, or the post body lives behind an unusual selector), add `agentHints` to the YAML — the next run will see a hash mismatch, discard the cached scraper, and regenerate it under the new hints.
