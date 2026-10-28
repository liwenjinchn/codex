export class PoolError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Retry-After can be a delta in seconds or an HTTP date. Never shorten it.
export function retryDelay(value, now, fallback) {
  if (!value) return fallback;
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Math.max(fallback, Number(value) * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(fallback, date - now) : fallback;
}

const TRANSPORT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);

function isTransportError(error) {
  return TRANSPORT_CODES.has(error?.code) || TRANSPORT_CODES.has(error?.cause?.code);
}

export class KeyPool {
  constructor(config, { fetchImpl = fetch, now = () => performance.now(), wallNow = Date.now } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.now = now;
    this.wallNow = wallNow;
    this.keys = config.keys.map((secret, index) => ({ secret, label: `key-${index + 1}`, until: 0, disabled: false, reason: null, calls: 0, successes: 0, inflight: 0 }));
    this.cursor = 0;
    this.active = 0;
    this.globalUntil = 0;
  }

  redact(text) {
    for (const key of [...this.keys].sort((a, b) => b.secret.length - a.secret.length)) text = text.split(key.secret).join('[REDACTED]');
    return text;
  }

  status() {
    const now = this.now();
    return {
      strategy: this.config.strategy,
      scope: 'Current MCP process only; counters are requests, not balances or costs.',
      active: this.active,
      serviceRetryAfterSeconds: Math.max(0, Math.ceil((this.globalUntil - now) / 1000)),
      keys: this.keys.map(k => ({ label: k.label, state: k.disabled ? 'disabled' : k.until > now ? 'cooldown' : 'ready', reason: k.disabled || k.until > now ? k.reason : null, retryAfterSeconds: k.disabled ? null : Math.max(0, Math.ceil((k.until - now) / 1000)), calls: k.calls, successes: k.successes, inflight: k.inflight })),
    };
  }

  choose(tried) {
    const start = this.config.strategy === 'round-robin' ? this.cursor : 0;
    for (let n = 0; n < this.keys.length; n++) {
      const i = (start + n) % this.keys.length;
      const key = this.keys[i];
      if (!tried.has(i) && !key.disabled && key.until <= this.now() && key.inflight === 0) {
        this.cursor = (i + 1) % this.keys.length;
        return [key, i];
      }
    }
    return null;
  }

  async request(path, body, signal) {
    if (!['/search', '/contents'].includes(path)) throw new PoolError('INVALID_PATH', 'Unsupported Exa endpoint');
    if (signal?.aborted) throw new PoolError('CANCELLED', 'Request cancelled');
    if (this.globalUntil > this.now()) throw new PoolError('SERVICE_COOLDOWN', 'Exa service is cooling down; try later or use native search.');
    if (this.active >= this.config.maxConcurrent) throw new PoolError('BUSY', 'Local concurrency limit reached; retry after current requests complete.');
    this.active++;
    const deadline = AbortSignal.timeout(this.config.deadlineMs);
    const tried = new Set();
    let transientFailures = 0;
    try {
      while (tried.size < this.keys.length) {
        if (signal?.aborted) throw new PoolError('CANCELLED', 'Request cancelled');
        if (deadline.aborted) throw new PoolError('TIMEOUT', 'Overall request deadline exceeded');
        // Another in-flight call may have opened the service circuit while we awaited I/O.
        if (this.globalUntil > this.now()) throw new PoolError('SERVICE_COOLDOWN', 'Exa service is cooling down; no further attempts.');
        const selected = this.choose(tried);
        if (!selected) break;
        const [key, index] = selected;
        tried.add(index);
        key.inflight++; key.calls++;
        const combined = AbortSignal.any([deadline, AbortSignal.timeout(this.config.timeoutMs), ...(signal ? [signal] : [])]);
        try {
          const response = await this.fetch(`https://api.exa.ai${path}`, {
            method: 'POST', redirect: 'error',
            headers: { 'content-type': 'application/json', 'x-api-key': key.secret },
            body: JSON.stringify(body), signal: combined,
          });
          if (response.ok) {
            // Bound memory even when an upstream response ignores requested limits.
            if (!response.body) throw new PoolError('INVALID_RESPONSE', 'Exa returned an empty response body');
            const reader = response.body.getReader();
            const chunks = []; let size = 0;
            try {
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > 2_000_000) {
                  void reader.cancel().catch(() => {});
                  throw new PoolError('RESPONSE_TOO_LARGE', 'Exa response exceeds the 2 MB safety limit');
                }
                chunks.push(Buffer.from(value));
              }
            } finally { reader.releaseLock(); }
            let data;
            try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { throw new PoolError('INVALID_RESPONSE', 'Exa returned invalid JSON'); }
            if (!data || !Array.isArray(data.results)) throw new PoolError('INVALID_RESPONSE', 'Exa response has no results array');
            combined.throwIfAborted();
            key.successes++; key.reason = null;
            return data;
          }
          // Do not echo provider error bodies; they can contain credentials/queries.
          const retryAfter = response.headers.get('retry-after');
          // Cleanup must not mask status/Retry-After or hold up failover.
          try { void response.body?.cancel().catch(() => {}); } catch {}
          if ([401, 403].includes(response.status)) {
            key.disabled = true; key.reason = `http_${response.status}`; continue;
          }
          if (response.status === 402) {
            key.until = this.now() + retryDelay(retryAfter, this.wallNow(), this.config.paymentCooldownMs);
            key.reason = 'payment_required'; continue;
          }
          if (response.status === 429) {
            key.until = this.now() + retryDelay(retryAfter, this.wallNow(), this.config.rateCooldownMs);
            key.reason = 'rate_limited'; continue;
          }
          if (response.status >= 500) {
            // A service-wide failure is unlikely to be fixed by spending other keys.
            this.globalUntil = Math.max(this.globalUntil, this.now() + retryDelay(retryAfter, this.wallNow(), 15000));
            throw new PoolError('UPSTREAM_UNAVAILABLE', 'Exa service error; cooling down all keys. Try later or use native search.');
          }
          throw new PoolError('UPSTREAM_REJECTED', `Exa rejected the request (HTTP ${response.status}); no key rotation. Check arguments.`);
        } catch (error) {
          if (signal?.aborted) throw new PoolError('CANCELLED', 'Request cancelled');
          if (deadline.aborted) throw new PoolError('TIMEOUT', 'Overall request deadline exceeded');
          if (error instanceof PoolError) throw error;
          // Only known transport failures are retryable; bugs/TLS/redirect errors are not.
          if (!combined.aborted && !isTransportError(error)) {
            throw new PoolError('INTERNAL_ERROR', 'Non-retryable local or transport error; stopped without rotating keys.');
          }
          key.until = this.now() + 15000; key.reason = 'network_or_timeout';
          transientFailures++;
          if (transientFailures >= 2) {
            this.globalUntil = Math.max(this.globalUntil, this.now() + 15000);
            throw new PoolError('NETWORK_ERROR', 'Two transport attempts failed; stopping to avoid duplicate charges.');
          }
        } finally { key.inflight--; }
      }
      throw new PoolError('NO_AVAILABLE_KEY', 'No available Exa key: keys are busy, cooling down, exhausted, or disabled. Inspect exa_pool_status; use native search if needed.');
    } finally { this.active--; }
  }
}
