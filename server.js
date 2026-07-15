import express from "express";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

loadDotEnv(path.join(__dirname, ".env"));

const app = express();
// Render (and most PaaS hosts) put the app behind a single reverse proxy. Without this, req.ip
// resolves to the proxy's internal address for every request, so the per-IP rate limiter below
// would end up rate-limiting all visitors collectively instead of individually.
app.set("trust proxy", 1);
const port = Number(process.env.PORT || 3000);
const cachePath = path.join(__dirname, "data", "cache.json");

function loadDotEnv(filePath) {
  if (!fsSync.existsSync(filePath)) return;
  const lines = fsSync.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (!key || Object.hasOwn(process.env, key)) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));

let cacheWrite = Promise.resolve();

// Generous per-IP fixed-window limiter for the search endpoint: high enough to never bother normal
// (even repeated manual testing) usage, but enough to stop a runaway retry loop or scripted abuse
// from burning through the Tavily/OpenRouter quota. In-memory is fine at this scale (single process).
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;
const rateLimitBuckets = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateLimitBuckets) {
    if (now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) rateLimitBuckets.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const bucket = rateLimitBuckets.get(ip);

  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.set(ip, { windowStart: now, count: 1 });
    return next();
  }

  bucket.count++;
  if (bucket.count > RATE_LIMIT_MAX) {
    return res.status(429).json({
      error: "Too many requests. Please slow down and try again in a moment.",
      status: "not_found",
      matched_range: null,
      source: null
    });
  }
  next();
}

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeDirection(value) {
  if (value === "chapter-to-episode" || value === "chapter_episode") return "chapter-to-episode";
  return "episode-to-chapter";
}

function cacheKey({ anime, number, direction }) {
  return JSON.stringify({
    anime: normalizeText(anime).toLowerCase(),
    number: String(number).trim(),
    direction: normalizeDirection(direction)
  });
}

async function readCache() {
  let raw;
  try {
    raw = await fs.readFile(cachePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error("Cache file is corrupt, treating as empty:", error.message);
    return {};
  }
}

async function writeCache(cache) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const temp = `${cachePath}.tmp`;
  await fs.writeFile(temp, JSON.stringify(cache, null, 2));
  await fs.rename(temp, cachePath);
}

async function getCached(key) {
  const cache = await readCache();
  return cache[key]?.response || null;
}

async function setCached(key, response, request) {
  cacheWrite = cacheWrite.then(async () => {
    const cache = await readCache();
    cache[key] = {
      response,
      request,
      cached_at: new Date().toISOString()
    };
    await writeCache(cache);
  });
  await cacheWrite;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Request to ${String(url)} timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SearchUnavailableError extends Error {}

// Retries `fn` up to `attempts` total tries with a short, linearly increasing backoff between
// attempts (so a transient timeout/connection error/5xx doesn't fail the whole lookup outright).
async function withRetry(fn, { attempts = 3, baseDelayMs = 1000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await sleep(baseDelayMs * (attempt + 1));
    }
  }
  throw lastError;
}

function selectedProvider() {
  const explicit = normalizeText(process.env.SEARCH_PROVIDER).toLowerCase();
  if (explicit === "tavily" || explicit === "brave") return explicit;
  if (process.env.TAVILY_API_KEY) return "tavily";
  if (process.env.BRAVE_API_KEY) return "brave";
  throw new Error("Set TAVILY_API_KEY or BRAVE_API_KEY.");
}

function buildSearchQuery(anime, number, direction) {
  const from = direction === "episode-to-chapter" ? "episode" : "chapter";
  const to = direction === "episode-to-chapter" ? "manga chapter" : "anime episode";
  return [
    `"${anime}" "${from} ${number}" "${to}"`,
    "(site:listfist.com OR site:animefillerguide.com OR site:fandom.com)",
    "adapted chapters episodes statistics"
  ].join(" ");
}

async function searchTavily(query) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error("TAVILY_API_KEY is not set.");

  let data;
  try {
    data = await withRetry(async () => {
      const response = await fetchWithTimeout("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${key}`
        },
        body: JSON.stringify({
          query,
          search_depth: "basic",
          max_results: 8,
          include_answer: false,
          include_raw_content: true,
          include_domains: ["listfist.com", "animefillerguide.com", "fandom.com"]
        })
      });
      if (!response.ok) throw new Error(`Tavily search failed with ${response.status}.`);
      return response.json();
    }, { attempts: 3, baseDelayMs: 1000 });
  } catch (error) {
    if (process.env.ADAPT_DEBUG) console.log("TAVILY RETRIES EXHAUSTED", error.message);
    throw new SearchUnavailableError("Search is temporarily unavailable. Please try again in a moment.");
  }

  return (data.results || []).map((item) => ({
    title: item.title || "",
    url: item.url || "",
    snippet: item.raw_content || item.content || item.snippet || ""
  }));
}

async function searchBrave(query) {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new Error("BRAVE_API_KEY is not set.");

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "8");
  url.searchParams.set("text_decorations", "false");

  const response = await fetchWithTimeout(url, {
    headers: {
      "Accept": "application/json",
      "X-Subscription-Token": key
    }
  });

  if (!response.ok) throw new Error(`Brave search failed with ${response.status}.`);
  const data = await response.json();
  return (data.web?.results || []).map((item) => ({
    title: item.title || "",
    url: item.url || "",
    snippet: item.description || ""
  }));
}

async function runSearch(anime, number, direction) {
  const provider = selectedProvider();
  const query = buildSearchQuery(anime, number, direction);
  const results = provider === "tavily" ? await searchTavily(query) : await searchBrave(query);
  return {
    provider,
    query,
    results: await enrichResults({
      anime,
      number,
      direction,
      results: results.filter((item) => item.snippet || item.title || item.url).slice(0, 8)
    })
  };
}

function animeSlugVariants(anime) {
  const compact = anime.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const dashed = anime.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return [...new Set([compact, dashed].filter(Boolean))];
}

function fandomHostsFromResults(anime, results) {
  const hosts = new Set(animeSlugVariants(anime).map((slug) => `${slug}.fandom.com`));
  for (const item of results) {
    try {
      const host = new URL(item.url).hostname.toLowerCase();
      if (host.endsWith(".fandom.com")) hosts.add(host);
    } catch {}
  }
  return [...hosts];
}

function directSourceCandidates({ anime, number, direction, results }) {
  const page = direction === "episode-to-chapter" ? `Episode_${number}` : `Chapter_${number}`;
  return fandomHostsFromResults(anime, results).map((host) => `https://${host}/wiki/${page}`);
}

function animeSlug(anime) {
  return anime.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function listFistCandidateUrls(anime) {
  const slug = animeSlug(anime);
  if (!slug) return [];
  // This single page tracks both directions (it lists each episode alongside its source chapter(s)).
  return [`https://listfist.com/list-of-${slug}-episode-to-chapter-conversion`];
}

function animeFillerGuideCandidateUrls(anime) {
  const slug = animeSlug(anime);
  if (!slug) return [];
  // Covers series ListFist doesn't track, and explicitly labels each episode Filler/Canon/Mixed
  // alongside its source chapter(s) - the clearest signal for the "filler" (no manga source) case.
  return [`https://www.animefillerguide.com/${slug}/`];
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchPageText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Adapt episode chapter finder/1.0"
      }
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return null;
    return stripHtml(await response.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Fetches `url` and inserts/replaces its entry in `enriched` (keyed by url) with the full fetched
// text. Search APIs sometimes already return one of these known tracker/wiki pages but only with a
// short marketing snippet (no chapter data) - a thin existing entry must still be upgraded to the
// full page text, not skipped, or the answer that page actually contains is silently dropped.
async function fetchAndUpsert(enriched, url, title) {
  const text = await fetchPageText(url);
  if (process.env.ADAPT_DEBUG) console.log("FETCH_AND_UPSERT", url, text ? `ok len=${text.length}` : "FAILED/null");
  if (!text) return;
  const entry = { title, url, snippet: text };
  const existingIndex = enriched.findIndex((item) => item.url === url);
  if (existingIndex === -1) {
    enriched.unshift(entry);
  } else {
    enriched[existingIndex] = entry;
  }
}

async function enrichResults({ anime, number, direction, results }) {
  const enriched = [...results];
  const directUrls = directSourceCandidates({ anime, number, direction, results });
  const pageLabel = direction === "episode-to-chapter" ? "Episode" : "Chapter";

  for (const url of directUrls) {
    await fetchAndUpsert(enriched, url, `${anime} ${pageLabel} ${number}`);
  }

  // Tabular conversion trackers often don't surface well as generic search snippets, so fetch the
  // known tracker pages directly rather than relying on search hits.
  for (const url of listFistCandidateUrls(anime)) {
    await fetchAndUpsert(enriched, url, `${anime} Episode to Chapter Conversion List`);
  }
  for (const url of animeFillerGuideCandidateUrls(anime)) {
    await fetchAndUpsert(enriched, url, `${anime} Filler List & Episode to Chapter Conversion Guide`);
  }

  return enriched.slice(0, 12);
}

function relevantTextWindow(text, { number, direction }) {
  const normalized = normalizeText(text);
  const fromLabel = direction === "episode-to-chapter" ? "episode" : "chapter";
  const toLabel = direction === "episode-to-chapter" ? "chapter" : "episode";
  const needles = [
    `${fromLabel} ${number}`,
    `${fromLabel.charAt(0).toUpperCase()}${fromLabel.slice(1)} ${number}`,
    "Statistics",
    `${toLabel}s`,
    `${toLabel.charAt(0).toUpperCase()}${toLabel.slice(1)}s`
  ];
  const windows = [];

  for (const needle of needles) {
    const index = normalized.toLowerCase().indexOf(needle.toLowerCase());
    if (index === -1) continue;
    const start = Math.max(0, index - 700);
    const end = Math.min(normalized.length, index + 1700);
    windows.push(normalized.slice(start, end));
  }

  // Tabular conversion trackers (e.g. ListFist, Anime Filler Guide) list rows as a flat
  // "<number>. <Title...> <values>" sequence with no "episode"/"chapter" word next to every value,
  // so on long pages the needles above can miss the target row entirely (it may be far past the
  // first "chapters"/"episodes" match near the page header). Anchor on row-start occurrences of the
  // requested number: a bare number immediately followed by a title (capital letter or "(duration)"),
  // which is what marks the start of a new row and avoids matching stray numbers (durations, dates,
  // other rows' chapter values) elsewhere on the page.
  // `0*` absorbs zero-padded row numbers (e.g. Anime Filler Guide writes episode 12 as "012.");
  // the lookbehind still anchors on the character before those leading zeros, not before the digits
  // of the requested number itself, so it won't accidentally match "12" inside e.g. "112.".
  const rowStartPattern = new RegExp(`(?<![\\d.])0*${escapeRegExp(number)}\\.?\\s*[(A-Z]`, "g");
  let match;
  let extraWindows = 0;
  while (extraWindows < 4 && (match = rowStartPattern.exec(normalized))) {
    const start = Math.max(0, match.index - 300);
    const end = Math.min(normalized.length, match.index + 1200);
    windows.push(normalized.slice(start, end));
    extraWindows++;
  }

  return [...new Set(windows)].join(" ... ").slice(0, 6000) || normalized.slice(0, 2000);
}

function statisticsWindow(text) {
  const normalized = normalizeText(text);
  const index = normalized.toLowerCase().indexOf("statistics");
  if (index === -1) return normalized.slice(0, 5000);
  return normalized.slice(index, index + 2500);
}

function requestedPagePattern(direction, number) {
  const pageType = direction === "episode-to-chapter" ? "Episode" : "Chapter";
  return new RegExp(`\\.fandom\\.com\\/wiki\\/${pageType}_${escapeRegExp(number)}(?:$|[?#])`, "i");
}

function directMappingFromText(item, { direction, number }) {
  if (!requestedPagePattern(direction, number).test(item.url)) return null;

  const window = statisticsWindow(item.snippet);

  if (direction === "episode-to-chapter") {
    const chapter = window.match(/\bChapter\s+(\d+(?:\.\d+)?)/i);
    if (!chapter) return null;
    return {
      status: "found",
      matched_range: `Chapter ${chapter[1]}`,
      source: item.url
    };
  }

  const episode = window.match(/\bEpisode\s+(\d+(?:\.\d+)?)/i);
  if (!episode) return null;
  return {
    status: "found",
    matched_range: `Episode ${episode[1]}`,
    source: item.url
  };
}

function directMappingFromResults({ number, direction, results }) {
  for (const item of results) {
    const direct = directMappingFromText(item, { direction, number });
    if (direct) return direct;
  }
  return null;
}

function compactResults(results, request) {
  return results.map((item, index) => {
    const title = normalizeText(item.title);
    const url = normalizeText(item.url);
    const snippet = relevantTextWindow(item.snippet, request);
    return `SOURCE ${index + 1}\nTitle: ${title}\nURL: ${url}\nText: ${snippet}`;
  }).join("\n\n");
}

function strictExtractionPrompt({ anime, number, direction, results }) {
  const fromLabel = direction === "episode-to-chapter" ? "episode" : "chapter";
  const toLabel = direction === "episode-to-chapter" ? "chapter" : "episode";
  const from = direction === "episode-to-chapter" ? "anime episode" : "manga chapter";
  const to = direction === "episode-to-chapter" ? "manga chapter range" : "anime episode range";
  return [
    "You extract anime/manga adaptation mappings from provided search result text only.",
    "Return only valid JSON matching this exact shape, with no markdown, no code fences, and no commentary before or after it:",
    '{"status": "found"|"filler"|"not_found", "matched_range": string|null, "source": string|null}',
    "",
    `There are exactly two kinds of numbers in play: the ${fromLabel.toUpperCase()} number (what the user is asking about) and the ${toLabel.toUpperCase()} number (what you must return). These are never the same axis - do not swap them.`,
    `- The number ${number} you were given IS the ${fromLabel} number. It is input, not output.`,
    `- Your answer (matched_range) must be expressed as ${toLabel} number(s), never as a repetition of the ${fromLabel} number.`,
    `- Source text may label these as "${fromLabel}" / "${toLabel}", abbreviations (e.g. "Ep."/"Ch."), or as table/list columns without the word spelled out next to every value (e.g. a row or column clearly headed "Chapter(s)" or "Episode" in a statistics/adaptation table). Table and list formatting alone is not a reason to reject an answer - read column/row headers and adjacent labels to determine which number is which.`,
    "",
    "There are three possible statuses:",
    '- "found": the requested item is clearly mapped to a specific target range in the provided text. matched_range and source are both required.',
    `- "filler": the source text explicitly states the requested ${fromLabel} is anime-original / filler / non-canon / not adapted from the manga (e.g. an "Anime-only" or "Filler" statistics field, or a filler-list entry naming this exact ${fromLabel}). This status only applies when going from episode to chapter. matched_range must be null; source must be the URL that explicitly confirms this.`,
    '- "not_found": you could not clearly determine an answer from the provided text (no mapping found, no filler confirmation found, ambiguous, or conflicting sources).',
    "",
    "Hard rules:",
    "- Use only numbers explicitly present in the provided source titles, URLs, or snippets.",
    "- Never infer, estimate, interpolate, rely on memory, or fabricate a number.",
    '- If the exact requested item is not clearly mapped to the target range AND not explicitly confirmed as filler in the provided text, return status "not_found".',
    "- The cited source text must explicitly mention the requested item and the returned target item, each with their correct label (episode vs. chapter), either in prose or in a clearly labeled table/list row. For filler, the cited source text must explicitly mention the requested item alongside a filler/anime-original/non-canon designation.",
    '- If multiple sources conflict or the text is ambiguous, return status "not_found".',
    "- source must be the URL of the result that explicitly supports the answer, otherwise null.",
    "- matched_range should be concise, such as \"Chapters 45-47\" or \"Episodes 12-13\", and must use the target label, never the requested-item label. It must be null unless status is \"found\".",
    "",
    `Anime title: ${anime}`,
    `Requested ${from}: ${number}`,
    `Target: ${to}`,
    `Direction: ${direction}`,
    "",
    "Search results:",
    compactResults(results, { number, direction })
  ].join("\n");
}

function stripCodeFences(value) {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenced ? fenced[1].trim() : value;
}

function firstBalancedJsonObject(value) {
  const start = value.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < value.length; i++) {
    const char = value[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) return value.slice(start, i + 1);
    }
  }
  return null;
}

function parseModelJson(content) {
  const cleaned = stripCodeFences(String(content || "").trim());

  try {
    return JSON.parse(cleaned);
  } catch {
    // Fall through to structural extraction below.
  }

  const balanced = firstBalancedJsonObject(cleaned);
  if (balanced) {
    try {
      return JSON.parse(balanced);
    } catch {
      // Fall through to the looser regex fallback below.
    }
  }

  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Extractor did not return JSON.");
  try {
    return JSON.parse(match[0]);
  } catch {
    throw new Error("Extractor returned malformed JSON.");
  }
}

function normalizeExtractorResponse(value) {
  const status = value?.status === "found" || value?.status === "filler" ? value.status : "not_found";

  if (status === "found") {
    const matchedRange = typeof value.matched_range === "string" ? normalizeText(value.matched_range) : null;
    const source = typeof value.source === "string" ? normalizeText(value.source) : null;
    if (!matchedRange || !source) return { status: "not_found", matched_range: null, source: null };
    return { status: "found", matched_range: matchedRange, source };
  }

  if (status === "filler") {
    const source = typeof value.source === "string" ? normalizeText(value.source) : null;
    if (!source) return { status: "not_found", matched_range: null, source: null };
    return { status: "filler", matched_range: null, source };
  }

  return { status: "not_found", matched_range: null, source: null };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function numbersFromText(value) {
  return [...String(value || "").matchAll(/\d+(?:\.\d+)?/g)].map((match) => match[0]);
}

function sourceText(item) {
  return normalizeText([item?.title, item?.url, item?.snippet].filter(Boolean).join(" "));
}

function findCitedSource(results, source) {
  const normalizedSource = normalizeText(source).toLowerCase();
  return results.find((item) => normalizeText(item.url).toLowerCase() === normalizedSource);
}

function labelNumberPattern(label, number) {
  const escapedNumber = escapeRegExp(number);
  const labelPattern = label === "episode" ? "episodes?|eps?\\.?" : "chapters?|chs?\\.?";
  return new RegExp(`(?:${labelPattern}\\W{0,24}${escapedNumber}|${escapedNumber}\\W{0,24}${labelPattern})`, "i");
}

function containsLabeledNumber(text, label, number) {
  return labelNumberPattern(label, number).test(text);
}

function containsFillerKeyword(text) {
  return /\b(filler|anime[\s-]?original|non[\s-]?canon|not\s+(?:based on|adapted|from)\b.*manga)\b/i.test(text)
    || /\b(?:manga\s+)?chapters?\s*[:\-]?\s*(?:none|n\/a|-)\b/i.test(text)
    || /\bno\s+(?:corresponding\s+)?(?:manga\s+)?chapters?\b/i.test(text);
}

function validateAgainstSource(response, { number, direction, results }) {
  if (response.status === "not_found") return response;

  const cited = findCitedSource(results, response.source);
  if (!cited) return { status: "not_found", matched_range: null, source: null };

  const fromLabel = direction === "episode-to-chapter" ? "episode" : "chapter";
  const text = sourceText(cited);
  const hasRequestedItem = containsLabeledNumber(text, fromLabel, number);

  if (response.status === "filler") {
    if (!hasRequestedItem || !containsFillerKeyword(text)) {
      return { status: "not_found", matched_range: null, source: null };
    }
    return response;
  }

  const targetPageType = direction === "episode-to-chapter" ? "Chapter" : "Episode";
  const wrongSameNumberPage = new RegExp(`\\.fandom\\.com\\/wiki\\/${targetPageType}_${escapeRegExp(number)}(?:$|[?#])`, "i");
  if (wrongSameNumberPage.test(cited.url)) {
    return { status: "not_found", matched_range: null, source: null };
  }

  const toLabel = direction === "episode-to-chapter" ? "chapter" : "episode";
  const targetNumbers = numbersFromText(response.matched_range);
  const hasTargetItem = targetNumbers.some((targetNumber) => containsLabeledNumber(text, toLabel, targetNumber));

  if (!hasRequestedItem || !hasTargetItem) {
    return { status: "not_found", matched_range: null, source: null };
  }

  return response;
}

function candidateModels() {
  const primary = normalizeText(process.env.OPENROUTER_MODEL);
  const fallbacks = normalizeText(process.env.OPENROUTER_FALLBACK_MODELS)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set([primary, ...fallbacks].filter(Boolean))];
}

async function callOpenRouterModel(model, { anime, number, direction, results }) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set.");

  const response = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
      "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
      "X-Title": process.env.APP_NAME || "Adapt"
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: Number(process.env.OPENROUTER_MAX_TOKENS || 2000),
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You are a strict extraction engine. You must answer from the supplied text only."
        },
        {
          role: "user",
          content: strictExtractionPrompt({ anime, number, direction, results })
        }
      ]
    })
  }, 30000);

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`OpenRouter extraction failed with ${response.status}. ${details}`.trim());
  }

  const data = await response.json();
  if (process.env.ADAPT_DEBUG) console.log(`FULL OPENROUTER RESPONSE (${model})`, JSON.stringify(data, null, 2).slice(0, 3000));
  if (data.error) {
    throw new Error(`OpenRouter model ${model} returned an error: ${data.error.message || JSON.stringify(data.error)}`);
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content || !String(content).trim()) {
    throw new Error(`OpenRouter model ${model} returned an empty response.`);
  }
  if (data.choices?.[0]?.finish_reason === "length") {
    throw new Error(`OpenRouter model ${model} response was truncated (hit max_tokens) before completing.`);
  }
  if (process.env.ADAPT_DEBUG) console.log(`RAW LLM CONTENT (${model})`, content);
  return normalizeExtractorResponse(parseModelJson(content));
}

// Free-tier OpenRouter models are prone to transient provider-side rate limits ("worker request
// limit reached") and occasional malformed/truncated output. Try each configured model in order
// (OPENROUTER_MODEL first, then OPENROUTER_FALLBACK_MODELS) and use the first one that completes
// successfully - a model saying "not found" is a valid answer and is NOT retried against the next
// model, only actual call failures (rate limits, empty/malformed/truncated output) trigger a retry.
async function extractWithOpenRouter({ anime, number, direction, results }) {
  const models = candidateModels();
  if (!models.length) throw new Error("OPENROUTER_MODEL is not set.");

  let lastError;
  for (const model of models) {
    try {
      const extracted = await callOpenRouterModel(model, { anime, number, direction, results });
      if (process.env.ADAPT_DEBUG) console.log(`NORMALIZED (${model})`, extracted);
      const validated = validateAgainstSource(extracted, { number, direction, results });
      if (process.env.ADAPT_DEBUG) console.log(`VALIDATED (${model})`, validated);
      return validated;
    } catch (error) {
      lastError = error;
      if (process.env.ADAPT_DEBUG) console.log(`MODEL FAILED (${model})`, error.message);
    }
  }
  throw lastError;
}

app.post("/api/lookup", rateLimit, async (req, res) => {
  const anime = normalizeText(req.body?.anime);
  const number = normalizeText(req.body?.number);
  const direction = normalizeDirection(req.body?.direction);

  if (!anime || !number || !/^\d+([.-]\d+)?$/.test(number)) {
    return res.status(400).json({ error: "Provide anime, number, and direction." });
  }

  const refresh = req.body?.refresh === true;
  const key = cacheKey({ anime, number, direction });
  if (!refresh) {
    const cached = await getCached(key);
    if (cached) return res.json({ ...cached, cached: true });
  }

  try {
    const search = await runSearch(anime, number, direction);
    if (process.env.ADAPT_DEBUG) {
      console.log("QUERY", search.query);
      console.log("RESULTS", search.results.map((r) => ({ title: r.title, url: r.url, len: r.snippet.length })));
    }
    const direct = directMappingFromResults({ number, direction, results: search.results });
    const response = direct || (search.results.length
      ? await extractWithOpenRouter({ anime, number, direction, results: search.results })
      : { status: "not_found", matched_range: null, source: null });

    // Only cache confirmed, validated answers (found or filler). A "not_found" result may simply
    // mean this attempt's search results were incomplete, not that no answer exists — caching it
    // would permanently poison the key for future (possibly better) lookups.
    const isConfirmed = (response.status === "found" && response.matched_range && response.source)
      || (response.status === "filler" && response.source);
    if (isConfirmed) {
      await setCached(key, response, {
        anime,
        number,
        direction,
        provider: search.provider,
        query: search.query
      });
    }

    res.json({ ...response, cached: false });
  } catch (error) {
    console.error(error);
    if (error instanceof SearchUnavailableError) {
      // Not a "no mapping exists" result and not a hard failure either - just search infra being
      // down after retries. Must not be cached or reported as not_found, or a transient outage would
      // permanently poison this key and users would (wrongly) see "no answer" instead of "try again."
      return res.status(503).json({
        error: error.message,
        status: "search_unavailable",
        matched_range: null,
        source: null
      });
    }
    res.status(502).json({
      error: error.message || "Lookup failed.",
      status: "not_found",
      matched_range: null,
      source: null
    });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    search_provider: (() => {
      try {
        return selectedProvider();
      } catch {
        return null;
      }
    })(),
    openrouter_model_configured: Boolean(normalizeText(process.env.OPENROUTER_MODEL))
  });
});

app.listen(port, () => {
  console.log(`Adapt running at http://localhost:${port}`);
});
