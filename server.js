import express from "express";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXTRACTOR_RESPONSE_FORMAT,
  TransientModelError,
  cacheKey,
  directMappingFromResults,
  interpretOpenRouterResponse,
  normalizeDirection,
  normalizeMovieName,
  normalizeText,
  strictExtractionPrompt,
  strictMovieExtractionPrompt,
  validateAgainstSource,
  validateMovieAgainstSource
} from "./lib/extraction.js";

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

// Search infra (Tavily/Brave) or every configured extractor model being down after retries. Neither
// means "no mapping exists", so these surface to the user as "try again" rather than not_found.
class SearchUnavailableError extends Error {}
class ExtractorUnavailableError extends Error {}

// Retries `fn` up to `attempts` total tries with a short, linearly increasing backoff between
// attempts (so a transient timeout/connection error/5xx doesn't fail the whole lookup outright).
// `shouldRetry` can veto a retry for errors that would just fail the same way again.
async function withRetry(fn, { attempts = 3, baseDelayMs = 1000, shouldRetry = () => true } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1 || !shouldRetry(error)) break;
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

function searchWith(provider, query) {
  return provider === "tavily" ? searchTavily(query) : searchBrave(query);
}

async function runSearch(anime, number, direction) {
  const provider = selectedProvider();
  const query = buildSearchQuery(anime, number, direction);
  // The tracker pages don't depend on the search results, so fetch them while the search runs.
  const trackerFetch = fetchPages(trackerPages(anime));
  const results = (await searchWith(provider, query))
    .filter((item) => item.snippet || item.title || item.url)
    .slice(0, 8);

  const pageLabel = direction === "episode-to-chapter" ? "Episode" : "Chapter";
  const directFetch = fetchPages(directSourceCandidates({ anime, number, direction, results })
    .map((url) => ({ url, title: `${anime} ${pageLabel} ${number}` })));
  const [directPages, trackerPagesFetched] = await Promise.all([directFetch, trackerFetch]);

  return {
    provider,
    query,
    results: mergeFetchedPages(results, [...directPages, ...trackerPagesFetched])
  };
}

// Movies don't have a predictable per-page wiki URL slug to guess (unlike Episode_N/Chapter_N), so
// there's no equivalent of directSourceCandidates here - only the anime-level tracker pages, which
// still might mention the movie's manga tie-in.
async function runMovieSearch(anime, movieName) {
  const provider = selectedProvider();
  const query = buildMovieSearchQuery(anime, movieName);
  const trackerFetch = fetchPages(trackerPages(anime));
  const results = (await searchWith(provider, query))
    .filter((item) => item.snippet || item.title || item.url)
    .slice(0, 8);

  return {
    provider,
    query,
    results: mergeFetchedPages(results, await trackerFetch)
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

// Tabular conversion trackers often don't surface well as generic search snippets, so fetch the
// known tracker pages directly rather than relying on search hits.
function trackerPages(anime) {
  return [
    ...listFistCandidateUrls(anime).map((url) => ({ url, title: `${anime} Episode to Chapter Conversion List` })),
    ...animeFillerGuideCandidateUrls(anime).map((url) => ({ url, title: `${anime} Filler List & Episode to Chapter Conversion Guide` }))
  ];
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

async function fetchPageTextOnce(url) {
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
    if (!contentType.includes("text/html")) return null;
    return stripHtml(await response.text());
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPageText(url) {
  try {
    return await withRetry(() => fetchPageTextOnce(url), { attempts: 2, baseDelayMs: 500 });
  } catch {
    return null;
  }
}

// Fetches all pages concurrently - each one can take several seconds (or a full timeout plus a
// retry), so fetching them one after another made every slow source add to the lookup time.
async function fetchPages(pages) {
  const texts = await Promise.all(pages.map(({ url }) => fetchPageText(url)));
  return pages.map((page, index) => {
    const text = texts[index];
    if (process.env.ADAPT_DEBUG) console.log("FETCH_PAGE", page.url, text ? `ok len=${text.length}` : "FAILED/null");
    return { ...page, snippet: text };
  });
}

// Upserts each successfully fetched page into the search results (keyed by url) with its full text,
// applied in the given order so the final ordering doesn't depend on which fetch finished first.
// Search APIs sometimes already return one of these known tracker/wiki pages but only with a short
// marketing snippet (no chapter data) - a thin existing entry must still be upgraded to the full page
// text, not skipped, or the answer that page actually contains is silently dropped.
function mergeFetchedPages(results, pages) {
  const merged = [...results];
  for (const { title, url, snippet } of pages) {
    if (!snippet) continue;
    const entry = { title, url, snippet };
    const existingIndex = merged.findIndex((item) => item.url === url);
    if (existingIndex === -1) {
      merged.unshift(entry);
    } else {
      merged[existingIndex] = entry;
    }
  }
  return merged.slice(0, 12);
}

function candidateModels() {
  const primary = normalizeText(process.env.OPENROUTER_MODEL);
  const fallbacks = normalizeText(process.env.OPENROUTER_FALLBACK_MODELS)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set([primary, ...fallbacks].filter(Boolean))];
}

async function callOpenRouterModel(model, promptText) {
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
      response_format: EXTRACTOR_RESPONSE_FORMAT,
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
  return interpretOpenRouterResponse(model, response.status, body);
}

// Free-tier OpenRouter models are prone to transient provider-side failures ("Service temporarily
// overloaded", rate limits) and occasional malformed/empty output. Each configured model
// (OPENROUTER_MODEL first, then OPENROUTER_FALLBACK_MODELS) gets one retry for those transient
// failures before moving on to the next model; failures that would only repeat (bad request, unknown
// model, truncated output, a 30s timeout) skip straight to the next model. A model saying "not
// found" is a valid answer and is NOT retried against the next model.
async function extractWithModelFallback(promptText, validateFn) {
  const models = candidateModels();
  if (!models.length) throw new Error("OPENROUTER_MODEL is not set.");
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set.");

  let lastError;
  for (const model of models) {
    try {
      const extracted = await withRetry(() => callOpenRouterModel(model, promptText), {
        attempts: 2,
        baseDelayMs: 1500,
        shouldRetry: (error) => error instanceof TransientModelError
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

async function extractWithOpenRouter({ anime, number, direction, results }) {
  const promptText = strictExtractionPrompt({ anime, number, direction, results });
  return extractWithModelFallback(promptText, (extracted) => validateAgainstSource(extracted, { number, direction, results }));
}

async function extractMovieWithOpenRouter({ anime, movieName, results }) {
  const promptText = strictMovieExtractionPrompt({ anime, movieName, results });
  return extractWithModelFallback(promptText, (extracted) => validateMovieAgainstSource(extracted, { movieName, results }));
}

// Only cache confirmed, validated answers (found or filler). A "not_found" result may simply mean this
// attempt's search results were incomplete, not that no answer exists - caching it would permanently
// poison the key for future (possibly better) lookups.
function isConfirmed(response) {
  return Boolean((response.status === "found" && response.matched_range && response.source)
    || (response.status === "filler" && response.source));
}

// Internal failure details (provider names, upstream error bodies, stack traces) go to the server log,
// not to the user - the UI only needs a plain explanation and whether trying again might help.
function sendLookupError(res, error) {
  console.error(error);
  if (error instanceof SearchUnavailableError || error instanceof ExtractorUnavailableError) {
    // Not a "no mapping exists" result and not a hard failure either - just search/extraction infra
    // being down after retries. Must not be cached or reported as not_found, or a transient outage
    // would permanently poison this key and users would (wrongly) see "no answer" instead of "try again."
    return res.status(503).json({
      error: error.message,
      status: error instanceof SearchUnavailableError ? "search_unavailable" : "extractor_unavailable",
      matched_range: null,
      source: null
    });
  }
  res.status(500).json({
    error: "Something went wrong during the lookup. Please try again.",
    status: "error",
    matched_range: null,
    source: null
  });
}

async function handleMovieLookup(req, res) {
  const anime = normalizeText(req.body?.anime);
  const movieName = normalizeMovieName(req.body?.movieName);

  if (!anime || !movieName) {
    return res.status(400).json({ error: "Provide anime and movie name." });
  }

  const refresh = req.body?.refresh === true;
  const key = cacheKey({ mode: "movie", anime, movieName });

  try {
    if (!refresh) {
      const cached = await getCached(key);
      if (cached) return res.json({ ...cached, cached: true });
    }

    const search = await runMovieSearch(anime, movieName);
    if (process.env.ADAPT_DEBUG) {
      console.log("MOVIE QUERY", search.query);
      console.log("MOVIE RESULTS", search.results.map((r) => ({ title: r.title, url: r.url, len: r.snippet.length })));
    }
    // No deterministic fast path for movies (no predictable page-slug pattern to guess), so this
    // always goes through the LLM extractor - which still applies the same found/filler/not_found
    // classification and source validation as the episode path.
    const response = search.results.length
      ? await extractMovieWithOpenRouter({ anime, movieName, results: search.results })
      : { status: "not_found", matched_range: null, source: null };

    if (isConfirmed(response)) {
      await setCached(key, response, {
        anime,
        movieName,
        mode: "movie",
        provider: search.provider,
        query: search.query
      });
    }

    res.json({ ...response, cached: false });
  } catch (error) {
    sendLookupError(res, error);
  }
}

async function handleEpisodeLookup(req, res) {
  const anime = normalizeText(req.body?.anime);
  const number = normalizeText(req.body?.number);
  const direction = normalizeDirection(req.body?.direction);

  if (!anime || !number || !/^\d+([.-]\d+)?$/.test(number)) {
    return res.status(400).json({ error: "Provide anime, number, and direction." });
  }

  const refresh = req.body?.refresh === true;
  const key = cacheKey({ anime, number, direction });

  try {
    if (!refresh) {
      const cached = await getCached(key);
      if (cached) return res.json({ ...cached, cached: true });
    }

    const search = await runSearch(anime, number, direction);
    if (process.env.ADAPT_DEBUG) {
      console.log("QUERY", search.query);
      console.log("RESULTS", search.results.map((r) => ({ title: r.title, url: r.url, len: r.snippet.length })));
    }
    const direct = directMappingFromResults({ number, direction, results: search.results });
    const response = direct || (search.results.length
      ? await extractWithOpenRouter({ anime, number, direction, results: search.results })
      : { status: "not_found", matched_range: null, source: null });

    if (isConfirmed(response)) {
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
    sendLookupError(res, error);
  }
}

app.post("/api/lookup", rateLimit, (req, res) => {
  if (req.body?.mode === "movie") return handleMovieLookup(req, res);
  return handleEpisodeLookup(req, res);
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
