# Monorepo Refactor Plan

## Execution State

| PR | Branch | Status | Notes |
|----|--------|--------|-------|
| PR 1 | `pr/1-branch-guard-deploy` | **MERGED** (932c7e4) | Branch-guard Pages deploy to main only; concurrency scoped by branch |
| PR 2 | `pr/2-cleanup` | **OPEN** (#17) | In-place cleanup; tests pass, typecheck clean; awaiting merge |
| PR 3 | — | not started | `helpers.fetchPage` / SPA fix |
| PR 4 | — | not started | Monorepo migration |
| PR 5 | — | not started | Test infrastructure |
| PR 6 | — | not started | First pre-production SPA source |

**Current branch:** `pr/2-cleanup` (push complete, PR open).
**Next action:** merge PR 2, then start PR 3 from a fresh branch off main.

---

## Context

Personal RSS pipeline structured as a single project today. Goal: restructure into a monorepo so `@rss-agentic/core` and `rss-agentic` CLI are ready to extract — without publishing to npm yet. Everything built as if public.

Constraints:
- Live feeds at `https://xc1427.github.io/perso-rss-agentic/*.xml` must not be disrupted at any point
- Generated scrapers belong to the **personal app** (Option A) — not core
- pnpm workspaces, `helpers.fetchPage` always uses Playwright when called, CLI ships as stub in PR 4
- Generated scrapers that import `../../types.js` will break after the move — they must be force-regenerated via `GENERATOR_FORMAT_VERSION` bump, not hand-edited
- GitHub Actions workflows must stay at repo root `.github/workflows/`

---

## PR 3 — `helpers.fetchPage` (SPA fix)

**Why first:** the public API surface (`fetchFeed` signature) must be finalised before the monorepo move, so the published package ships the complete contract from day one.

### Changes

**`src/types.ts`** — add helpers type (exported, used in generated scrapers):
```ts
export type ScraperHelpers = {
  fetchPage: (url: string) => Promise<string>
}
```

**`src/update.ts`** — provision one Playwright browser per process run:
- Lazy-init a shared browser instance at the top of the run
- Implement `fetchPage(url)` using that browser (always uses Playwright — no fallback; callers that don't need a browser keep using global `fetch`)
- Pass `{ fetchPage }` as second arg to every `scraper.fetchFeed(config, helpers)` call
- Close browser in a `finally` block around the `Promise.allSettled` run
- Update `ScraperModule` type: `fetchFeed: (config: FeedConfig, helpers: ScraperHelpers) => Promise<FeedItem[]>`

**`scripts/generate-source.ts`**:
- Bump `GENERATOR_FORMAT_VERSION` (new constant, e.g. `"1"`); include in source-hash input alongside YAML fields so all cached scrapers regenerate on next CI run
- In `validateGeneratedScraper`: pass a `helpers` mock where `fetchPage` uses plain `fetch` (validation runs in-process, no browser needed)
- Update prompt: explain `helpers.fetchPage`, when to use it (SPA pages, no `__NEXT_DATA__`), and that plain `fetch` is still preferred for non-SPA sources

**`src/validate.ts`** — no change needed (validates items only, not the calling convention)

**Existing scrapers:** all will have SOURCE_HASH mismatches on next run (format version bump) and auto-regenerate. The regenerated scrapers will get the new signature. No hand-edits.

### Verification
- `npm test && npm run typecheck` passes
- `workflow_dispatch` on the PR branch: all 3 existing sources regenerate, produce valid feeds, Pages deploy skipped (branch guard from PR 1)
- Confirm agent logs show scrapers generated with the new `helpers` parameter in scope

---

## PR 4 — Monorepo Migration

**Must run after PR 3 is merged.** Done on a feature branch; validated by `workflow_dispatch`.

### Workspace layout
```
/                              ← workspace root
  .github/workflows/
    update-feeds.yml           ← paths updated (apps/personal/*)
  package.json                 ← private: true, workspace root only
  pnpm-workspace.yaml          ← packages: ["packages/*", "apps/*"]
  tsconfig.base.json           ← shared compilerOptions
  packages/
    core/                      ← @rss-agentic/core (private: true for now)
      package.json
      tsconfig.json            ← extends ../../tsconfig.base.json
      src/
        index.ts               ← public API barrel: types, runPipeline, renderRss, etc.
        types.ts
        validate.ts
        loader.ts              ← loadSources(), computeSourceHash(), GENERATOR_FORMAT_VERSION
        pipeline.ts            ← runPipeline(opts) — replaces update.ts
        render/
          rss.ts
          index-html.ts
          escape.ts
      scripts/
        generate-source.ts
    cli/                       ← rss-agentic (private: true, unpublished stub)
      package.json             ← has "bin" field pointing to src/index.ts
      tsconfig.json
      src/
        index.ts               ← thin commander wrapper around runPipeline
  apps/
    personal/
      package.json             ← "@rss-agentic/core": "workspace:*"
      tsconfig.json
      sources/*.yml
      src/
        generated/             ← committed scrapers (force-regenerated by format version bump)
        run.ts                 ← calls runPipeline({ sourcesDir, generatedDir, pagesBase, outputDir })
      public/                  ← gitignored
  test/
    servers/
      ssr/                     ← node:http server, static HTML fixtures
      spa/                     ← minimal client-rendered page (no __NEXT_DATA__)
    integration/
      ssr.test.ts
      spa.test.ts
      rendering.test.ts        ← relocated rss.test.ts + index-html.test.ts
```

### Key decisions locked in
- **Generated scraper imports** change from `../../types.js` to `@rss-agentic/core` — update one line in generator prompt
- **Parameters that leave core:** `pagesBase`, `sourcesDir`, `generatedDir`, `outputDir` — all supplied by `apps/personal/src/run.ts`
- **pnpm setup in CI:** add `pnpm/action-setup@v4` before Node setup; `pnpm install --frozen-lockfile`; commands become `pnpm -r test`, `pnpm --filter @rss-agentic/personal start`
- **Playwright cache key** changes from `hashFiles('package.json')` to `hashFiles('pnpm-lock.yaml')`
- **git add path** changes from `src/sources/generated/` to `apps/personal/src/generated/`
- **Pages artifact path** changes from `public/` to `apps/personal/public/`
- **`hashFiles` condition** changes from `public/*.xml` to `apps/personal/public/*.xml`
- **`.npmrc`** (`package-lock=false`) replaced/removed — pnpm uses `pnpm-lock.yaml`

### Rollback
Branch never deploys (PR 1 guard). Reverting the merge returns to pre-monorepo layout; scrapers regenerate on next main run.

---

## PR 5 — Test Infrastructure

Depends on PR 4.

- `test/servers/ssr/`: `node:http` server, hand-crafted listing HTML, stable item count + dates
- `test/servers/spa/`: vanilla JS client-rendered page (listing empty in raw HTML, populated after JS)
- `test/integration/`: hand-written fixture scrapers (no API key); assert `FeedItem[]` and RSS XML snapshots
- SPA fixture test must fail without `helpers.fetchPage` (contract sanity check)
- Relocated `test/rss.test.ts` → `test/integration/rendering.test.ts`

---

## PR 6 — First Pre-Production SPA Source

Depends on PRs 1, 4.

- Add one SPA source (no `__NEXT_DATA__`) to `apps/personal/sources/`
- Criteria: SPA-rendered, content user wants to follow
- `workflow_dispatch` on branch → inspect generated XML artifact
- Merge when feed quality looks right → promotes to live

---

## Package name placeholder

`@rss-agentic/core` / bin `rss-agentic` — rename at publish time (one `package.json` field + sed across imports).
