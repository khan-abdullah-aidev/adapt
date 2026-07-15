const form = document.querySelector("#lookup-form");
const animeInput = document.querySelector("#anime");
const numberInput = document.querySelector("#number");
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
  const from = direction === "episode-to-chapter" ? "episode" : "chapter";
  const to = direction === "episode-to-chapter" ? "chapter" : "episode";
  return { from, to };
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
  return animeInput.value.trim() && numberInput.value.trim() && status !== "loading";
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
    sentence.textContent = `Episode ${numberInput.value.trim()} is anime-original — not adapted from the manga.`;
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
    answer.textContent = direction === "episode-to-chapter" ? "No chapter found" : "No episode found";
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
    const { from, to } = parts();
    sentence.textContent = `${cap(from)} ${numberInput.value.trim()} maps to ${result.matched_range}.`;
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
      numberInput.value = item.number;
      direction = item.direction;
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
  numberInput.placeholder = from === "episode" ? "1090" : "1130";
  findButton.disabled = !validForm();
  renderResult();
  renderRecents();
}

function pushRecent(response) {
  const { from } = parts();
  const query = `${animeInput.value.trim()} · ${cap(from)} ${numberInput.value.trim()}`;
  const answerText = response.status === "found"
    ? response.matched_range
    : response.status === "filler"
      ? "filler (anime-original)"
      : "— not found";
  const entry = {
    anime: animeInput.value.trim(),
    number: numberInput.value.trim(),
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

swapButton.addEventListener("click", () => {
  direction = direction === "episode-to-chapter" ? "chapter-to-episode" : "episode-to-chapter";
  resetResult();
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
    const response = await fetch("/api/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        anime: animeInput.value.trim(),
        number: numberInput.value.trim(),
        direction,
        refresh
      })
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
