// Regenerates lib/series-data.json - every series Anime Filler Guide has a conversion page for, with
// its page slug and any alternate titles - from the site's /anime/ index. Anime Filler Guide is the
// main source for lookups, so this list doubles as the autocomplete list of series that actually work.
// Hand-curated extras (nicknames, Fandom wiki hosts, ListFist availability) live in lib/series.js.
//
// Usage: node scripts/update-series.mjs

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripHtml } from "../lib/extraction.js";
import { seriesKey } from "../lib/series.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(__dirname, "..", "lib", "series-data.json");

const response = await fetch("https://www.animefillerguide.com/anime/", {
  headers: { "User-Agent": "Adapt episode chapter finder/1.0" }
});
if (!response.ok) throw new Error(`Anime Filler Guide index returned ${response.status}.`);
const html = await response.text();

const slugify = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const entries = new Map();

for (const [, slug, labelHtml] of html.matchAll(/href="https:\/\/www\.animefillerguide\.com\/anime\/([a-z0-9-]+)\/"[^>]*>([\s\S]*?)<\/a>/g)) {
  const label = stripHtml(labelHtml);
  if (!label || entries.has(slug)) continue;
  // Labels pair titles as "Kimetsu no Yaiba / Demon Slayer". Display the title the page slug was
  // made from (usually the best-known one) and keep the rest as aliases.
  const titles = label.split(/\s+\/\s+/).map((title) => title.trim()).filter(Boolean);
  const nameIndex = Math.max(0, titles.findIndex((title) => slug.startsWith(slugify(title)) || slugify(title).startsWith(slug)));
  const name = titles[nameIndex];
  const aliases = titles.filter((title, index) => index !== nameIndex && seriesKey(title) !== seriesKey(name));
  entries.set(slug, { name, afg: slug, ...(aliases.length ? { aliases } : {}) });
}

if (entries.size < 100) throw new Error(`Only found ${entries.size} series - the index page layout probably changed.`);

const sorted = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
await fs.writeFile(outputPath, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`Wrote ${sorted.length} series to ${path.relative(process.cwd(), outputPath)}`);
