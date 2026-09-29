// Regression suite for the episode<->chapter lookup pipeline. Spawns the real server against the
// real search/extraction APIs (so it needs valid .env credentials) and re-runs a fixed set of known
// answers, catching the kind of retrieval/extraction regressions this project has hit before:
// filler misclassification, wrong chapter numbers, and thin-snippet source conflicts.
//
// For fast offline checks of the parsing/validation logic, use `npm test` (test/extraction.test.mjs).
//
// Usage:
//   npm run test:live            (forces fresh lookups, bypassing cache - default)
//   TEST_USE_CACHE=1 npm run test:live   (allows cache hits - faster, cheaper, less thorough)

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const PORT = 3999;
const BASE_URL = `http://localhost:${PORT}`;
const USE_REFRESH = process.env.TEST_USE_CACHE !== "1";

const cases = [
  {
    name: "Naruto Episode 26 (known filler)",
    request: { anime: "Naruto", number: "26", direction: "episode-to-chapter" },
    expect: { status: "filler" }
  },
  {
    name: "Bleach Episode 205 (known filler)",
    request: { anime: "Bleach", number: "205", direction: "episode-to-chapter" },
    expect: { status: "filler" }
  },
  {
    name: "One Piece Episode 1090 -> Chapter 1061",
    request: { anime: "One Piece", number: "1090", direction: "episode-to-chapter" },
    expect: { status: "found", matched_range: "Chapter 1061" }
  },
  {
    name: "Black Clover Episode 12 -> Chapter 10",
    request: { anime: "Black Clover", number: "12", direction: "episode-to-chapter" },
    expect: { status: "found", matched_range: "Chapter 10" }
  },
  {
    name: "Black Clover Episode 142 (known filler)",
    request: { anime: "Black Clover", number: "142", direction: "episode-to-chapter" },
    expect: { status: "filler" }
  },
  {
    name: "One Piece Chapter 154 -> Episode 91 (chapter-to-episode)",
    request: { anime: "One Piece", number: "154", direction: "chapter-to-episode" },
    expect: { status: "found", matched_range: "Episode 91" }
  },
  // Movie answers are free-form ("Chapters 157-180", "Chapters 157 (p. 7) - 180 (p. 7)", ...), so these
  // check for the boundary chapter numbers rather than an exact string. Part 1 vs Part 2 guards against
  // multi-part movies collapsing into one answer.
  {
    name: "Demon Slayer movie Infinity Castle Part 1 -> Chapters 140-157",
    request: { anime: "Demon Slayer", mode: "movie", movieName: "Infinity Castle Part 1" },
    expect: { status: "found", matched_numbers: ["140", "157"] }
  },
  {
    name: "Demon Slayer movie Infinity Castle Part 2 -> Chapters 157-180",
    request: { anime: "Demon Slayer", mode: "movie", movieName: "Infinity Castle Part 2" },
    expect: { status: "found", matched_numbers: ["157", "180"] }
  },
  // Series registry: alternate titles and typos resolve to the canonical series (and its real wiki).
  {
    name: "Kimetsu no Yaiba (alternate title) Episode 5 -> Chapters 8-9",
    request: { anime: "Kimetsu no Yaiba", number: "5", direction: "episode-to-chapter" },
    expect: { status: "found", series: "Demon Slayer", matched_numbers: ["8", "9"] }
  },
  {
    name: "Jujutsu Kaisn (typo) Episode 30 -> Chapters 64, 79-80",
    request: { anime: "Jujutsu Kaisn", number: "30", direction: "episode-to-chapter" },
    expect: { status: "found", series: "Jujutsu Kaisen", matched_numbers: ["64", "79", "80"] }
  },
  // Where to start reading - finished anime, so the answer shouldn't move.
  {
    name: "My Hero Academia: start reading at Chapter 431",
    request: { anime: "My Hero Academia", mode: "start" },
    expect: { status: "found", matched_numbers: ["431"] }
  },
  // Arcs straight from the series wiki's arc infobox ("Overhaul" is found through the wiki's search).
  {
    name: "One Piece Marineford Arc -> Episodes 457-489, Chapters 550-580",
    request: { anime: "One Piece", mode: "arc", arcName: "Marineford" },
    expect: { status: "found", matched_numbers: ["457", "489", "550", "580"] }
  },
  {
    name: "MHA Overhaul arc -> Shie Hassaikai Arc, Episodes 62-78, Chapters 122-162",
    request: { anime: "MHA", mode: "arc", arcName: "Overhaul" },
    expect: { status: "found", matched_numbers: ["62", "78", "122", "162"] }
  },
  // Filler lists read off Anime Filler Guide's table - finished series, so the counts are fixed.
  {
    name: "Naruto filler list -> 89 of 220 episodes",
    request: { anime: "Naruto", mode: "fillers" },
    expect: { status: "found", matched_numbers: ["89", "220"] }
  },
  {
    name: "Black Clover filler list -> 18 of 170 (16 filler + 2 recaps)",
    request: { anime: "Black Clover", mode: "fillers" },
    expect: { status: "found", matched_numbers: ["18", "170"] }
  }
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/api/health`);
      if (response.ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error("Server did not become healthy in time.");
}

async function runCase(testCase) {
  const response = await fetch(`${BASE_URL}/api/lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...testCase.request, refresh: USE_REFRESH })
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    return { pass: false, detail: `HTTP ${response.status}: ${data.error || "no error message"}` };
  }
  if (data.status !== testCase.expect.status) {
    return { pass: false, detail: `expected status "${testCase.expect.status}", got "${data.status}"` };
  }
  if (testCase.expect.series && data.series !== testCase.expect.series) {
    return { pass: false, detail: `expected series "${testCase.expect.series}", got "${data.series}"` };
  }
  if (testCase.expect.matched_range && data.matched_range !== testCase.expect.matched_range) {
    return { pass: false, detail: `expected matched_range "${testCase.expect.matched_range}", got "${data.matched_range}"` };
  }
  const numbers = String(data.matched_range || "").match(/\d+/g) || [];
  const missing = (testCase.expect.matched_numbers || []).filter((number) => !numbers.includes(number));
  if (missing.length) {
    return { pass: false, detail: `expected matched_range to include ${missing.join(", ")}, got "${data.matched_range}"` };
  }
  return { pass: true, detail: JSON.stringify(data) };
}

// The UI's streamed mode: progress lines, then exactly one final result line.
async function checkStreaming() {
  const response = await fetch(`${BASE_URL}/api/lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ anime: "Black Clover", number: "12", direction: "episode-to-chapter", refresh: USE_REFRESH, stream: true })
  });
  const events = (await response.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const progress = events.filter((event) => event.type === "progress");
  const finals = events.filter((event) => event.type !== "progress");
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) {
    return { pass: false, detail: `content-type ${response.headers.get("content-type")}` };
  }
  if (finals.length !== 1 || finals[0].type !== "result" || events.at(-1) !== finals[0]) {
    return { pass: false, detail: `expected one trailing result line, got ${JSON.stringify(finals)}` };
  }
  if (USE_REFRESH && !progress.length) return { pass: false, detail: "no progress lines" };
  return { pass: true, detail: `${progress.length} progress lines (${progress.map((event) => event.message).join(" > ")}), then ${finals[0].status}` };
}

async function main() {
  console.log(`Starting server on port ${PORT} (refresh=${USE_REFRESH})...`);
  const server = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let serverOutput = "";
  server.stdout.on("data", (chunk) => { serverOutput += chunk; });
  server.stderr.on("data", (chunk) => { serverOutput += chunk; });

  let exitCode = 1;
  try {
    await waitForServer();
    console.log("Server is up. Running test cases sequentially...\n");

    const checks = [
      ...cases.map((testCase) => ({ name: testCase.name, run: () => runCase(testCase) })),
      { name: "Streamed lookup reports progress, then one result", run: checkStreaming }
    ];
    let passCount = 0;
    for (const check of checks) {
      process.stdout.write(`  ${check.name} ... `);
      try {
        const result = await check.run();
        if (result.pass) {
          passCount++;
          console.log(`PASS (${result.detail})`);
        } else {
          console.log(`FAIL - ${result.detail}`);
        }
      } catch (error) {
        console.log(`ERROR - ${error.message}`);
      }
    }

    console.log(`\n${passCount}/${checks.length} passed.`);
    exitCode = passCount === checks.length ? 0 : 1;
  } catch (error) {
    console.error("Setup failed:", error.message);
    console.error("Server output so far:\n" + serverOutput);
  } finally {
    server.kill();
  }

  process.exit(exitCode);
}

main();
