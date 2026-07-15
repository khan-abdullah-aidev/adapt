// Regression suite for the episode<->chapter lookup pipeline. Spawns the real server against the
// real search/extraction APIs (so it needs valid .env credentials) and re-runs a fixed set of known
// answers, catching the kind of retrieval/extraction regressions this project has hit before:
// filler misclassification, wrong chapter numbers, and thin-snippet source conflicts.
//
// Usage:
//   node test/regression.mjs            (forces fresh lookups, bypassing cache - default)
//   TEST_USE_CACHE=1 node test/regression.mjs   (allows cache hits - faster, cheaper, less thorough)

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
  if (testCase.expect.matched_range && data.matched_range !== testCase.expect.matched_range) {
    return { pass: false, detail: `expected matched_range "${testCase.expect.matched_range}", got "${data.matched_range}"` };
  }
  return { pass: true, detail: JSON.stringify(data) };
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

    let passCount = 0;
    for (const testCase of cases) {
      process.stdout.write(`  ${testCase.name} ... `);
      try {
        const result = await runCase(testCase);
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

    console.log(`\n${passCount}/${cases.length} passed.`);
    exitCode = passCount === cases.length ? 0 : 1;
  } catch (error) {
    console.error("Setup failed:", error.message);
    console.error("Server output so far:\n" + serverOutput);
  } finally {
    server.kill();
  }

  process.exit(exitCode);
}

main();
