# Agent Instructions

> **Superpower note:** When generating plans, specs, or brainstorms, place generated documents directly in `docs/specs/`. Do not create a `superpowers` or any other intermediate folder.

## Documentation Language

All specifications and implementation plans in this repository must be authored in Chinese. This applies to design specs, implementation plans, review notes, and other project planning documents unless the user explicitly requests another language.

## Architecture Reference

See `ARCHITECTURE.md` for a complete description of the system: file layout, core types, scraper loading priority, agent-generation loop, CI/deployment flow, and instructions for adding new sources.

## Key Conventions

- Each feed source is declared in `sources/{slug}.yml`; no code changes are needed to add a source
- Hand-written scrapers (`src/sources/{slug}.ts`) always take priority over generated ones (`src/sources/generated/{slug}.ts`)
- All scrapers export `fetchFeed(config: FeedConfig): Promise<FeedItem[]>`
- `FeedItem.source` must equal `FeedConfig.slug`
- `FeedConfig.slug` drives both the output path (`public/{slug}.xml`) and the feed URL
- Generated scrapers are committed to git; they are auto-deleted on hard failure and regenerated on the next run
- XML output files are never committed — they are uploaded as GitHub Pages artifacts at CI time
