import { readdirSync, readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { createHash } from "node:crypto"
import { parse as parseYaml } from "yaml"
import type { FeedConfig } from "./types.js"

// Bumped whenever the structural contract between generated scrapers and the
// runtime changes (signature change, type rename, import-path change, etc).
// Mixed into each source-hash so a bump invalidates every cached scraper on
// the next run.
export const GENERATOR_FORMAT_VERSION = "2"

export const SOURCE_HASH_HEADER_RE = /^\/\/ SOURCE_HASH: ([a-f0-9]+)\b/

interface SourceYaml {
  slug: string
  feedTitle: string
  feedDescription: string
  url: string
  agentHints?: string
}

export type LoadedSource = {
  config: FeedConfig
  agentHints?: string
  sourceHash: string
}

export function computeSourceHash(yml: SourceYaml): string {
  const canonical = JSON.stringify({
    formatVersion: GENERATOR_FORMAT_VERSION,
    slug: yml.slug,
    feedTitle: yml.feedTitle,
    feedDescription: yml.feedDescription,
    url: yml.url,
    agentHints: yml.agentHints ?? null,
  })
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16)
}

export function readCachedSourceHash(filePath: string): string | null {
  if (!existsSync(filePath)) return null
  const firstLine = readFileSync(filePath, "utf-8").split("\n", 1)[0] ?? ""
  return firstLine.match(SOURCE_HASH_HEADER_RE)?.[1] ?? null
}

export function loadSources(opts: {
  sourcesDir: string
  pagesBase: string
  outputDir: string
}): LoadedSource[] {
  const { sourcesDir, pagesBase, outputDir } = opts
  const files = readdirSync(sourcesDir).filter((f) => f.endsWith(".yml"))
  return files.map((file) => {
    const raw = readFileSync(resolve(sourcesDir, file), "utf-8")
    const yml = parseYaml(raw) as SourceYaml
    const config: FeedConfig = {
      slug: yml.slug,
      feedTitle: yml.feedTitle,
      feedDescription: yml.feedDescription,
      url: yml.url,
      feedUrl: `${pagesBase}/${yml.slug}.xml`,
      outputXml: `${outputDir}/${yml.slug}.xml`,
    }
    const sourceHash = computeSourceHash(yml)
    return yml.agentHints
      ? { config, agentHints: yml.agentHints, sourceHash }
      : { config, sourceHash }
  })
}
