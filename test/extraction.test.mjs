// Offline unit tests for the pure extraction/validation logic in lib/extraction.js - no network, no
// API keys. Model outputs below are real responses captured from free OpenRouter models; source texts
// mirror the formats of the tracker pages the server fetches (Anime Filler Guide, Fandom).
//
// Usage: npm test   (the live end-to-end suite is `npm run test:live`)

import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import {
  TransientModelError,
  cacheKey,
  directMappingFromResults,
  directMappingFromText,
  fandomApiUrl,
  formatNumberRange,
  interpretOpenRouterResponse,
  movieMentionPattern,
  movieRelevantTextWindow,
  normalizeMovieName,
  normalizeReadingStartResponse,
  parseInfoboxFields,
  parseModelJson,
  relevantTextWindow,
  stripHtml,
  strictMovieExtractionPrompt,
  validateAgainstSource,
  validateMovieAgainstSource,
  validateReadingStart
} from "../lib/extraction.js";
import { CURATED_SLUGS, resolveSeries, seriesList } from "../lib/series.js";

// Infobox markup as returned by the Fandom parse API (trimmed to the relevant field).
const infobox = (label, valueHtml) => `<div class="pi-item pi-data pi-item-spacing pi-border-color"> <h3 class="pi-data-label pi-secondary-font">${label}</h3> <div class="pi-data-value pi-font">${valueHtml}</div> </div>`;
const JJK_EPISODE_30_HTML = infobox("U.S. Air Date", "September 14, 2023") + infobox("Adapted From", '<a href="/wiki/Chapter_64" title="Chapter 64">Chapter 64</a><br /><a href="/wiki/Chapter_79" title="Chapter 79">Chapter 79</a> (p. 8 - 21)<br /><a href="/wiki/Chapter_80" title="Chapter 80">Chapter 80</a> (p. 1 - 13)');
const KNY_EPISODE_5_HTML = infobox("Chapters", '<a href="/wiki/Chapter_8" title="Chapter 8">8</a>, <a href="/wiki/Chapter_9" title="Chapter 9">9</a>');
const OP_CHAPTER_154_HTML = infobox("WSJ Issue:", "2000 Issue 44") + infobox("Anime:", '<a href="/wiki/Episode_91" title="Episode 91">Episode 91</a> (p. 2-19)<br />');

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

  describe("found answers need the source to actually pair the two numbers", () => {
    const AFG = "https://www.animefillerguide.com/anime/one-piece/";
    // The page mentions "chapter" plenty - which used to satisfy the check on its own.
    const snippet = "Every chapter is listed below. # Title Chapters 1090. (2:33) A New Island! Future Island Egghead 1061 1091. (1:42) Brimming with the Future 1062 091. (3:10) Arrival at Drum Island 153, 154";
    const results = [{ title: "One Piece Filler List & Episode to Chapter Conversion Guide", url: AFG, snippet }];
    const check = (matchedRange, number, direction = "episode-to-chapter") =>
      validateAgainstSource({ status: "found", matched_range: matchedRange, source: AFG }, { number, direction, results }).status;

    it("accepts a chapter listed in the requested episode's row", () => {
      assert.equal(check("Chapter 1061", "1090"), "found");
      assert.equal(check("Episode 91", "154", "chapter-to-episode"), "found");
    });

    it("rejects a chapter from a different row, or a number that's only a duration", () => {
      assert.equal(check("Chapter 1062", "1090"), "not_found");
      assert.equal(check("Chapter 33", "1090"), "not_found");
      assert.equal(check("Episode 1090", "154", "chapter-to-episode"), "not_found");
    });

    it("still accepts explicitly labeled prose", () => {
      const prose = [{ title: "Episode 30", url: "https://a.test/jjk", snippet: "Episode 30 adapts Chapter 64 and Chapters 79-80." }];
      assert.equal(validateAgainstSource({ status: "found", matched_range: "Chapters 64, 79-80", source: "https://a.test/jjk" }, { number: "30", direction: "episode-to-chapter", results: prose }).status, "found");
    });
  });

  it("rejects an answer citing the same-numbered page on the wrong axis", () => {
    const url = "https://onepiece.fandom.com/wiki/Chapter_1090";
    const results = [{ title: "Chapter 1090", url, snippet: "Episode 1090 ... Chapter 1061" }];
    const response = { status: "found", matched_range: "Chapter 1061", source: url };
    assert.equal(validateAgainstSource(response, { number: "1090", direction: "episode-to-chapter", results }).status, "not_found");
  });

});

describe("filler validation is scoped to the requested episode", () => {
  const AFG = "https://www.animefillerguide.com/anime/black-clover/";
  // Mirrors Anime Filler Guide's layout: a title that says "Filler List", a season blurb, then rows.
  const page = [
    "Black Clover Filler List & Episode to Chapter Conversion Guide.",
    "Season 1 (001–051) The first season contains 51 episodes , 2 of which are filler .",
    "# Title Chapters 050. (1:02) Mage X 91, 92 051. (0:58) Dawn 93",
    "140. (2:41) Golden Dawn 245 141. (0:40) The Golden Family *Anime Canon N/A 142. (2:15) Those Remaining *Filler N/A 143. (4:55) The Tilted Scale 246"
  ].join(" ");
  const results = [{ title: "Black Clover Filler List & Episode to Chapter Conversion Guide", url: AFG, snippet: page }];
  const filler = { status: "filler", matched_range: null, source: AFG };
  const check = (number) => validateAgainstSource(filler, { number, direction: "episode-to-chapter", results }).status;

  it("accepts an episode whose own row says filler or has no source chapters", () => {
    assert.equal(check("142"), "filler");
    assert.equal(check("141"), "filler");
  });

  it("rejects a canon episode even though the page title and neighbours say filler", () => {
    assert.equal(check("143"), "not_found");
    assert.equal(check("140"), "not_found");
  });

  it("doesn't read '51 episodes, 2 of which are filler' as evidence about episode 51", () => {
    assert.equal(check("51"), "not_found");
  });

  it("reads ListFist's undotted rows, without mistaking menu text for a row", () => {
    const LF = "https://listfist.com/list-of-naruto-episode-to-chapter-conversion";
    // Condensed from the live page: site menu, explainer, then "number title chapters" rows.
    const snippet = "Fillers (Naruto) Top 10 Strongest Characters. Episodes that did not use any reference chapter are referred to as Filler. 15 Zero Visibility: The Sharingan Shatters 25 | 26 16 The Broken Seal 26 | 27 25 The Tenth Question: All or Nothing! 43 | 44 26 Special Report: Live from the Forest of Death! Filler 27 The Chunin Exam Stage 2: The Forest of Death 45 | 46";
    const listfist = [{ title: "Naruto Episode to Chapter Conversion List", url: LF, snippet }];
    const validate = (response, number) => validateAgainstSource({ ...response, source: LF }, { number, direction: "episode-to-chapter", results: listfist }).status;
    assert.equal(validate({ status: "filler", matched_range: null }, "26"), "filler");
    assert.equal(validate({ status: "filler", matched_range: null }, "27"), "not_found");
    assert.equal(validate({ status: "filler", matched_range: null }, "10"), "not_found");
    assert.equal(validate({ status: "found", matched_range: "Chapters 26-27" }, "16"), "found");
    assert.equal(validate({ status: "found", matched_range: "Chapter 44" }, "16"), "not_found");
  });
});

describe("Fandom infobox fast path", () => {
  const item = (url, html) => ({ url, snippet: stripHtml(html), infobox: parseInfoboxFields(html) });

  it("reads every linked chapter, not just the first one mentioned", () => {
    const page = item("https://jujutsu-kaisen.fandom.com/wiki/Episode_30", JJK_EPISODE_30_HTML);
    assert.deepEqual(directMappingFromText(page, { direction: "episode-to-chapter", number: "30" }), {
      status: "found",
      matched_range: "Chapters 64, 79-80",
      source: page.url
    });
  });

  it("handles fields written as bare numbers", () => {
    const page = item("https://kimetsu-no-yaiba.fandom.com/wiki/Episode_5", KNY_EPISODE_5_HTML);
    assert.equal(directMappingFromText(page, { direction: "episode-to-chapter", number: "5" }).matched_range, "Chapters 8-9");
  });

  it("works chapter-to-episode from a chapter page", () => {
    const page = item("https://onepiece.fandom.com/wiki/Chapter_154", OP_CHAPTER_154_HTML);
    assert.equal(directMappingFromText(page, { direction: "chapter-to-episode", number: "154" }).matched_range, "Episode 91");
  });

  it("only fires on the requested page, and never from free text", () => {
    const wrongPage = item("https://jujutsu-kaisen.fandom.com/wiki/Episode_31", JJK_EPISODE_30_HTML);
    assert.equal(directMappingFromText(wrongPage, { direction: "episode-to-chapter", number: "30" }), null);
    const textOnly = { url: "https://onepiece.fandom.com/wiki/Episode_1090", snippet: `${"x ".repeat(300)}Statistics Chapter 1061` };
    assert.equal(directMappingFromText(textOnly, { direction: "episode-to-chapter", number: "1090" }), null);
  });

  it("ignores same-numbered pages from other series' wikis", () => {
    // Observed live: a One Piece lookup's search results included My Hero Academia's Chapter 154.
    const mha = item("https://myheroacademia.fandom.com/wiki/Chapter_154", infobox("Anime", '<a href="/wiki/Episode_75">Episode 75</a>'));
    const onePiece = item("https://onepiece.fandom.com/wiki/Chapter_154", OP_CHAPTER_154_HTML);
    const lookup = { number: "154", direction: "chapter-to-episode", trustedHosts: ["onepiece.fandom.com"] };
    assert.equal(directMappingFromResults({ ...lookup, results: [mha] }), null);
    assert.equal(directMappingFromResults({ ...lookup, results: [mha, onePiece] }).matched_range, "Episode 91");
  });

  it("builds API URLs for Fandom articles only", () => {
    const api = new URL(fandomApiUrl("https://onepiece.fandom.com/wiki/Episode_1090"));
    assert.equal(api.origin + api.pathname, "https://onepiece.fandom.com/api.php");
    assert.equal(api.searchParams.get("page"), "Episode_1090");
    assert.equal(api.searchParams.get("action"), "parse");
    assert.match(fandomApiUrl("https://naruto.fandom.com/es/wiki/Episodio_1"), /^https:\/\/naruto\.fandom\.com\/es\/api\.php\?/);
    assert.equal(fandomApiUrl("https://www.animefillerguide.com/anime/naruto/"), null);
  });

  it("formats number ranges", () => {
    assert.equal(formatNumberRange("Chapter", ["1061"]), "Chapter 1061");
    assert.equal(formatNumberRange("Chapter", ["80", "64", "79", "79"]), "Chapters 64, 79-80");
    assert.equal(formatNumberRange("Episode", []), null);
  });

  it("decodes numeric HTML entities so dashes and apostrophes match", () => {
    assert.equal(stripHtml("Kimetsu no Yaiba &#8211; Infinity Castle &#038; Akaza&#8217;s return"), "Kimetsu no Yaiba – Infinity Castle & Akaza’s return");
    assert.ok(movieMentionPattern("Infinity Castle").test(stripHtml("Yaiba &#8211; The Movie: Infinity&#160;Castle")));
  });
});

describe("where to start reading", () => {
  const AFG = "https://www.animefillerguide.com/anime/my-hero-academia/";
  const text = "Where Does the Anime End? Where Should I Start Reading? The anime ended at episode 170 (11 of Season 8) , which corresponds to Chapter 429 and 430 of the manga. The adaptation covers up to this point. After watching the anime, to continue the story in the manga, start reading from Chapter 431 , which corresponds to Volume 42.";
  const results = [{ title: "My Hero Academia Filler List", url: AFG, snippet: text }];

  it("accepts the chapter the source says to start from", () => {
    const response = { status: "found", matched_range: "Chapter 431", source: AFG, note: "The anime ends at episode 170, which adapts up to Chapter 430." };
    assert.deepEqual(validateReadingStart(response, { results }), response);
  });

  it("rejects a chapter that isn't the stated starting point", () => {
    const response = { status: "found", matched_range: "Chapter 430", source: AFG, note: null };
    assert.equal(validateReadingStart(response, { results }).status, "not_found");
  });

  it("drops a note containing numbers the source doesn't have", () => {
    const response = { status: "found", matched_range: "Chapter 431", source: AFG, note: "Season 9 is coming in 2027." };
    assert.equal(validateReadingStart(response, { results }).note, null);
  });

  it("requires an explicit statement before answering 'complete'", () => {
    const complete = { status: "complete", matched_range: null, source: AFG, note: null };
    assert.equal(validateReadingStart(complete, { results }).status, "not_found");
    const finished = [{ ...results[0], snippet: "The anime adapts the entire manga, from the first chapter to the last." }];
    assert.equal(validateReadingStart(complete, { results: finished }).status, "complete");
  });

  it("normalizes model output and caches per series", () => {
    assert.equal(normalizeReadingStartResponse({ status: "found", matched_range: "Chapter 1", source: null }).status, "not_found");
    assert.equal(normalizeReadingStartResponse({ status: "filler", source: AFG }).status, "not_found");
    assert.notEqual(cacheKey({ mode: "start", anime: "Bleach" }), cacheKey({ anime: "Bleach", number: "1", direction: "episode-to-chapter" }));
  });
});

describe("series registry", () => {
  it("resolves canonical names, alternate titles and nicknames", () => {
    assert.equal(resolveSeries("Kimetsu no Yaiba").name, "Demon Slayer");
    assert.equal(resolveSeries("jjk").name, "Jujutsu Kaisen");
    assert.equal(resolveSeries("SHINGEKI NO KYOJIN").name, "Attack on Titan");
    assert.equal(resolveSeries("hunter x hunter").afg, "hunter-x-hunter-2011");
    assert.equal(resolveSeries("haikyū!!").afg, "haikyuu");
  });

  it("tolerates small typos but not ambiguous or short guesses", () => {
    assert.equal(resolveSeries("Demon Slayr").name, "Demon Slayer");
    assert.equal(resolveSeries("Jujutsu Kaisn").name, "Jujutsu Kaisen");
    assert.equal(resolveSeries("zzzz unknown show"), null);
    assert.equal(resolveSeries("xyz"), null);
  });

  it("knows each curated series' real source locations", () => {
    const demonSlayer = resolveSeries("Demon Slayer");
    assert.equal(demonSlayer.fandom, "kimetsu-no-yaiba.fandom.com");
    assert.equal(demonSlayer.listfist, null);
    assert.equal(resolveSeries("One Piece").listfist, "one-piece");
  });

  it("has every curated entry backed by a generated series-data.json entry", () => {
    const slugs = new Set(JSON.parse(fs.readFileSync(new URL("../lib/series-data.json", import.meta.url), "utf8")).map((entry) => entry.afg));
    assert.deepEqual(CURATED_SLUGS.filter((slug) => !slugs.has(slug)), []);
    assert.ok(seriesList().length > 100);
  });
});
