// Offline unit tests for the pure extraction/validation logic in lib/extraction.js - no network, no
// API keys. Model outputs below are real responses captured from free OpenRouter models; source texts
// mirror the formats of the tracker pages the server fetches (Anime Filler Guide, Fandom).
//
// Usage: npm test   (the live end-to-end suite is `npm run test:live`)

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TransientModelError,
  cacheKey,
  directMappingFromText,
  interpretOpenRouterResponse,
  movieMentionPattern,
  movieRelevantTextWindow,
  normalizeMovieName,
  parseModelJson,
  relevantTextWindow,
  strictMovieExtractionPrompt,
  validateAgainstSource,
  validateMovieAgainstSource
} from "../lib/extraction.js";

const AFG_URL = "https://www.animefillerguide.com/demon-slayer/";

// Condensed from the Demon Slayer page on animefillerguide.com (note the en-dashes it uses).
const DEMON_SLAYER_MOVIES_TEXT = [
  "Demon Slayer: Kimetsu no Yaiba – The Movie: Mugen Train: The film adapts chapters 54 to 66 of the manga, volumes 7-8.",
  "The “Infinity Castle Arc” (Mugen-jō Hen), which marks the conclusion of the story, will be adapted into a film trilogy.",
  "Demon Slayer: Kimetsu no Yaiba – Infinity Castle – Part 1: Akaza Returns: The first movie adapts chapters 140 to 157 (p. 6).",
  "Demon Slayer: Kimetsu no Yaiba – Infinity Castle – Part 2: The second movie will adapt chapters 157 (p. 7) to 180 (p. 7)."
].join(" ");

describe("parseModelJson", () => {
  it("recovers the answer from nemotron's unclosed nested-status glitch", () => {
    const raw = '{"status":{"status":"found","matched_range":"Chapters 140-157","source":"https://www.animefillerguide.com/demon-slayer/"}';
    assert.deepEqual(parseModelJson(raw), {
      status: "found",
      matched_range: "Chapters 140-157",
      source: "https://www.animefillerguide.com/demon-slayer/"
    });
  });

  it("unwraps a properly closed nested-status answer", () => {
    const raw = '{"status":{"status":"filler","matched_range":null,"source":"https://a.test/"}}';
    assert.equal(parseModelJson(raw).status, "filler");
  });

  it("parses plain, pretty-printed, fenced and prose-wrapped JSON", () => {
    assert.equal(parseModelJson('{"status": "not_found", "matched_range": null, "source": null}').status, "not_found");
    assert.equal(parseModelJson('{\n  "status": "found",\n  "matched_range": "Chapter 1",\n  "source": "https://a.test/"\n}').matched_range, "Chapter 1");
    assert.equal(parseModelJson('```json\n{"status":"found","matched_range":"Chapter 10","source":"https://a.test/"}\n```').matched_range, "Chapter 10");
    assert.equal(parseModelJson('Answer: {"status":"found","matched_range":"Chapter 2","source":"https://a.test/?q={x}"} done').matched_range, "Chapter 2");
  });

  it("does not get confused by braces inside strings", () => {
    assert.equal(parseModelJson('{"status":"found","matched_range":"Ch {1}","source":"https://a.test/"}').matched_range, "Ch {1}");
  });

  it("throws distinct errors for no JSON vs. broken JSON", () => {
    assert.throws(() => parseModelJson("I could not find it."), /did not return JSON/);
    assert.throws(() => parseModelJson("{status: found"), /malformed JSON/);
  });
});

describe("interpretOpenRouterResponse", () => {
  const ok = (content, finishReason = "stop") => JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }] });

  it("returns a normalized answer, including from glitched output", () => {
    const content = '{"status":{"status":"found","matched_range":"Chapters 140-157","source":"https://a.test/"}';
    assert.deepEqual(interpretOpenRouterResponse("m", 200, ok(content)), {
      status: "found",
      matched_range: "Chapters 140-157",
      source: "https://a.test/"
    });
  });

  it("treats an upstream overload reported inside an HTTP 200 body as transient", () => {
    const body = JSON.stringify({ error: { message: "Upstream error from Nvidia: Service temporarily overloaded", code: 503 } });
    assert.throws(() => interpretOpenRouterResponse("m", 200, body), TransientModelError);
  });

  it("treats rate limits, 5xx, empty and unparseable output as transient", () => {
    assert.throws(() => interpretOpenRouterResponse("m", 429, "rate limited"), TransientModelError);
    assert.throws(() => interpretOpenRouterResponse("m", 502, ""), TransientModelError);
    assert.throws(() => interpretOpenRouterResponse("m", 200, ok("   ")), TransientModelError);
    assert.throws(() => interpretOpenRouterResponse("m", 200, ok("{status: found")), TransientModelError);
    assert.throws(() => interpretOpenRouterResponse("m", 200, "<html>gateway</html>"), TransientModelError);
  });

  it("treats auth/bad-request errors and truncation as permanent (not worth a same-model retry)", () => {
    const isPermanent = (fn) => {
      try {
        fn();
      } catch (error) {
        return !(error instanceof TransientModelError);
      }
      return false;
    };
    assert.ok(isPermanent(() => interpretOpenRouterResponse("m", 401, "bad key")));
    assert.ok(isPermanent(() => interpretOpenRouterResponse("m", 400, "bad request")));
    assert.ok(isPermanent(() => interpretOpenRouterResponse("m", 200, JSON.stringify({ error: { message: "No such model", code: 404 } }))));
    assert.ok(isPermanent(() => interpretOpenRouterResponse("m", 200, ok('{"status":"fou', "length"))));
  });
});

describe("normalizeMovieName", () => {
  it("keeps the part number so different parts stay different movies", () => {
    assert.equal(normalizeMovieName("Infinity Castle Part 2"), "Infinity Castle Part 2");
    assert.notEqual(
      cacheKey({ mode: "movie", anime: "Demon Slayer", movieName: "Infinity Castle Part 1" }),
      cacheKey({ mode: "movie", anime: "Demon Slayer", movieName: "Infinity Castle Part 2" })
    );
  });

  it("canonicalizes the different ways of writing a part number", () => {
    for (const input of ["Infinity Castle Part 2", "Infinity Castle: Part II", "infinity castle pt. 2", "Infinity Castle - Part Two", "Infinity Castle Part 02"]) {
      assert.equal(normalizeMovieName(input).toLowerCase(), "infinity castle part 2", input);
    }
  });

  it("keeps a subtitle after the part number", () => {
    assert.equal(normalizeMovieName("Infinity Castle Part 1: Akaza Returns"), "Infinity Castle Part 1: Akaza Returns");
  });

  it("drops 'the movie' and stray punctuation", () => {
    assert.equal(normalizeMovieName("The Movie: Mugen Train"), "Mugen Train");
    assert.equal(normalizeMovieName("Demon Slayer the Movie: Mugen Train!"), "Demon Slayer: Mugen Train");
  });

  it("leaves words that merely start with 'part' alone", () => {
    assert.equal(normalizeMovieName("Part of Your World"), "Part of Your World");
  });
});

describe("movie matching", () => {
  it("matches source text despite dash/punctuation differences", () => {
    assert.ok(movieMentionPattern("Infinity Castle Part 2").test("Kimetsu no Yaiba – Infinity Castle – Part 2: The second movie"));
    assert.ok(movieMentionPattern("Infinity Castle Part 2").test("Infinity Castle Part II"));
    assert.ok(movieMentionPattern("Mugen Train").test("The Movie: Mugen Train"));
  });

  it("does not let one part's mention count for another part", () => {
    assert.ok(!movieMentionPattern("Infinity Castle Part 3").test(DEMON_SLAYER_MOVIES_TEXT));
    assert.ok(!movieMentionPattern("Infinity Castle Part 2").test("Infinity Castle – Part 20"));
  });

  it("puts the requested part's mention into the text window sent to the model", () => {
    const padded = `${"Unrelated filler text. ".repeat(600)}${DEMON_SLAYER_MOVIES_TEXT}`;
    assert.match(movieRelevantTextWindow(padded, "Infinity Castle Part 2"), /Part 2: The second movie will adapt chapters 157/);
  });

  it("tells the model which part it must answer for", () => {
    const prompt = strictMovieExtractionPrompt({ anime: "Demon Slayer", movieName: "Infinity Castle Part 2", results: [] });
    assert.match(prompt, /Part 2 of a multi-part film series/);
    assert.doesNotMatch(strictMovieExtractionPrompt({ anime: "Demon Slayer", movieName: "Mugen Train", results: [] }), /multi-part/);
  });
});

describe("validateMovieAgainstSource", () => {
  const results = [{ title: "Demon Slayer Filler List", url: AFG_URL, snippet: DEMON_SLAYER_MOVIES_TEXT }];

  it("accepts an answer whose cited source names the requested part", () => {
    const response = { status: "found", matched_range: "Chapters 157-180", source: AFG_URL };
    assert.deepEqual(validateMovieAgainstSource(response, { movieName: "Infinity Castle Part 2", results }), response);
  });

  it("rejects an answer when the source never mentions that part", () => {
    const response = { status: "found", matched_range: "Chapters 180-205", source: AFG_URL };
    assert.equal(validateMovieAgainstSource(response, { movieName: "Infinity Castle Part 3", results }).status, "not_found");
  });

  it("rejects a citation that isn't one of the search results", () => {
    const response = { status: "found", matched_range: "Chapters 140-157", source: "https://elsewhere.test/" };
    assert.equal(validateMovieAgainstSource(response, { movieName: "Infinity Castle Part 1", results }).status, "not_found");
  });
});

describe("episode validation and windowing", () => {
  it("anchors on zero-padded tracker rows without matching longer numbers", () => {
    const text = `Season 1 # Title Chapters ${"011. Some Earlier Title 8, 9 ".repeat(200)}012. The Target Row 10 112. Not This One 99`;
    const window = relevantTextWindow(text, { number: "12", direction: "episode-to-chapter" });
    assert.match(window, /012\. The Target Row 10/);
  });

  it("accepts a filler answer only when the source labels that episode as filler", () => {
    const results = [{ title: "Naruto Episode Guide", url: "https://a.test/naruto", snippet: "Episode 26 - Special Report: Live from the Forest of Death! Filler" }];
    const response = { status: "filler", matched_range: null, source: "https://a.test/naruto" };
    assert.equal(validateAgainstSource(response, { number: "26", direction: "episode-to-chapter", results }).status, "filler");
    const noKeyword = [{ ...results[0], snippet: "Episode 26 - Special Report: Live from the Forest of Death!" }];
    assert.equal(validateAgainstSource(response, { number: "26", direction: "episode-to-chapter", results: noKeyword }).status, "not_found");
  });

  it("rejects an answer citing the same-numbered page on the wrong axis", () => {
    const url = "https://onepiece.fandom.com/wiki/Chapter_1090";
    const results = [{ title: "Chapter 1090", url, snippet: "Episode 1090 ... Chapter 1061" }];
    const response = { status: "found", matched_range: "Chapter 1061", source: url };
    assert.equal(validateAgainstSource(response, { number: "1090", direction: "episode-to-chapter", results }).status, "not_found");
  });

  it("does not trust a thin search preview for the direct (no-LLM) fast path", () => {
    const item = { url: "https://onepiece.fandom.com/wiki/Episode_1090", snippet: "Statistics Chapter 1061" };
    assert.equal(directMappingFromText(item, { direction: "episode-to-chapter", number: "1090" }), null);
    const full = { ...item, snippet: `${"x ".repeat(300)}Statistics Chapter 1061` };
    assert.deepEqual(directMappingFromText(full, { direction: "episode-to-chapter", number: "1090" }), {
      status: "found",
      matched_range: "Chapter 1061",
      source: item.url
    });
  });
});
