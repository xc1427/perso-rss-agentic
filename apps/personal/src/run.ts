import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { runPipeline } from "@rss-agentic/core"

const __dirname = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(__dirname, "..")

const { failed } = await runPipeline({
  pagesBase: "https://xc1427.github.io/perso-rss-agentic",
  sourcesDir: resolve(appRoot, "sources"),
  generatedDir: resolve(appRoot, "src/generated"),
  outputDir: resolve(appRoot, "public"),
})

if (failed > 0) process.exit(1)
