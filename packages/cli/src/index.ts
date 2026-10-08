#!/usr/bin/env -S npx tsx
import { resolve } from "node:path"
import { runPipeline } from "@rss-agentic/core"

// Minimal CLI surface — flags only. No subcommands yet; this is a stub that
// the future published `rss-agentic` will replace with a commander-based
// surface (`rss-agentic run`, `rss-agentic generate`, etc).
//
// Usage:
//   rss-agentic \
//     --sources <dir> \
//     --generated <dir> \
//     --output <dir> \
//     --pages-base <url>

type Flags = {
  sourcesDir: string
  generatedDir: string
  outputDir: string
  pagesBase: string
}

function parseArgs(argv: string[]): Flags {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a?.startsWith("--")) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`Flag ${a} requires a value`)
      }
      args.set(a.slice(2), next)
      i++
    }
  }
  const need = (name: string): string => {
    const v = args.get(name)
    if (!v) throw new Error(`--${name} is required`)
    return v
  }
  return {
    sourcesDir: resolve(need("sources")),
    generatedDir: resolve(need("generated")),
    outputDir: resolve(need("output")),
    pagesBase: need("pages-base"),
  }
}

const flags = parseArgs(process.argv.slice(2))
const { failed } = await runPipeline(flags)
if (failed > 0) process.exit(1)
