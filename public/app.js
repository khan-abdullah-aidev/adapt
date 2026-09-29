const form = document.querySelector("#lookup-form");
const animeInput = document.querySelector("#anime");
const seriesOptions = document.querySelector("#series-options");
const numberInput = document.querySelector("#number");
const movieNameInput = document.querySelector("#movie-name");
const modeButtons = document.querySelectorAll(".mode-btn");
const converter = document.querySelector("#converter");
const fromTile = document.querySelector("#from-tile");
const fromLabel = document.querySelector("#from-label");
const toLabel = document.querySelector("#to-label");
const swapButton = document.querySelector("#swap");
const findButton = document.querySelector("#find");
const findLabel = document.querySelector("#find-label");
const answer = document.querySelector("#answer");
const meta = document.querySelector("#meta");
const sentence = document.querySelector("#result-sentence");
const sourceLink = document.querySelector("#source-link");
const cacheBadge = document.querySelector("#cache-badge");
const shareBtn = document.querySelector("#share-btn");
const recheckBtn = document.querySelector("#recheck-btn");
const recentsWrap = document.querySelector("#recents-wrap");
const recentsList = document.querySelector("#recents");

let mode = "episode"; // "episode" | "movie" | "start"
let direction = "episode-to-chapter";
let status = "idle";
let result = null;
let recents = readRecents();
let shareResetTimer = null;

function cap(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function parts() {
  if (mode === "movie") return { from: "movie", to: "chapter/arc" };
  if (mode === "start") return { from: "series", to: "start reading at" };
  const from = direction === "episode-to-chapter" ? "episode" : "chapter";
  const to = direction === "episode-to-chapter" ? "chapter" : "episode";
  return { from, to };
}

// The subject text shown in result sentences and recents - "Episode 1090" in episode mode, the movie
// name itself in movie mode.
function subjectLabel() {
  if (mode === "movie") return movieNameInput.value.trim();
  if (mode === "start") return "Where to start reading";
  return `${cap(parts().from)} ${numberInput.value.trim()}`;
}

// The canonical series name the server resolved the input to ("Demon Slayer" for "Kimetsu no Yaiba").
function seriesName() {
  return result?.series || animeInput.value.trim();
}

function setMode(nextMode) {
  mode = nextMode;
  modeButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.mode === mode));
  swapButton.hidden = mode !== "episode";
  numberInput.hidden = mode !== "episode";
  movieNameInput.hidden = mode !== "movie";
  fromTile.hidden = mode === "start";
  converter.classList.toggle("single", mode === "start");
  resetResult();
}

function readRecents() {
  try {
    const value = JSON.parse(localStorage.getItem("adapt.recents") || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveRecents() {
  try {
    localStorage.setItem("adapt.recents", JSON.stringify(recents.slice(0, 4)));
  } catch {}
}

function setStatus(nextStatus, nextResult = null) {
  status = nextStatus;
  result = nextResult;
  render();
}

function idleFindLabel() {
  return mode === "start" ? "Find where to start" : "Find match";
}

function setProgress(message) {
  findLabel.textContent = message;
}

function validForm() {
  if (status === "loading") return false;
  if (!animeInput.value.trim()) return false;
  if (mode === "movie") return Boolean(movieNameInput.value.trim());
  if (mode === "start") return true;
  return Boolean(numberInput.value.trim());
}

function resetResult() {
  status = "idle";
  result = null;
  render();
}

function renderResult() {
  answer.className = "answer";
  meta.hidden = true;
  sourceLink.hidden = true;
  cacheBadge.hidden = true;
  shareBtn.hidden = true;
  recheckBtn.hidden = true;
  recheckBtn.textContent = "Wrong? Re-check";

  if (status === "idle") {
    answer.classList.add("answer-idle");
    answer.textContent = "—";
    return;
  }

  if (status === "loading") {
    answer.classList.add("shimmer");
    answer.textContent = "";
    return;
  }

  meta.hidden = false;

  if (status === "error") {
    answer.classList.add("answer-error");
    answer.textContent = "Lookup failed";
    sentence.textContent = result?.error || "The lookup failed before a source-backed answer could be returned.";
    recheckBtn.textContent = "Try again";
    recheckBtn.hidden = false;
    return;
  }

  shareBtn.hidden = false;
  cacheBadge.hidden = !result?.cached;
  if (result?.source) {
    sourceLink.href = result.source;
    sourceLink.hidden = false;
  }

  if (status === "notfound") {
    answer.classList.add("answer-notfound");
    answer.textContent = mode === "movie"
      ? "No match found"
      : mode === "start"
        ? "No starting point found"
        : direction === "episode-to-chapter" ? "No chapter found" : "No episode found";
    sentence.textContent = "The search results did not explicitly contain a clear mapping, so no answer was returned.";
    return;
  }

  recheckBtn.hidden = false;

  if (status === "filler") {
    answer.classList.add("answer-filler");
    answer.textContent = "Anime-original (filler)";
    sentence.textContent = mode === "movie"
      ? `${subjectLabel()} is an anime-original ${seriesName()} story — not adapted from the manga.`
      : `Episode ${numberInput.value.trim()} of ${seriesName()} is anime-original — not adapted from the manga.`;
    return;
  }

  if (status === "complete") {
    answer.classList.add("answer-complete");
    answer.textContent = "Anime covers the whole manga";
    sentence.textContent = result.note || `The ${seriesName()} anime adapts the entire manga — there's nothing further to read.`;
    return;
  }

  answer.textContent = result.matched_range;
  if (mode === "start") {
    const pickUp = `Pick up the ${seriesName()} manga at ${result.matched_range}.`;
    sentence.textContent = result.note?.includes(result.matched_range) ? result.note : [result.note, pickUp].filter(Boolean).join(" ");
  } else if (mode === "movie") {
    sentence.textContent = `${subjectLabel()} (${seriesName()}) maps to ${result.matched_range}.`;
  } else {
    sentence.textContent = `${subjectLabel()} of ${seriesName()} maps to ${result.matched_range}.`;
  }
}

function renderRecents() {
  recentsWrap.hidden = recents.length === 0;
  recentsList.replaceChildren(...recents.map((item) => {
    const button = document.createElement("button");
    button.className = "recent";
    button.type = "button";
    const query = document.createElement("strong");
    query.textContent = item.query;
    const range = document.createElement("span");
    range.textContent = item.answer;
    button.append(query, range);
    button.addEventListener("click", () => {
      animeInput.value = item.anime;
      setMode(item.mode || "episode");
      if (item.mode === "movie") {
        movieNameInput.value = item.movieName;
      } else if (item.mode !== "start") {
        numberInput.value = item.number;
        direction = item.direction;
      }
      render();
      form.requestSubmit();
    });
    return button;
  }));
}

function render() {
  const { from, to } = parts();
  fromLabel.textContent = cap(from);
  toLabel.textContent = cap(to);
  if (mode === "episode") numberInput.placeholder = from === "episode" ? "1090" : "1130";
  if (status !== "loading") findLabel.textContent = idleFindLabel();
  findButton.disabled = !validForm();
  renderResult();
  renderRecents();
}

function pushRecent(response) {
  const anime = animeInput.value.trim();
  const query = mode === "movie"
    ? `${anime} · ${movieNameInput.value.trim()} (Movie)`
    : `${anime} · ${subjectLabel()}`;
  const answerText = {
    found: response.matched_range,
    filler: "filler (anime-original)",
    complete: "whole manga adapted"
  }[response.status] || "— not found";
  const entry = {
    mode,
    anime,
    number: mode === "episode" ? numberInput.value.trim() : "",
    movieName: mode === "movie" ? movieNameInput.value.trim() : "",
    direction,
    query,
    answer: answerText
  };
  recents = [entry, ...recents.filter((item) => item.query !== query)].slice(0, 4);
  saveRecents();
}

// Shareable links: the current lookup as query parameters, e.g. ?series=One+Piece&episode=1090,
// ?series=Demon+Slayer&movie=Infinity+Castle+Part+2 or ?series=Bleach&mode=start.
function shareUrl() {
  const params = new URLSearchParams({ series: animeInput.value.trim() });
  if (mode === "movie") params.set("movie", movieNameInput.value.trim());
  else if (mode === "start") params.set("mode", "start");
  else params.set(direction === "episode-to-chapter" ? "episode" : "chapter", numberInput.value.trim());
  const url = new URL(window.location.href);
  url.search = params.toString();
  url.hash = "";
  return url.toString();
}

// Fills the form from a shared link. Returns true when the link describes a complete lookup.
function applyUrlState() {
  const params = new URLSearchParams(window.location.search);
  const series = params.get("series");
  if (!series) return false;
  animeInput.value = series;
  const number = (value) => value.replace(/[^\d.-]/g, "");

  if (params.has("movie")) {
    setMode("movie");
    movieNameInput.value = params.get("movie");
  } else if (params.get("mode") === "start") {
    setMode("start");
  } else if (params.has("chapter")) {
    setMode("episode");
    direction = "chapter-to-episode";
    numberInput.value = number(params.get("chapter"));
  } else if (params.has("episode")) {
    setMode("episode");
    direction = "episode-to-chapter";
    numberInput.value = number(params.get("episode"));
  }
  render();
  return validForm();
}

async function loadSeriesOptions() {
  try {
    const response = await fetch("/api/series");
    if (!response.ok) return;
    const series = await response.json();
    const options = [];
    for (const { name, aliases } of series) {
      const option = document.createElement("option");
      option.value = name;
      options.push(option);
      for (const alias of aliases || []) {
        const aliasOption = document.createElement("option");
        aliasOption.value = alias;
        aliasOption.label = name;
        options.push(aliasOption);
      }
    }
    seriesOptions.replaceChildren(...options);
  } catch {
    // Autocomplete is a convenience - the form works the same without it.
  }
}

// POSTs the lookup and reads the server's streamed progress (newline-delimited JSON): progress lines
// while it works, then one result or error line. Validation and rate-limit rejections come back as
// plain JSON with a 4xx status instead.
async function postLookup(body, onProgress) {
  let response;
  try {
    response = await fetch("/api/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, stream: true })
    });
  } catch {
    throw new Error("Couldn't reach the server. Check your connection and try again.");
  }

  const isStream = (response.headers.get("content-type") || "").includes("application/x-ndjson");
  if (!response.ok || !isStream || !response.body) {
    // A proxy/host error page (e.g. an HTML 502 while the server restarts) isn't JSON.
    const data = await response.json().catch(() => {
      throw new Error("The server sent back an unexpected response. Please try again.");
    });
    return { ok: response.ok, data };
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  let final = null;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += value;
      let newline;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.type === "progress") onProgress(event.message);
        else final = event;
      }
    }
  } catch {
    throw new Error("The connection dropped before the lookup finished. Please try again.");
  }

  if (!final) throw new Error("The connection dropped before the lookup finished. Please try again.");
  return { ok: final.type === "result", data: final };
}

async function runLookup({ refresh = false } = {}) {
  setStatus("loading");
  findButton.classList.add("loading");
  setProgress("Starting lookup");
  window.history.replaceState(null, "", shareUrl());

  const anime = animeInput.value.trim();
  const body = mode === "movie"
    ? { anime, mode: "movie", movieName: movieNameInput.value.trim(), refresh }
    : mode === "start"
      ? { anime, mode: "start", refresh }
      : { anime, mode: "episode", number: numberInput.value.trim(), direction, refresh };

  try {
    const { ok, data } = await postLookup(body, setProgress);
    findButton.classList.remove("loading");

    if (!ok) {
      setStatus("error", data);
      return;
    }

    pushRecent(data);
    const nextStatus = { found: "found", filler: "filler", complete: "complete" }[data.status] || "notfound";
    setStatus(nextStatus, data);
  } catch (error) {
    findButton.classList.remove("loading");
    setStatus("error", { error: error.message });
  }
}

animeInput.addEventListener("input", () => {
  if (status !== "loading") resetResult();
  else render();
});
numberInput.addEventListener("input", () => {
  numberInput.value = numberInput.value.replace(/[^\d.-]/g, "");
  if (status !== "loading") resetResult();
  else render();
});
movieNameInput.addEventListener("input", () => {
  if (status !== "loading") resetResult();
  else render();
});

swapButton.addEventListener("click", () => {
  direction = direction === "episode-to-chapter" ? "chapter-to-episode" : "episode-to-chapter";
  resetResult();
});

modeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (status !== "loading") setMode(btn.dataset.mode);
  });
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!validForm()) return;
  runLookup();
});

recheckBtn.addEventListener("click", () => {
  if (status === "loading") return;
  runLookup({ refresh: true });
});

// Some browsers and embedded webviews leave the async clipboard API waiting on a permission prompt
// that never appears, so give it a moment and then fall back to the legacy copy command.
async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    const copied = await Promise.race([
      navigator.clipboard.writeText(text).then(() => true, () => false),
      new Promise((resolve) => setTimeout(() => resolve(false), 1200))
    ]);
    if (copied) return true;
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

shareBtn.addEventListener("click", async () => {
  shareBtn.textContent = (await copyText(shareUrl())) ? "Link copied" : "Copy failed";
  clearTimeout(shareResetTimer);
  shareResetTimer = setTimeout(() => {
    shareBtn.textContent = "Copy link";
  }, 1800);
});

loadSeriesOptions();
render();
if (applyUrlState()) runLookup();
