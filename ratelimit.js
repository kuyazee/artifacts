// Fixed-window per-key failure counter. In-memory, single-process — pairs with a
// CDN/edge limiter (see docs/deploy.md), it is not a substitute for one. Only
// failures consume budget; a successful auth never counts against a key.
export function createRateLimiter({ windowMs, max, sweepMs = 60_000, maxEntries = 10_000 }) {
  const hits = new Map(); // key -> { count, resetAt }
  let lastSweep = 0;

  function sweep(now) {
    if (now - lastSweep < sweepMs) return;
    lastSweep = now;
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    // Hard cap so the limiter itself cannot be turned into a memory DoS.
    if (hits.size > maxEntries) {
      let excess = hits.size - maxEntries;
      for (const k of hits.keys()) {
        if (excess-- <= 0) break;
        hits.delete(k);
      }
    }
  }

  return {
    check(key, now = Date.now()) {
      sweep(now);
      const e = hits.get(key);
      if (e && e.resetAt > now && e.count >= max) {
        return { limited: true, retryAfter: Math.ceil((e.resetAt - now) / 1000) };
      }
      return { limited: false, retryAfter: 0 };
    },
    fail(key, now = Date.now()) {
      const e = hits.get(key);
      if (e && e.resetAt > now) e.count++;
      else hits.set(key, { count: 1, resetAt: now + windowMs });
    },
  };
}
