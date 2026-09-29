// Answer cache with two backends. With UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN set it
// stores answers in Redis through Upstash's REST API, so they survive restarts and deploys - on hosts
// like Render's free tier the local filesystem is wiped every time the instance spins down. Without
// them it uses a local JSON file, which is fine for development.
//
// A cache failure never fails a lookup: reads degrade to a miss and writes are dropped (and logged).

import fs from "node:fs/promises";
import path from "node:path";

const KEY_PREFIX = "adapt:";

function isFresh(entry, maxAgeMs) {
  if (!entry?.response) return false;
  return !(Date.now() - Date.parse(entry.cached_at) > maxAgeMs);
}

function createFileCache(filePath) {
  let writes = Promise.resolve();

  async function read() {
    let raw;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
    try {
      return JSON.parse(raw);
    } catch (error) {
      console.error("Cache file is corrupt, treating as empty:", error.message);
      return {};
    }
  }

  async function write(cache) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(cache, null, 2));
    await fs.rename(temp, filePath);
  }

  return {
    kind: "file",
    async get(key, maxAgeMs = Infinity) {
      try {
        const entry = (await read())[key];
        return isFresh(entry, maxAgeMs) ? entry.response : null;
      } catch (error) {
        console.error("Cache read failed:", error.message);
        return null;
      }
    },
    async set(key, response, request) {
      // Serialized so concurrent lookups don't overwrite each other's read-modify-write.
      writes = writes.then(async () => {
        const cache = await read();
        cache[key] = { response, request, cached_at: new Date().toISOString() };
        await write(cache);
      }).catch((error) => console.error("Cache write failed:", error.message));
      await writes;
    }
  };
}

function createRedisRestCache({ url, token, fetchImpl }) {
  // Upstash's REST API takes a Redis command as a JSON array POSTed to the database URL.
  async function command(args) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(3000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw new Error(`Cache ${args[0]} failed: ${data.error || response.status}`);
    return data.result;
  }

  return {
    kind: "redis",
    async get(key, maxAgeMs = Infinity) {
      try {
        const raw = await command(["GET", KEY_PREFIX + key]);
        const entry = raw ? JSON.parse(raw) : null;
        return isFresh(entry, maxAgeMs) ? entry.response : null;
      } catch (error) {
        console.error("Cache read failed:", error.message);
        return null;
      }
    },
    async set(key, response, request, { ttlMs } = {}) {
      const entry = JSON.stringify({ response, request, cached_at: new Date().toISOString() });
      const expiry = Number.isFinite(ttlMs) ? ["PX", String(Math.round(ttlMs))] : [];
      try {
        await command(["SET", KEY_PREFIX + key, entry, ...expiry]);
      } catch (error) {
        console.error("Cache write failed:", error.message);
      }
    }
  };
}

export function createCache({ filePath, redisUrl, redisToken, fetchImpl = fetch }) {
  if (redisUrl && redisToken) return createRedisRestCache({ url: redisUrl.replace(/\/+$/, ""), token: redisToken, fetchImpl });
  return createFileCache(filePath);
}
