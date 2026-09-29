// Series registry: resolves whatever the user typed ("Kimetsu no Yaiba", "jjk", "Demon Slayr") to one
// canonical series, and knows where its sources live. The bulk of the list (series-data.json) is
// generated from Anime Filler Guide's index by scripts/update-series.mjs; CURATED below adds what
// can't be scraped. Unknown series still work - the server falls back to guessing source URLs from
// the typed name.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadGeneratedSeries() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "series-data.json"), "utf8"));
  } catch {
    return [];
  }
}

// Keyed by Anime Filler Guide slug. `name` overrides the display name where Anime Filler Guide leads
// with a less familiar title. `aliases` are nicknames people actually type. `fandom` is the
// series' Fandom wiki host, which usually can't be guessed from the name (Demon Slayer's is
// kimetsu-no-yaiba.fandom.com). `listfist` is set only for the few series ListFist has a conversion
// page for - fetching it for anything else is a guaranteed 404.
const CURATED = {
  "one-piece": { aliases: ["OP"], fandom: "onepiece.fandom.com", listfist: "one-piece" },
  "naruto": { fandom: "naruto.fandom.com", listfist: "naruto" },
  "naruto-shippuden": { aliases: ["Shippuden", "Naruto Shippuuden"], fandom: "naruto.fandom.com", listfist: "naruto-shippuden" },
  "boruto": { aliases: ["Boruto: Naruto Next Generations"], fandom: "naruto.fandom.com", listfist: "boruto" },
  "bleach": { aliases: ["Bleach: Thousand-Year Blood War", "TYBW"], fandom: "bleach.fandom.com", listfist: "bleach" },
  "black-clover": { fandom: "blackclover.fandom.com" },
  "demon-slayer": { aliases: ["KnY", "Demon Slayer: Kimetsu no Yaiba"], fandom: "kimetsu-no-yaiba.fandom.com" },
  "jujutsu-kaisen": { aliases: ["JJK"], fandom: "jujutsu-kaisen.fandom.com" },
  "my-hero-academia": { aliases: ["MHA", "BNHA", "Boku no Hero"], fandom: "myheroacademia.fandom.com" },
  "attack-on-titan": { aliases: ["AoT", "SnK"], fandom: "attackontitan.fandom.com" },
  "chainsaw-man": { aliases: ["CSM"], fandom: "chainsaw-man.fandom.com" },
  "hunter-x-hunter-2011": { aliases: ["Hunter x Hunter", "HxH"], fandom: "hunterxhunter.fandom.com" },
  "hunter-x-hunter-1999": { fandom: "hunterxhunter.fandom.com" },
  "dragon-ball": { fandom: "dragonball.fandom.com", listfist: "dragon-ball" },
  "dragon-ball-z": { aliases: ["DBZ"], fandom: "dragonball.fandom.com", listfist: "dragon-ball-z" },
  "dragon-ball-super": { aliases: ["DBS"], fandom: "dragonball.fandom.com", listfist: "dragon-ball-super" },
  "fairy-tail": { fandom: "fairytail.fandom.com" },
  "spy-x-family": { aliases: ["Spy Family"], fandom: "spy-x-family.fandom.com" },
  "tokyo-ghoul": { fandom: "tokyoghoul.fandom.com" },
  "haikyuu": { aliases: ["Haikyu"], fandom: "haikyuu.fandom.com" },
  "dr-stone": { fandom: "dr-stone.fandom.com" },
  "vinland-saga": { fandom: "vinlandsaga.fandom.com" },
  "blue-lock": { fandom: "bluelock.fandom.com" },
  "frieren-beyond-journeys-end": { aliases: ["Frieren"], fandom: "frieren.fandom.com" },
  "kaiju-no-8": { fandom: "kaiju-no-8.fandom.com" },
  "dandadan": { aliases: ["Dan Da Dan"], fandom: "dandadan.fandom.com" },
  "oshi-no-ko": { fandom: "oshinoko.fandom.com" },
  "mob-psycho-100": { fandom: "mob-psycho-100.fandom.com" },
  "one-punch-man": { aliases: ["OPM"], fandom: "onepunchman.fandom.com" },
  "fire-force": { fandom: "fire-force.fandom.com" },
  "death-note": { fandom: "deathnote.fandom.com" },
  "tokyo-revengers": { fandom: "tokyo-revengers.fandom.com" },
  "jigokuraku": { name: "Hell's Paradise", fandom: "jigokuraku.fandom.com" },
  "inuyasha": { fandom: "inuyasha.fandom.com" },
  "gintama": { fandom: "gintama.fandom.com" },
  "nanatsu-no-taizai": { name: "The Seven Deadly Sins", aliases: ["Seven Deadly Sins"], fandom: "nanatsu-no-taizai.fandom.com" },
  "jojos-bizarre-adventure": { aliases: ["JoJo", "JJBA"], fandom: "jojo.fandom.com" },
  "sakamoto-days": { fandom: "sakamoto-days.fandom.com" },
  "solo-leveling": { fandom: "solo-leveling.fandom.com" },
  "fullmetal-alchemist-brotherhood": { aliases: ["FMAB", "Fullmetal Alchemist"], fandom: "fma.fandom.com" },
  "yakusoku-no-neverland": { name: "The Promised Neverland", aliases: ["TPN"], fandom: "yakusokunoneverland.fandom.com" },
  "blue-exorcist": { fandom: "aonoexorcist.fandom.com" },
  "yu-yu-hakusho": { aliases: ["YYH"], fandom: "yuyuhakusho.fandom.com" },
  "mashle": { fandom: "mashle.fandom.com" },
  "undead-unluck": { fandom: "undead-unluck.fandom.com" },
  "wind-breaker": { fandom: "windbreaker.fandom.com" },
  "gachiakuta": { fandom: "gachiakuta.fandom.com" }
};

// Comparison key: case, accents, punctuation and spacing don't matter ("Haikyū!!" == "haikyu").
export function seriesKey(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

function buildRegistry() {
  const series = loadGeneratedSeries().map((entry) => {
    const curated = CURATED[entry.afg] || {};
    const name = curated.name || entry.name;
    const aliases = [entry.name, ...(entry.aliases || []), ...(curated.aliases || [])]
      .filter((alias) => seriesKey(alias) !== seriesKey(name));
    return {
      name,
      aliases: [...new Set(aliases)],
      afg: entry.afg,
      fandom: curated.fandom || null,
      listfist: curated.listfist || null
    };
  });

  // Canonical names win over aliases, and curated aliases win over scraped ones, so e.g. "Hunter x
  // Hunter" means the 2011 series rather than whichever entry happened to be listed first.
  const byKey = new Map();
  const claim = (key, entry) => {
    if (key && !byKey.has(key)) byKey.set(key, entry);
  };
  for (const entry of series) claim(seriesKey(entry.name), entry);
  for (const entry of series) {
    for (const alias of CURATED[entry.afg]?.aliases || []) claim(seriesKey(alias), entry);
  }
  for (const entry of series) {
    for (const alias of entry.aliases) claim(seriesKey(alias), entry);
  }
  return { series, byKey };
}

const registry = buildRegistry();

export const CURATED_SLUGS = Object.keys(CURATED);

// Levenshtein distance, giving up early once it's certain to exceed `max`.
function editDistance(a, b, max) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[b.length];
}

// Exact name/alias match first, then a small typo allowance ("Demon Slayr", "Jujutsu Kaisn") - but only
// for inputs long enough that a near-miss is unambiguous, and only when exactly one series is closest.
export function resolveSeries(input, { byKey } = registry) {
  const key = seriesKey(input);
  if (!key) return null;
  const exact = byKey.get(key);
  if (exact) return exact;
  if (key.length < 5) return null;

  const maxDistance = key.length >= 10 ? 2 : 1;
  let best = null;
  let bestDistance = Infinity;
  let tied = false;
  for (const [candidateKey, entry] of byKey) {
    if (Math.abs(candidateKey.length - key.length) > maxDistance) continue;
    const distance = editDistance(key, candidateKey, maxDistance);
    if (distance > maxDistance) continue;
    if (distance < bestDistance) {
      best = entry;
      bestDistance = distance;
      tied = false;
    } else if (distance === bestDistance && entry !== best) {
      tied = true;
    }
  }
  return best && !tied ? best : null;
}

// For the autocomplete list: every known series with the alternate names it can be found by.
export function seriesList() {
  return registry.series.map(({ name, aliases }) => ({ name, aliases }));
}
