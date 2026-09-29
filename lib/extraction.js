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

// A short snippet means the full page fetch failed (blocked/timed out) and this is only the search
// engine's brief preview text - too thin and unreliable to trust as an unvalidated, bypass-the-LLM
// "found" answer. Below this length, fall through to the LLM path instead, which explicitly weighs
// source confidence and cross-checks against other sources.
export const THIN_SNIPPET_THRESHOLD = 500;

export function directMappingFromText(item, { direction, number }) {
  if (!requestedPagePattern(direction, number).test(item.url)) return null;
  if (item.snippet.length < THIN_SNIPPET_THRESHOLD) return null;

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

export function directMappingFromResults({ number, direction, results }) {
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
export function interpretOpenRouterResponse(model, httpStatus, bodyText) {
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
    return normalizeExtractorResponse(parseModelJson(content));
  } catch (error) {
    throw new TransientModelError(`OpenRouter model ${model}: ${error.message}`);
  }
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

function labelNumberPattern(label, number) {
  const escapedNumber = escapeRegExp(number);
  const labelPattern = label === "episode" ? "episodes?|eps?\\.?" : "chapters?|chs?\\.?";
  return new RegExp(`(?:${labelPattern}\\W{0,24}${escapedNumber}|${escapedNumber}\\W{0,24}${labelPattern})`, "i");
}

function containsLabeledNumber(text, label, number) {
  return labelNumberPattern(label, number).test(text);
}

export function containsFillerKeyword(text) {
  return /\b(filler|anime[\s-]?original|non[\s-]?canon|not\s+(?:based on|adapted|from)\b.*manga)\b/i.test(text)
    || /\b(?:manga\s+)?chapters?\s*[:\-]?\s*(?:none|n\/a|-)\b/i.test(text)
    || /\bno\s+(?:corresponding\s+)?(?:manga\s+)?chapters?\b/i.test(text);
}

export function validateAgainstSource(response, { number, direction, results }) {
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
