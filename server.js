import express from "express";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXTRACTOR_RESPONSE_FORMAT,
  READING_START_RESPONSE_FORMAT,
  THIN_SNIPPET_THRESHOLD,
  TransientModelError,
  cacheKey,
  directMappingFromResults,
  fandomApiUrl,
  interpretOpenRouterResponse,
  normalizeDirection,
  normalizeExtractorResponse,
  normalizeMovieName,
  normalizeReadingStartResponse,
  normalizeText,
  parseInfoboxFields,
  readingStartPrompt,
  strictExtractionPrompt,
  strictMovieExtractionPrompt,
  stripHtml,
  validateAgainstSource,
  validateMovieAgainstSource,
  validateReadingStart
} from "./lib/extraction.js";
import { resolveSeries, seriesList } from "./lib/series.js";

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

async function getCached(key, maxAgeMs = Infinity) {
  const cache = await readCache();
  const entry = cache[key];
  if (!entry?.response) return null;
  if (Date.now() - Date.parse(entry.cached_at) > maxAgeMs) return null;
  return entry.response;
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

// Search infra (Tavily/Brave) or every configured extractor model being down after retries. Neither
// means "no mapping exists", so these surface to the user as "try again" rather than not_found.
class SearchUnavailableError extends Error {}
class ExtractorUnavailableError extends Error {}

// Retries `fn` up to `attempts` total tries with a short, linearly increasing backoff between
// attempts (so a transient timeout/connection error/5xx doesn't fail the whole lookup outright).
// `shouldRetry` can veto a retry for errors that would just fail the same way again; `onRetry` is
// told before each retry.
async function withRetry(fn, { attempts = 3, baseDelayMs = 1000, shouldRetry = () => true, onRetry = () => {} } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1 || !shouldRetry(error)) break;
      onRetry(error);
      await sleep(baseDelayMs * (attempt + 1));
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

// Movies don't have an episode number to search for - they map to a chapter range or a named arc,
// so the query targets that phrasing directly instead of the "episode N" pattern used above.
function buildMovieSearchQuery(anime, movieName) {
  return [
    `"${anime}" "${movieName}" manga chapter equivalent corresponding arc`,
    "(site:listfist.com OR site:animefillerguide.com OR site:fandom.com)",
    "adapted chapters arc statistics"
  ].join(" ");
}

function buildReadingStartQuery(anime) {
  return [
    `"${anime}" where does the anime end which manga chapter to start reading after the anime`,
    "(site:animefillerguide.com OR site:fandom.com)"
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

  let data;
  try {
    data = await withRetry(async () => {
      const response = await fetchWithTimeout(url, {
        headers: {
          "Accept": "application/json",
          "X-Subscription-Token": key
        }
      });
      if (!response.ok) throw new Error(`Brave search failed with ${response.status}.`);
      return response.json();
    }, { attempts: 3, baseDelayMs: 1000 });
  } catch (error) {
    if (process.env.ADAPT_DEBUG) console.log("BRAVE RETRIES EXHAUSTED", error.message);
    throw new SearchUnavailableError("Search is temporarily unavailable. Please try again in a moment.");
  }

  return (data.web?.results || []).map((item) => ({
    title: item.title || "",
    url: item.url || "",
    snippet: item.description || ""
  }));
}

async function searchWith(provider, query) {
  const results = provider === "tavily" ? await searchTavily(query) : await searchBrave(query);
  return results.filter((item) => item.snippet || item.title || item.url).slice(0, 8);
}

function animeSlug(anime) {
  return anime.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function animeSlugVariants(anime) {
  const compact = anime.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const dashed = animeSlug(anime);
  return [...new Set([compact, dashed].filter(Boolean))];
}

// Known series come from the registry (lib/series.js), which knows each one's real source URLs.
// Anything else falls back to guessing them from the typed name.
function describeSeries(input) {
  const known = resolveSeries(input);
  if (known) return known;
  const slug = animeSlug(input);
  return { name: input, aliases: [], afg: slug || null, listfist: slug || null, fandom: null };
}

// The Fandom wikis trusted to be about this series: the registry's for known series, otherwise hosts
// guessed from the name. Search results can't widen this - they routinely include same-numbered pages
// from unrelated wikis.
function trustedFandomHosts(series) {
  return series.fandom ? [series.fandom] : animeSlugVariants(series.name).map((slug) => `${slug}.fandom.com`);
}

function directSourceCandidates({ series, number, direction }) {
  const page = direction === "episode-to-chapter" ? `Episode_${number}` : `Chapter_${number}`;
  return trustedFandomHosts(series).map((host) => `https://${host}/wiki/${page}`);
}

// Tabular conversion trackers often don't surface well as generic search snippets, so fetch the
// known tracker pages directly rather than relying on search hits. ListFist's single page tracks both
// directions (each episode alongside its source chapter(s)); Anime Filler Guide covers far more series
// and explicitly labels each episode Filler/Canon/Mixed - the clearest signal for the filler case.
function trackerPages(series) {
  const pages = [];
  if (series.listfist) {
    pages.push({
      url: `https://listfist.com/list-of-${series.listfist}-episode-to-chapter-conversion`,
      title: `${series.name} Episode to Chapter Conversion List`
    });
  }
  if (series.afg) {
    pages.push({
      url: `https://www.animefillerguide.com/anime/${series.afg}/`,
      title: `${series.name} Filler List & Episode to Chapter Conversion Guide`
    });
  }
  return pages;
}

// Returns the page's HTML, or the parsed body for JSON responses (the Fandom API), or null.
async function fetchBodyOnce(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Adapt episode chapter finder/1.0"
      }
    });
    // 4xx (e.g. a Cloudflare bot-block 403, a genuine 404) is not going to change on retry within
    // the same request, so treat it as a permanent miss rather than burning time retrying it. Only
    // 5xx and network-level failures (timeout, connection reset) are worth retrying - those are the
    // ones likely to be transient.
    if (response.status >= 500) throw new Error(`fetch ${url} failed with ${response.status}`);
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) return response.json();
    if (!contentType.includes("text/html")) return null;
    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBody(url) {
  try {
    return await withRetry(() => fetchBodyOnce(url), { attempts: 2, baseDelayMs: 500 });
  } catch {
    return null;
  }
}

// Fandom articles go through the MediaWiki API (plain page requests get a 403), which also yields the
// infobox fields that power the no-LLM fast path. Everything else is fetched as a normal page.
async function fetchSourcePage(url) {
  const apiUrl = fandomApiUrl(url);
  if (apiUrl) {
    const data = await fetchBody(apiUrl);
    const html = data?.parse?.text;
    if (typeof html !== "string") return null;
    return { snippet: stripHtml(html), infobox: parseInfoboxFields(html) };
  }
  const html = await fetchBody(url);
  return typeof html === "string" ? { snippet: stripHtml(html) } : null;
}

// Fetches all pages concurrently - each one can take several seconds (or a full timeout plus a
// retry), so fetching them one after another made every slow source add to the lookup time.
async function fetchPages(pages) {
  const fetched = await Promise.all(pages.map(({ url }) => fetchSourcePage(url)));
  return pages.map((page, index) => {
    const content = fetched[index];
    if (process.env.ADAPT_DEBUG) console.log("FETCH_PAGE", page.url, content ? `ok len=${content.snippet.length}${content.infobox ? ` infobox=${content.infobox.length}` : ""}` : "FAILED/null");
    return { ...page, ...content };
  });
}

// Search hits on Fandom often come back as a one-line preview. Re-fetch a few of those through the API
// so the extractor sees the full article instead - only from the series' own wiki when it's known, so
// pages from unrelated wikis don't get upgraded into full-confidence sources.
function thinFandomResults(results, alreadyFetching, series) {
  return results
    .filter((item) => item.snippet.length < THIN_SNIPPET_THRESHOLD && fandomApiUrl(item.url) && !alreadyFetching.includes(item.url))
    .filter((item) => !series.fandom || new URL(item.url).hostname.toLowerCase() === series.fandom)
    .slice(0, 3)
    .map(({ url, title }) => ({ url, title }));
}

// Upserts each successfully fetched page into the search results (keyed by url) with its full text,
// applied in the given order so the final ordering doesn't depend on which fetch finished first.
// Search APIs sometimes already return one of these known tracker/wiki pages but only with a short
// marketing snippet (no chapter data) - a thin existing entry must still be upgraded to the full page
// text, not skipped, or the answer that page actually contains is silently dropped.
function mergeFetchedPages(results, pages) {
  const merged = [...results];
  for (const { title, url, snippet, infobox } of pages) {
    if (!snippet) continue;
    const entry = { title, url, snippet, ...(infobox ? { infobox } : {}) };
    const existingIndex = merged.findIndex((item) => item.url === url);
    if (existingIndex === -1) {
      merged.unshift(entry);
    } else {
      merged[existingIndex] = entry;
    }
  }
  return merged.slice(0, 12);
}

// Shared shape of every lookup's retrieval step: search while the tracker pages download, then fetch
// whatever Fandom pages the search results point at, and merge it all into one source list.
async function gatherSources({ series, query, fandomPages = () => [] }, progress) {
  const provider = selectedProvider();
  progress("Searching the web");
  const trackerFetch = fetchPages(trackerPages(series));
  // When the series' wiki is known, hits from other Fandom wikis are about other series.
  const results = (await searchWith(provider, query)).filter((item) => {
    if (!series.fandom || !fandomApiUrl(item.url)) return true;
    return new URL(item.url).hostname.toLowerCase() === series.fandom;
  });

  const wikiPages = fandomPages(results);
  const upgrades = thinFandomResults(results, wikiPages.map((page) => page.url), series);
  if (wikiPages.length || upgrades.length) progress("Checking the wiki");
  const [wikiFetched, trackersFetched] = await Promise.all([fetchPages([...wikiPages, ...upgrades]), trackerFetch]);
  const merged = mergeFetchedPages(results, [...wikiFetched, ...trackersFetched]);

  if (process.env.ADAPT_DEBUG) {
    console.log("QUERY", query);
    console.log("RESULTS", merged.map((r) => ({ title: r.title, url: r.url, len: r.snippet.length, infobox: Boolean(r.infobox) })));
  }
  progress(`Reading ${merged.length} source${merged.length === 1 ? "" : "s"}`);
  return { provider, query, results: merged };
}

function candidateModels() {
  const primary = normalizeText(process.env.OPENROUTER_MODEL);
  const fallbacks = normalizeText(process.env.OPENROUTER_FALLBACK_MODELS)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set([primary, ...fallbacks].filter(Boolean))];
}

async function callOpenRouterModel(model, promptText, { responseFormat, normalize }) {
  const response = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
      "X-Title": process.env.APP_NAME || "Adapt"
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: Number(process.env.OPENROUTER_MAX_TOKENS || 2000),
      response_format: responseFormat,
      messages: [
        {
          role: "system",
          content: "You are a strict extraction engine. You must answer from the supplied text only."
        },
        {
          role: "user",
          content: promptText
        }
      ]
    })
  }, 30000);

  const body = await response.text().catch(() => "");
  if (process.env.ADAPT_DEBUG) console.log(`FULL OPENROUTER RESPONSE (${model}, HTTP ${response.status})`, body.slice(0, 3000));
  return interpretOpenRouterResponse(model, response.status, body, normalize);
}

// Free-tier OpenRouter models are prone to transient provider-side failures ("Service temporarily
// overloaded", rate limits) and occasional malformed/empty output. Each configured model
// (OPENROUTER_MODEL first, then OPENROUTER_FALLBACK_MODELS) gets one retry for those transient
// failures before moving on to the next model; failures that would only repeat (bad request, unknown
// model, truncated output, a 30s timeout) skip straight to the next model. A model saying "not
// found" is a valid answer and is NOT retried against the next model.
async function extractWithModelFallback(promptText, validateFn, progress, {
  responseFormat = EXTRACTOR_RESPONSE_FORMAT,
  normalize = normalizeExtractorResponse
} = {}) {
  const models = candidateModels();
  if (!models.length) throw new Error("OPENROUTER_MODEL is not set.");
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set.");

  let lastError;
  for (const [index, model] of models.entries()) {
    progress(index === 0 ? "Asking the extractor" : "Trying a backup model");
    try {
      const extracted = await withRetry(() => callOpenRouterModel(model, promptText, { responseFormat, normalize }), {
        attempts: 2,
        baseDelayMs: 1500,
        shouldRetry: (error) => error instanceof TransientModelError,
        onRetry: () => progress("Extractor busy, retrying")
      });
      if (process.env.ADAPT_DEBUG) console.log(`NORMALIZED (${model})`, extracted);
      const validated = validateFn(extracted);
      if (process.env.ADAPT_DEBUG) console.log(`VALIDATED (${model})`, validated);
      return validated;
    } catch (error) {
      lastError = error;
      if (process.env.ADAPT_DEBUG) console.log(`MODEL FAILED (${model})`, error.message);
    }
  }
  throw new ExtractorUnavailableError(
    "The answer extractor is busy right now. Please try again in a moment.",
    { cause: lastError }
  );
}

const NOT_FOUND = Object.freeze({ status: "not_found", matched_range: null, source: null });

// Only cache confirmed, validated answers. A "not_found" result may simply mean this attempt's search
// results were incomplete, not that no answer exists - caching it would permanently poison the key
// for future (possibly better) lookups.
function isConfirmed(response) {
  return Boolean((response.status === "found" && response.matched_range && response.source)
    || ((response.status === "filler" || response.status === "complete") && response.source));
}

// Runs `compute` unless a fresh enough cached answer exists, and caches what it confirms. The response
// always carries the canonical series name, so the UI can show "Demon Slayer" for "Kimetsu no Yaiba".
async function cachedLookup({ key, series, refresh, maxAgeMs, request }, compute) {
  if (!refresh) {
    const cached = await getCached(key, maxAgeMs);
    if (cached) return { ...cached, series: series.name, cached: true };
  }
  const { response, search } = await compute();
  if (isConfirmed(response)) {
    await setCached(key, response, { ...request, provider: search.provider, query: search.query });
  }
  return { ...response, series: series.name, cached: false };
}

function lookupEpisode({ series, number, direction, refresh }, progress) {
  const anime = series.name;
  return cachedLookup({ key: cacheKey({ anime, number, direction }), series, refresh, request: { anime, number, direction } }, async () => {
    const pageLabel = direction === "episode-to-chapter" ? "Episode" : "Chapter";
    const search = await gatherSources({
      series,
      query: buildSearchQuery(anime, number, direction),
      fandomPages: () => directSourceCandidates({ series, number, direction })
        .map((url) => ({ url, title: `${anime} ${pageLabel} ${number}` }))
    }, progress);

    const direct = directMappingFromResults({ number, direction, results: search.results, trustedHosts: trustedFandomHosts(series) });
    if (direct) return { response: direct, search };
    if (!search.results.length) return { response: NOT_FOUND, search };

    const promptText = strictExtractionPrompt({ anime, number, direction, results: search.results });
    const response = await extractWithModelFallback(promptText, (extracted) => validateAgainstSource(extracted, { number, direction, results: search.results }), progress);
    return { response, search };
  });
}

// Movies don't have a predictable per-page wiki URL slug to guess (unlike Episode_N/Chapter_N), so
// there's no deterministic fast path - only the tracker pages and search results, and the LLM
// extractor with the same found/filler/not_found classification and source validation as episodes.
function lookupMovie({ series, movieName, refresh }, progress) {
  const anime = series.name;
  return cachedLookup({ key: cacheKey({ mode: "movie", anime, movieName }), series, refresh, request: { anime, movieName, mode: "movie" } }, async () => {
    const search = await gatherSources({ series, query: buildMovieSearchQuery(anime, movieName) }, progress);
    if (!search.results.length) return { response: NOT_FOUND, search };

    const promptText = strictMovieExtractionPrompt({ anime, movieName, results: search.results });
    const response = await extractWithModelFallback(promptText, (extracted) => validateMovieAgainstSource(extracted, { movieName, results: search.results }), progress);
    return { response, search };
  });
}

// Unlike episode mappings, where the anime ends moves every time a new season airs, so these answers
// are only reused for a few days.
const READING_START_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

function lookupReadingStart({ series, refresh }, progress) {
  const anime = series.name;
  return cachedLookup({
    key: cacheKey({ mode: "start", anime }),
    series,
    refresh,
    maxAgeMs: READING_START_MAX_AGE_MS,
    request: { anime, mode: "start" }
  }, async () => {
    const search = await gatherSources({ series, query: buildReadingStartQuery(anime) }, progress);
    if (!search.results.length) return { response: { ...NOT_FOUND, note: null }, search };

    const promptText = readingStartPrompt({ anime, results: search.results });
    const response = await extractWithModelFallback(promptText, (extracted) => validateReadingStart(extracted, { results: search.results }), progress, {
      responseFormat: READING_START_RESPONSE_FORMAT,
      normalize: normalizeReadingStartResponse
    });
    return { response, search };
  });
}

// Validates the request body and returns either { error } (a 400) or { run(progress) }.
function parseLookupRequest(body) {
  const animeInput = normalizeText(body?.anime);
  const refresh = body?.refresh === true;

  if (body?.mode === "movie") {
    const movieName = normalizeMovieName(body?.movieName);
    if (!animeInput || !movieName) return { error: "Provide anime and movie name." };
    const series = describeSeries(animeInput);
    return { run: (progress) => lookupMovie({ series, movieName, refresh }, progress) };
  }

  if (body?.mode === "start") {
    if (!animeInput) return { error: "Provide an anime." };
    const series = describeSeries(animeInput);
    return { run: (progress) => lookupReadingStart({ series, refresh }, progress) };
  }

  const number = normalizeText(body?.number);
  const direction = normalizeDirection(body?.direction);
  if (!animeInput || !number || !/^\d+([.-]\d+)?$/.test(number)) {
    return { error: "Provide anime, number, and direction." };
  }
  const series = describeSeries(animeInput);
  return { run: (progress) => lookupEpisode({ series, number, direction, refresh }, progress) };
}

// Internal failure details (provider names, upstream error bodies, stack traces) go to the server log,
// not to the user - the UI only needs a plain explanation and whether trying again might help.
function lookupFailure(error) {
  console.error(error);
  if (error instanceof SearchUnavailableError || error instanceof ExtractorUnavailableError) {
    // Not a "no mapping exists" result and not a hard failure either - just search/extraction infra
    // being down after retries. Must not be cached or reported as not_found, or a transient outage
    // would permanently poison this key and users would (wrongly) see "no answer" instead of "try again."
    return {
      httpStatus: 503,
      body: {
        error: error.message,
        status: error instanceof SearchUnavailableError ? "search_unavailable" : "extractor_unavailable",
        matched_range: null,
        source: null
      }
    };
  }
  return {
    httpStatus: 500,
    body: {
      error: "Something went wrong during the lookup. Please try again.",
      status: "error",
      matched_range: null,
      source: null
    }
  };
}

app.post("/api/lookup", rateLimit, async (req, res) => {
  const lookup = parseLookupRequest(req.body);
  if (lookup.error) return res.status(400).json({ error: lookup.error });

  if (req.body?.stream !== true) {
    try {
      return res.json(await lookup.run(() => {}));
    } catch (error) {
      const { httpStatus, body } = lookupFailure(error);
      return res.status(httpStatus).json(body);
    }
  }

  // Streamed as newline-delimited JSON so the UI can show real progress through a lookup that can take
  // half a minute: {"type":"progress",...} lines as each step starts, then exactly one
  // {"type":"result",...} or {"type":"error",...} line. The HTTP status is already 200 by the time a
  // failure is known, so an error line carries its real status as httpStatus.
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no"
  });
  const send = (event) => {
    if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
  };
  try {
    const body = await lookup.run((message) => send({ type: "progress", message }));
    send({ type: "result", ...body });
  } catch (error) {
    const { httpStatus, body } = lookupFailure(error);
    send({ type: "error", httpStatus, ...body });
  }
  res.end();
});

app.get("/api/series", (req, res) => {
  res.set("Cache-Control", "public, max-age=3600");
  res.json(seriesList());
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
