// The pure text-processing half of the lookup pipeline: input normalization, source-text windowing,
// extractor prompts, model-output parsing and source validation. Nothing in here does I/O, so it can
// be unit-tested offline against captured model outputs and page text (see test/extraction.test.mjs).

export function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

export function normalizeDirection(value) {
  if (value === "chapter-to-episode" || value === "chapter_episode") return "chapter-to-episode";
  return "episode-to-chapter";
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// Decodes numeric entities too: tracker pages are full of "&#8217;" and "&#8211;", and left encoded
// their digits break text matching (e.g. "Kimetsu no Yaiba &#8211; Infinity Castle").
export function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (entity, decimal, hex, name) => {
      if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
      const codePoint = decimal ? Number(decimal) : parseInt(hex, 16);
      return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    })
    .replace(/\s+/g, " ")
    .trim();
}

// https://naruto.fandom.com/wiki/Episode_26 -> that article's MediaWiki parse-API URL. Fandom answers
// plain page requests from non-browser clients with a 403, but its API (which returns just the article
// HTML, without site navigation) is open. Returns null for anything that isn't a Fandom article URL.
export function fandomApiUrl(wikiUrl) {
  let url;
  try {
    url = new URL(wikiUrl);
  } catch {
    return null;
  }
  if (!url.hostname.endsWith(".fandom.com")) return null;
  const match = url.pathname.match(/^((?:\/[a-z]{2,3}(?:-[a-z]+)?)?)\/wiki\/(.+)$/i);
  if (!match) return null;
  let page;
  try {
    page = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  const params = new URLSearchParams({
    action: "parse",
    page,
    prop: "text",
    format: "json",
    formatversion: "2",
    redirects: "1",
    disablelimitreport: "1",
    disableeditsection: "1"
  });
  return `https://${url.hostname}${match[1]}/api.php?${params}`;
}

// Fandom's "portable infobox" fields as { label, value, links }, where links are the wiki page names
// the value links to ("Chapter_64"). Links are the most reliable signal: wikis write the same field as
// "Chapter 1061 (p. 4-15)", "8, 9" or one chapter per line, but always link each chapter's page.
export function parseInfoboxFields(html) {
  const fields = [];
  const pattern = /<h3[^>]*class="[^"]*\bpi-data-label\b[^"]*"[^>]*>([\s\S]*?)<\/h3>\s*<div[^>]*class="[^"]*\bpi-data-value\b[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  for (const [, labelHtml, valueHtml] of String(html || "").matchAll(pattern)) {
    fields.push({
      label: stripHtml(labelHtml).replace(/:$/, "").trim(),
      value: stripHtml(valueHtml),
      links: [...valueHtml.matchAll(/href="(?:https?:\/\/[^"/]+)?(?:\/[a-z]{2,3}(?:-[a-z]+)?)?\/wiki\/([^"#?]+)"/gi)].map((m) => {
        try {
          return decodeURIComponent(m[1]);
        } catch {
          return m[1];
        }
      })
    });
  }
  return fields;
}

// ["79", "64", "80"] -> "Chapters 64, 79-80"; ["1061"] -> "Chapter 1061".
export function formatNumberRange(label, numbers) {
  const sorted = [...new Set(numbers.map(Number))].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const runs = [];
  for (const value of sorted) {
    const run = runs.at(-1);
    if (run && Number.isInteger(value) && value === run.end + 1) run.end = value;
    else runs.push({ start: value, end: value });
  }
  const text = runs.map(({ start, end }) => (start === end ? `${start}` : `${start}-${end}`)).join(", ");
  return `${label}${sorted.length > 1 ? "s" : ""} ${text}`;
}

const PART_NUMBERS = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5
};

// "Infinity Castle Part 1" and "Infinity Castle Part 2" are different movies with different chapter
// ranges, so the part number must survive normalization - but "Pt. II", "Part 2" and ": Part Two" all
// name the same movie, so they're rewritten to one canonical "Part 2" and share a search/cache
// identity. "The Movie" is dropped since people add or omit it freely ("Demon Slayer the Movie: Mugen
// Train" vs "Mugen Train").
export function normalizeMovieName(value) {
  let name = normalizeText(value);
  if (!name) return "";
  name = name.replace(/\bthe\s+movie\b/gi, " ");
  name = name.replace(/[\s\-–—:,]*\b(?:part|pt\.?)\s*(\d+|[ivx]+|one|two|three|four|five)\b/gi, (match, raw) => {
    const number = /^\d+$/.test(raw) ? Number(raw) : PART_NUMBERS[raw.toLowerCase()];
    return number ? ` Part ${number}` : match;
  });
  name = name.replace(/\s+([:,])/g, "$1");
  name = name.replace(/^[\s.,:;\-–—!?]+|[\s.,:;\-–—!?]+$/g, "");
  return normalizeText(name);
}

// "Infinity Castle Part 2: Akaza Returns" -> { title: "Infinity Castle", part: 2 }. Expects a name that
// already went through normalizeMovieName, so any part marker is in its canonical "Part N" form.
export function splitMoviePart(movieName) {
  const match = String(movieName).match(/^(.+?)\s+Part (\d+)\b/);
  if (!match) return { title: movieName, part: null };
  return { title: match[1], part: Number(match[2]) };
}

// Matches a mention of the movie in source text while tolerating punctuation/dash differences (sources
// write e.g. "Infinity Castle – Part 2" for "Infinity Castle Part 2"). When a part number was requested,
// the mention must name that part too - as a digit, Roman numeral or word - since the other parts of
// the same series adapt different chapters.
export function movieMentionPattern(movieName, flags = "iu") {
  const { title, part } = splitMoviePart(movieName);
  const words = String(title).toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!words) return null;
  const titlePattern = words.map(escapeRegExp).join("[^\\p{L}\\p{N}]{1,5}");
  if (!part) return new RegExp(titlePattern, flags);
  const partForms = [String(part), ...Object.keys(PART_NUMBERS).filter((key) => PART_NUMBERS[key] === part)];
  return new RegExp(`${titlePattern}.{0,30}?\\b(?:part|pt\\.?)\\s*(?:${partForms.join("|")})(?![\\p{L}\\p{N}])`, flags);
}

export function cacheKey(ctx) {
  if (ctx.mode === "start") {
    return JSON.stringify({ mode: "start", anime: normalizeText(ctx.anime).toLowerCase() });
  }
  if (ctx.mode === "movie") {
    return JSON.stringify({
      mode: "movie",
      anime: normalizeText(ctx.anime).toLowerCase(),
      movieName: normalizeMovieName(ctx.movieName).toLowerCase()
    });
  }
  return JSON.stringify({
    anime: normalizeText(ctx.anime).toLowerCase(),
    number: String(ctx.number).trim(),
    direction: normalizeDirection(ctx.direction)
  });
}

export function relevantTextWindow(text, { number, direction }) {
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

function requestedPagePattern(direction, number) {
  const pageType = direction === "episode-to-chapter" ? "Episode" : "Chapter";
  return new RegExp(`\\.fandom\\.com\\/wiki\\/${pageType}_${escapeRegExp(number)}(?:$|[?#])`, "i");
}

// A short snippet means the full page fetch failed (blocked/timed out) and this is only the search
// engine's brief preview text - too thin and unreliable to trust as an unvalidated, bypass-the-LLM
// "found" answer. Below this length, fall through to the LLM path instead, which explicitly weighs
// source confidence and cross-checks against other sources.
export const THIN_SNIPPET_THRESHOLD = 500;

// The deterministic, no-LLM fast path: the requested episode's (or chapter's) own wiki page, fetched
// through the Fandom API, with an infobox field that links the target pages - e.g. Episode_30's
// "Adapted From" linking Chapter_64, Chapter_79 and Chapter_80. Only structured infobox data is
// trusted here; free text (where the first "Chapter N" mentioned is often not the answer, or only
// part of it) goes through the LLM extractor instead.
export function directMappingFromText(item, { direction, number }) {
  if (!requestedPagePattern(direction, number).test(item.url)) return null;

  const target = direction === "episode-to-chapter"
    ? { label: /chapter|adapted|manga|source/i, page: /^Chapter_(\d+(?:\.\d+)?)$/i, word: "Chapter" }
    : { label: /anime|episode/i, page: /^Episode_(\d+(?:\.\d+)?)$/i, word: "Episode" };

  for (const field of item.infobox || []) {
    if (!target.label.test(field.label)) continue;
    const numbers = field.links.map((link) => link.match(target.page)?.[1]).filter(Boolean);
    const matchedRange = formatNumberRange(target.word, numbers);
    if (matchedRange) return { status: "found", matched_range: matchedRange, source: item.url };
  }
  return null;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Only pages from the series' own wiki (`trustedHosts`) may answer without the LLM: search results
// routinely include same-numbered pages from unrelated wikis - myheroacademia.fandom.com/wiki/
// Chapter_154 for a One Piece lookup - whose infobox would otherwise be read as the answer.
export function directMappingFromResults({ number, direction, results, trustedHosts }) {
  for (const item of results) {
    if (!trustedHosts.includes(hostOf(item.url))) continue;
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
    const confidence = item.snippet.length < THIN_SNIPPET_THRESHOLD
      ? "LOW CONFIDENCE - short, likely-unfetched search preview, not a full page"
      : "full page fetched";
    return `SOURCE ${index + 1} (${confidence})\nTitle: ${title}\nURL: ${url}\nText: ${snippet}`;
  }).join("\n\n");
}

// Movies have no numeric row-marker to anchor on (unlike relevantTextWindow's episode/chapter
// number matching), so anchor on mentions of the movie itself (see movieMentionPattern) plus generic
// chapter/arc vocabulary instead.
export function movieRelevantTextWindow(text, movieName) {
  const normalized = normalizeText(text);
  const anchors = [];

  const mention = movieMentionPattern(movieName, "giu");
  if (mention) {
    for (const match of normalized.matchAll(mention)) {
      anchors.push(match.index);
      if (anchors.length >= 3) break;
    }
  }
  for (const needle of ["Chapters", "Story Arc", "Arc", "Manga"]) {
    const index = normalized.toLowerCase().indexOf(needle.toLowerCase());
    if (index !== -1) anchors.push(index);
  }

  const windows = anchors.map((index) => normalized.slice(Math.max(0, index - 700), Math.min(normalized.length, index + 2000)));
  return [...new Set(windows)].join(" ... ").slice(0, 6000) || normalized.slice(0, 2500);
}

function compactMovieResults(results, movieName) {
  return results.map((item, index) => {
    const title = normalizeText(item.title);
    const url = normalizeText(item.url);
    const snippet = movieRelevantTextWindow(item.snippet, movieName);
    const confidence = item.snippet.length < THIN_SNIPPET_THRESHOLD
      ? "LOW CONFIDENCE - short, likely-unfetched search preview, not a full page"
      : "full page fetched";
    return `SOURCE ${index + 1} (${confidence})\nTitle: ${title}\nURL: ${url}\nText: ${snippet}`;
  }).join("\n\n");
}

export function strictExtractionPrompt({ anime, number, direction, results }) {
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
    '- If multiple full-page (non-LOW-CONFIDENCE) sources conflict with each other, or the text is ambiguous, return status "not_found". But if only a LOW CONFIDENCE source conflicts with a full-page source, trust the full-page source and ignore the low-confidence one - a short, likely-unfetched search preview is far more likely to be an inaccurate or out-of-context fragment than a fully-fetched, clearly-labeled statistics section.',
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

export function strictMovieExtractionPrompt({ anime, movieName, results }) {
  const { title, part } = splitMoviePart(movieName);
  const partRules = part
    ? [`- "${movieName}" is Part ${part} of a multi-part film series - the other parts of "${title}" adapt different chapters. Return only what Part ${part} adapts, never another part's range or the range of the whole series/arc. The cited source must explicitly identify Part ${part} (e.g. "Part ${part}" or its Roman numeral).`]
    : [];
  return [
    "You extract anime-movie-to-manga adaptation mappings from provided search result text only.",
    "The user is asking about an anime MOVIE, not a numbered TV episode. Movies typically map to a manga chapter range or a named story arc rather than a single episode's worth of chapters, and some movies are entirely original (non-canon) stories with no manga source at all.",
    "Return only valid JSON matching this exact shape, with no markdown, no code fences, and no commentary before or after it:",
    '{"status": "found"|"filler"|"not_found", "matched_range": string|null, "source": string|null}',
    "",
    "There are three possible statuses:",
    '- "found": the movie is clearly mapped to specific manga chapters or a named story arc in the provided text. matched_range and source are both required. matched_range should be concise, e.g. "Chapters 55-69" or "Mugen Train Arc".',
    '- "filler": the source text explicitly states this movie is an original story, non-canon, or not based on any manga chapters/arc. matched_range must be null; source must be the URL that explicitly confirms this.',
    '- "not_found": you could not clearly determine an answer from the provided text.',
    "",
    "Hard rules:",
    "- Use only information explicitly present in the provided source titles, URLs, or snippets.",
    "- Never infer, estimate, or fabricate a chapter number or arc name from general knowledge, even if you recognize the movie.",
    `- The cited source text must explicitly mention "${movieName}" (or an unambiguous reference to this exact movie) alongside the chapters/arc it corresponds to, or alongside an explicit original-story/non-canon designation.`,
    ...partRules,
    '- If the movie is not clearly mapped to specific chapters/arc AND not explicitly confirmed as an original story, return status "not_found".',
    '- If multiple full-page (non-LOW-CONFIDENCE) sources conflict with each other, or the text is ambiguous, return status "not_found". But if only a LOW CONFIDENCE source conflicts with a full-page source, trust the full-page source and ignore the low-confidence one.',
    "- source must be the URL of the result that explicitly supports the answer, otherwise null.",
    "",
    `Anime title: ${anime}`,
    `Movie: ${movieName}`,
    "",
    "Search results:",
    compactMovieResults(results, movieName)
  ].join("\n");
}

const READING_START_ANCHORS = /where (?:does|to start|should i start)|anime (?:ended|ends)|start reading|continue (?:the story|reading)|pick up|(?:entire|whole) (?:manga|story)/gi;

// Tracker pages answer "where do I start reading?" in a dedicated section ("Where Does the Anime End?
// Where Should I Start Reading? ... start reading from Chapter 157 (p. 7)"), usually near the end of a
// long page, so anchor on that section's vocabulary.
export function readingStartTextWindow(text) {
  const normalized = normalizeText(text);
  const windows = [];
  for (const match of normalized.matchAll(READING_START_ANCHORS)) {
    windows.push(normalized.slice(Math.max(0, match.index - 300), Math.min(normalized.length, match.index + 900)));
    if (windows.length >= 4) break;
  }
  return [...new Set(windows)].join(" ... ").slice(0, 6000) || normalized.slice(0, 2500);
}

export function readingStartPrompt({ anime, results }) {
  const sources = results.map((item, index) => {
    const confidence = item.snippet.length < THIN_SNIPPET_THRESHOLD
      ? "LOW CONFIDENCE - short, likely-unfetched search preview, not a full page"
      : "full page fetched";
    return `SOURCE ${index + 1} (${confidence})\nTitle: ${normalizeText(item.title)}\nURL: ${normalizeText(item.url)}\nText: ${readingStartTextWindow(item.snippet)}`;
  }).join("\n\n");

  return [
    "You extract where to start reading a manga after watching its anime, from provided search result text only.",
    "Return only valid JSON matching this exact shape, with no markdown, no code fences, and no commentary before or after it:",
    '{"status": "found"|"complete"|"not_found", "matched_range": string|null, "source": string|null, "note": string|null}',
    "",
    "There are three possible statuses:",
    '- "found": the source explicitly names the manga chapter to start reading from after the anime. matched_range is that chapter, e.g. "Chapter 157" - keep a page qualifier if the source gives one, e.g. "Chapter 157 (p. 7)".',
    '- "complete": the source explicitly says the anime adapts the entire manga, so there is nothing further to read. matched_range must be null.',
    '- "not_found": neither is clearly stated in the provided text.',
    "",
    'note: one short sentence restating what the source says about where the anime ends, e.g. "The anime ends at episode 170, which adapts up to Chapter 430." Don\'t repeat the starting chapter in it. Use null if the source does not say.',
    "",
    "Hard rules:",
    "- Use only information explicitly present in the provided source titles, URLs, or snippets. Never rely on memory, estimate, or fabricate a chapter or episode number.",
    "- If the source gives separate starting points (e.g. after the TV series vs. after a later movie), return the one that continues after the most recent adaptation it describes, and say which adaptation that is in note.",
    '- If multiple full-page sources conflict, return status "not_found". A LOW CONFIDENCE source never overrides a full-page source.',
    "- source must be the URL of the result that explicitly supports the answer, otherwise null.",
    "",
    `Anime title: ${anime}`,
    "",
    "Search results:",
    sources
  ].join("\n");
}

// Sent as OpenRouter's response_format. Models with structured-output support are then forced into
// exactly this shape; models without it silently ignore the parameter (OpenRouter drops unsupported
// parameters), which is why parseModelJson below still has to be tolerant of malformed output.
export const EXTRACTOR_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "adaptation_mapping",
    strict: true,
    schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["found", "filler", "not_found"] },
        matched_range: { type: ["string", "null"] },
        source: { type: ["string", "null"] }
      },
      required: ["status", "matched_range", "source"],
      additionalProperties: false
    }
  }
};

export const READING_START_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "reading_start",
    strict: true,
    schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["found", "complete", "not_found"] },
        matched_range: { type: ["string", "null"] },
        source: { type: ["string", "null"] },
        note: { type: ["string", "null"] }
      },
      required: ["status", "matched_range", "source", "note"],
      additionalProperties: false
    }
  }
};

function stripCodeFences(value) {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenced ? fenced[1].trim() : value;
}

function balancedJsonObjectAt(value, start) {
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

// Every balanced {...} substring, in order of its opening brace - not just the first one. Models
// that ignore response_format sometimes emit a stray unclosed outer brace around an otherwise valid
// answer, e.g. {"status":{"status":"found",...} - anchoring only on the first "{" would discard it.
function balancedJsonObjects(value) {
  const objects = [];
  for (let start = value.indexOf("{"); start !== -1; start = value.indexOf("{", start + 1)) {
    const candidate = balancedJsonObjectAt(value, start);
    if (candidate) objects.push(candidate);
  }
  return objects;
}

// Some models wrap the whole answer inside the first key: {"status": {"status": "found", ...}}.
function unwrapNestedResponse(value) {
  const inner = value?.status;
  if (inner && typeof inner === "object" && typeof inner.status === "string") return inner;
  return value;
}

export function parseModelJson(content) {
  const cleaned = stripCodeFences(String(content || "").trim());
  if (!cleaned.includes("{")) throw new Error("Extractor did not return JSON.");

  let fallback = null;
  for (const candidate of [cleaned, ...balancedJsonObjects(cleaned)]) {
    let parsed;
    try {
      parsed = unwrapNestedResponse(JSON.parse(candidate));
    } catch {
      continue;
    }
    // Prefer an object that actually looks like an extractor answer over e.g. an inner
    // {"...": ...} fragment that merely happens to parse.
    if (typeof parsed?.status === "string") return parsed;
    fallback ??= parsed;
  }
  if (fallback) return fallback;
  throw new Error("Extractor returned malformed JSON.");
}

// A failure worth retrying on the same model - provider overload, rate limits, or garbled/empty
// output from a nondeterministic free model - as opposed to one that would just fail the same way
// again (bad request, unknown model, output truncated at max_tokens).
export class TransientModelError extends Error {}

function isTransientStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

// Turns a raw OpenRouter chat-completions HTTP response into a normalized extractor answer, or throws
// (a TransientModelError when retrying the same model could plausibly succeed). Note OpenRouter can
// report upstream failures such as "Service temporarily overloaded" inside an HTTP 200 body.
export function interpretOpenRouterResponse(model, httpStatus, bodyText, normalize = normalizeExtractorResponse) {
  if (httpStatus < 200 || httpStatus >= 300) {
    const ErrorType = isTransientStatus(httpStatus) ? TransientModelError : Error;
    throw new ErrorType(`OpenRouter extraction failed with ${httpStatus}. ${bodyText}`.trim());
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new TransientModelError(`OpenRouter model ${model} returned a non-JSON response body.`);
  }

  if (data.error) {
    const ErrorType = isTransientStatus(Number(data.error.code)) ? TransientModelError : Error;
    throw new ErrorType(`OpenRouter model ${model} returned an error: ${data.error.message || JSON.stringify(data.error)}`);
  }

  const choice = data.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new Error(`OpenRouter model ${model} response was truncated (hit max_tokens) before completing.`);
  }
  const content = choice?.message?.content;
  if (!content || !String(content).trim()) {
    throw new TransientModelError(`OpenRouter model ${model} returned an empty response.`);
  }

  try {
    return normalize(parseModelJson(content));
  } catch (error) {
    throw new TransientModelError(`OpenRouter model ${model}: ${error.message}`);
  }
}

export function normalizeReadingStartResponse(value) {
  const status = value?.status === "found" || value?.status === "complete" ? value.status : "not_found";
  const source = typeof value?.source === "string" ? normalizeText(value.source) : null;
  const note = typeof value?.note === "string" && normalizeText(value.note) ? normalizeText(value.note).slice(0, 300) : null;

  if (status === "found") {
    const matchedRange = typeof value.matched_range === "string" ? normalizeText(value.matched_range) : null;
    if (!matchedRange || !source) return { status: "not_found", matched_range: null, source: null, note: null };
    return { status: "found", matched_range: matchedRange, source, note };
  }

  if (status === "complete") {
    if (!source) return { status: "not_found", matched_range: null, source: null, note: null };
    return { status: "complete", matched_range: null, source, note };
  }

  return { status: "not_found", matched_range: null, source: null, note: null };
}

export function normalizeExtractorResponse(value) {
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

// "Chapter 64", "ch. 64", "64 chapters" - the label and the number as whole words. (The label
// alternatives must be grouped: ungrouped, "chapters?|chs?\.?..." matched any text containing the
// word "chapter", or even the "ch" in "which".)
function labelNumberPattern(label, number) {
  const labelPattern = label === "episode" ? "\\b(?:episodes?|eps?\\.?)" : "\\b(?:chapters?|chs?\\.?)";
  const numberPattern = `(?<![\\d.])${escapeRegExp(number)}(?!\\d)`;
  return new RegExp(`${labelPattern}\\W{0,24}${numberPattern}|${numberPattern}\\W{0,24}${labelPattern}`, "i");
}

function containsLabeledNumber(text, label, number) {
  return labelNumberPattern(label, number).test(text);
}

export function containsFillerKeyword(text) {
  return /\b(filler|anime[\s-]?original|anime[\s-]?canon|non[\s-]?canon|not\s+(?:based on|adapted|from)\b.*manga)\b/i.test(text)
    || /\b(?:manga\s+)?chapters?\s*[:\-]?\s*(?:none|n\/a|-)\b/i.test(text)
    || /\bno\s+(?:corresponding\s+)?(?:manga\s+)?chapters?\b/i.test(text);
}

// Where a new tracker row can begin without a "N." marker: right after the previous row's last chapter
// number or its filler marker (ListFist: "... 43 | 44 26 Special Report! Filler 27 The Chunin Exam").
// Anywhere else a bare number before a capitalized word is just prose ("Top 10 Strongest").
const DOTLESS_ROW_BOUNDARY = "(?<=(?:\\d|Filler|N\\/A)\\s)";

// The body of each tracker-table row for one episode, without its leading row number. Rows look like
// "142. (2:15) Those Remaining *Filler N/A" or "026. Title 25, 26" (Anime Filler Guide: zero-padded
// and dotted, then an optional "(duration)" and the title) or "26 Title Filler" (ListFist), and run
// until the next row starts.
function episodeRows(text, episodeNumber) {
  const rows = [];
  const number = `0*${escapeRegExp(episodeNumber)}`;
  const rowStart = new RegExp(`(?:(?<![\\d.])${number}\\.\\s*|${DOTLESS_ROW_BOUNDARY}${number}\\s+)(?=[(A-Z])`, "g");
  const nextRowStart = new RegExp(`\\s0*\\d{1,4}\\.\\s*[(A-Z]|${DOTLESS_ROW_BOUNDARY}0*\\d{1,4}\\s+[(A-Z]`, "g");
  for (const match of text.matchAll(rowStart)) {
    const bodyStart = match.index + match[0].length;
    nextRowStart.lastIndex = bodyStart;
    const next = nextRowStart.exec(text);
    rows.push(text.slice(bodyStart, Math.min(next ? next.index : text.length, match.index + 400)));
  }
  return rows;
}

// Tracker rows pair an episode with its chapters without labeling either ("1090. (2:33) A New
// Island! Future Island Egghead 1061"), so a mapping is also supported when the episode's own row
// lists the chapter - ignoring parenthesized durations and page ranges like "(2:33)" or "(p. 7)".
function rowSupportsMapping(snippet, { number, direction, targetNumbers }) {
  const text = normalizeText(snippet);
  const pairs = direction === "episode-to-chapter"
    ? targetNumbers.map((chapter) => [number, chapter])
    : targetNumbers.map((episode) => [episode, number]);
  return pairs.some(([episode, chapter]) => {
    const chapterPattern = new RegExp(`(?<![\\d.])${escapeRegExp(chapter)}(?!\\d)`);
    return episodeRows(text, episode).some((row) => chapterPattern.test(row.replace(/\([^)]*\)/g, " ")));
  });
}

// The parts of a source that are about the requested episode specifically: its row in a tracker table
// ("142. (2:15) Those Remaining *Filler N/A"), prose right around an explicit mention ("Episode 26 is
// filler", "Filler episodes: 26, 97"), or - when the source is that episode's own wiki page - the
// whole article. A filler keyword anywhere on the page proves nothing: every Anime Filler Guide page
// is titled "... Filler List" and names filler episodes all over.
function requestedEpisodeSegments(item, number) {
  if (requestedPagePattern("episode-to-chapter", number).test(item.url)) return [normalizeText(item.snippet)];

  const text = normalizeText(item.snippet);
  const segments = episodeRows(text, number).map((row) => ({ text: row, row: true }));

  // Only "episode(s) N" counts as a mention here, not "N episodes" - "The first season contains 51
  // episodes, 2 of which are filler" says nothing about episode 51.
  const mention = new RegExp(`\\b(?:episodes?|eps?\\.?)\\W{0,24}${escapeRegExp(number)}(?![\\d])`, "gi");
  for (const match of text.matchAll(mention)) {
    segments.push({ text: text.slice(Math.max(0, match.index - 80), match.index + match[0].length + 160), row: false });
  }

  return segments;
}

function segmentShowsFiller(segment) {
  if (typeof segment === "string") return containsFillerKeyword(segment);
  // In a tracker row, "N/A" is the chapters column saying there's no source chapter.
  return containsFillerKeyword(segment.text) || (segment.row && /\bN\/A\b/.test(segment.text));
}

export function validateAgainstSource(response, { number, direction, results }) {
  if (response.status === "not_found") return response;

  const cited = findCitedSource(results, response.source);
  if (!cited) return { status: "not_found", matched_range: null, source: null };

  if (response.status === "filler") {
    // Filler is an episode property ("this episode has no source chapter"), so it only applies
    // episode-to-chapter, and needs evidence about this episode specifically.
    if (direction !== "episode-to-chapter" || !requestedEpisodeSegments(cited, number).some(segmentShowsFiller)) {
      return { status: "not_found", matched_range: null, source: null };
    }
    return response;
  }

  const targetPageType = direction === "episode-to-chapter" ? "Chapter" : "Episode";
  const wrongSameNumberPage = new RegExp(`\\.fandom\\.com\\/wiki\\/${targetPageType}_${escapeRegExp(number)}(?:$|[?#])`, "i");
  if (wrongSameNumberPage.test(cited.url)) {
    return { status: "not_found", matched_range: null, source: null };
  }

  // Supported either by explicitly labeled mentions of both numbers ("Episode 30 ... Chapter 64") or by
  // a tracker row pairing them.
  const fromLabel = direction === "episode-to-chapter" ? "episode" : "chapter";
  const toLabel = direction === "episode-to-chapter" ? "chapter" : "episode";
  const text = sourceText(cited);
  const targetNumbers = numbersFromText(response.matched_range);
  const labeled = containsLabeledNumber(text, fromLabel, number)
    && targetNumbers.some((targetNumber) => containsLabeledNumber(text, toLabel, targetNumber));

  if (!labeled && !rowSupportsMapping(cited.snippet, { number, direction, targetNumbers })) {
    return { status: "not_found", matched_range: null, source: null };
  }

  return response;
}

// Movies have no numeric label to check (no containsLabeledNumber equivalent), so validation instead
// requires the cited source to name this movie (including its part number, if one was requested),
// plus - for "found" - some chapter/arc vocabulary nearby so a citation that merely mentions the movie
// in passing isn't accepted as proof.
export function validateMovieAgainstSource(response, { movieName, results }) {
  if (response.status === "not_found") return response;

  const cited = findCitedSource(results, response.source);
  if (!cited) return { status: "not_found", matched_range: null, source: null };

  const text = sourceText(cited);
  const mentionsMovie = movieMentionPattern(movieName)?.test(text);
  if (!mentionsMovie) return { status: "not_found", matched_range: null, source: null };

  if (response.status === "filler") {
    if (!containsFillerKeyword(text)) return { status: "not_found", matched_range: null, source: null };
    return response;
  }

  if (!/\bchapters?\b|\barcs?\b/i.test(text)) {
    return { status: "not_found", matched_range: null, source: null };
  }

  return response;
}

// "found" needs the returned chapter, labeled as a chapter, right next to "start reading"-style
// wording in the cited source (not just anywhere on a page full of chapter numbers); "complete" needs
// an explicit "adapts the entire manga"-style statement. The note is kept only if every number in it
// appears in the source - it's a restatement of the source, not the model's own knowledge.
export function validateReadingStart(response, { results }) {
  const notFound = { status: "not_found", matched_range: null, source: null, note: null };
  if (response.status === "not_found") return response;

  const cited = findCitedSource(results, response.source);
  if (!cited) return notFound;
  const text = normalizeText(cited.snippet);

  if (response.status === "complete") {
    const saysComplete = /\b(?:entire|whole|complete|full)\b[^.]{0,60}\b(?:manga|story)\b|\b(?:manga|story)\b[^.]{0,60}\b(?:fully|completely|entirely)\s+adapted\b/i.test(text);
    if (!saysComplete) return notFound;
  } else {
    const chapter = numbersFromText(response.matched_range)[0];
    const nearStartWording = chapter && [...text.matchAll(/start reading|continue (?:the story|reading)|pick up|where to start/gi)]
      .some((match) => containsLabeledNumber(text.slice(Math.max(0, match.index - 150), match.index + 250), "chapter", chapter));
    if (!nearStartWording) return notFound;
  }

  const noteNumbers = numbersFromText(response.note);
  const noteSupported = noteNumbers.every((number) => new RegExp(`(?<![\\d.])${escapeRegExp(number)}(?![\\d])`).test(text));
  return { ...response, note: noteSupported ? response.note : null };
}
