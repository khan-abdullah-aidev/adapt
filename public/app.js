const form = document.querySelector("#lookup-form");
const animeInput = document.querySelector("#anime");
const numberInput = document.querySelector("#number");
const movieNameInput = document.querySelector("#movie-name");
const modeButtons = document.querySelectorAll(".mode-btn");
const fromLabel = document.querySelector("#from-label");
const toLabel = document.querySelector("#to-label");
const swapButton = document.querySelector("#swap");
const findButton = document.querySelector("#find");
const findLabel = document.querySelector("#find-label");
const resultTile = document.querySelector("#result-tile");
const answer = document.querySelector("#answer");
const meta = document.querySelector("#meta");
const metaBody = document.querySelector("#meta-body");
const sentence = document.querySelector("#result-sentence");
const sourceLink = document.querySelector("#source-link");
const cacheBadge = document.querySelector("#cache-badge");
const recheckBtn = document.querySelector("#recheck-btn");
const recentsWrap = document.querySelector("#recents-wrap");
const recentsList = document.querySelector("#recents");

const loadingMessages = ["Reading the source", "Checking snippets", "Asking extractor", "Verifying source"];

let mode = "episode";
let direction = "episode-to-chapter";
let status = "idle";
let result = null;
let revealed = false;
let messageIndex = 0;
let loadingTimer = null;
let recents = readRecents();

function cap(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function parts() {
  if (mode === "movie") return { from: "movie", to: "chapter/arc" };
  const from = direction === "episode-to-chapter" ? "episode" : "chapter";
  const to = direction === "episode-to-chapter" ? "chapter" : "episode";
  return { from, to };
}

// The subject text shown in result sentences and recents - "Episode 1090" in episode mode,
// or the movie name itself in movie mode.
function subjectLabel() {
  if (mode === "movie") return movieNameInput.value.trim();
  return `${cap(parts().from)} ${numberInput.value.trim()}`;
}

function setMode(nextMode) {
  mode = nextMode;
  modeButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.mode === mode));
  swapButton.hidden = mode === "movie";
  numberInput.hidden = mode === "movie";
  movieNameInput.hidden = mode !== "movie";
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
  localStorage.setItem("adapt.recents", JSON.stringify(recents.slice(0, 4)));
}

function setStatus(nextStatus, nextResult = null) {
  status = nextStatus;
  result = nextResult;
  revealed = nextStatus !== "found";
  render();
}

function setLoading(on) {
  if (on) {
    messageIndex = 0;
    findLabel.textContent = loadingMessages[0];
    findButton.classList.add("loading");
    loadingTimer = setInterval(() => {
      messageIndex = (messageIndex + 1) % loadingMessages.length;
      findLabel.textContent = loadingMessages[messageIndex];
    }, 1600);
  } else {
    clearInterval(loadingTimer);
    loadingTimer = null;
    findButton.classList.remove("loading");
    findLabel.textContent = "Find match";
  }
}

function validForm() {
  if (status === "loading") return false;
  if (!animeInput.value.trim()) return false;
  return mode === "movie" ? Boolean(movieNameInput.value.trim()) : Boolean(numberInput.value.trim());
}

function resetResult() {
  status = "idle";
  result = null;
  revealed = false;
  render();
}

function renderResult() {
  answer.className = "answer";
  resultTile.classList.remove("revealable");
  meta.hidden = true;
  sourceLink.hidden = true;
  cacheBadge.hidden = true;
  recheckBtn.hidden = true;
  metaBody.classList.remove("blurred");

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

  if (status === "error") {
    answer.classList.add("answer-error");
    answer.textContent = "Try again";
    sentence.textContent = result?.error || "The lookup failed before a source-backed answer could be returned.";
    meta.hidden = false;
    return;
  }

  if (status === "filler") {
    answer.classList.add("answer-filler");
    answer.textContent = "Anime-original (filler)";
    sentence.textContent = mode === "movie"
      ? `${subjectLabel()} is an anime-original story — not adapted from the manga.`
      : `Episode ${numberInput.value.trim()} is anime-original — not adapted from the manga.`;
    meta.hidden = false;
    if (result?.source) {
      sourceLink.href = result.source;
      sourceLink.hidden = false;
    }
    cacheBadge.hidden = !result?.cached;
    recheckBtn.hidden = false;
    return;
  }

  if (status === "notfound") {
    answer.classList.add("answer-notfound");
    answer.textContent = mode === "movie"
      ? "No match found"
      : direction === "episode-to-chapter" ? "No chapter found" : "No episode found";
    sentence.textContent = "The search results did not explicitly contain a clear mapping, so no answer was returned.";
    meta.hidden = false;
    cacheBadge.hidden = !result?.cached;
    return;
  }

  if (status === "found") {
    answer.textContent = result.matched_range;
    if (!revealed) {
      answer.classList.add("blurred");
      resultTile.classList.add("revealable");
      metaBody.classList.add("blurred");
    }
    sentence.textContent = `${subjectLabel()} maps to ${result.matched_range}.`;
    meta.hidden = false;
    sourceLink.href = result.source;
    sourceLink.hidden = false;
    cacheBadge.hidden = !result.cached;
    recheckBtn.hidden = false;
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
      if (item.mode === "movie") {
        setMode("movie");
        movieNameInput.value = item.movieName;
      } else {
        setMode("episode");
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
  findButton.disabled = !validForm();
  renderResult();
  renderRecents();
}

function pushRecent(response) {
  const query = mode === "movie"
    ? `${animeInput.value.trim()} · ${movieNameInput.value.trim()} (Movie)`
    : `${animeInput.value.trim()} · ${subjectLabel()}`;
  const answerText = response.status === "found"
    ? response.matched_range
    : response.status === "filler"
      ? "filler (anime-original)"
      : "— not found";
  const entry = {
    mode,
    anime: animeInput.value.trim(),
    number: mode === "movie" ? "" : numberInput.value.trim(),
    movieName: mode === "movie" ? movieNameInput.value.trim() : "",
    direction,
    query,
    answer: answerText
  };
  recents = [entry, ...recents.filter((item) => item.query !== query)].slice(0, 4);
  saveRecents();
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
  btn.addEventListener("click", () => setMode(btn.dataset.mode));
});

resultTile.addEventListener("click", () => {
  if (status === "found" && !revealed) {
    revealed = true;
    render();
  }
});

async function runLookup({ refresh = false } = {}) {
  setStatus("loading");
  setLoading(true);

  try {
    const body = mode === "movie"
      ? { anime: animeInput.value.trim(), mode: "movie", movieName: movieNameInput.value.trim(), refresh }
      : { anime: animeInput.value.trim(), mode: "episode", number: numberInput.value.trim(), direction, refresh };

    const response = await fetch("/api/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    setLoading(false);

    if (!response.ok) {
      setStatus("error", data);
      return;
    }

    pushRecent(data);
    const nextStatus = data.status === "found" ? "found" : data.status === "filler" ? "filler" : "notfound";
    setStatus(nextStatus, data);
  } catch (error) {
    setLoading(false);
    setStatus("error", { error: error.message });
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!validForm()) return;
  runLookup();
});

recheckBtn.addEventListener("click", () => {
  if (status === "loading") return;
  runLookup({ refresh: true });
});

render();
