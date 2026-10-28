import { readFileSync, statSync } from 'node:fs';

function integer(env, name, fallback, min, max) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  let keys;
  if (env.EXA_KEYS_FILE) {
    try {
      const stat = statSync(env.EXA_KEYS_FILE);
      if (!stat.isFile() || stat.size > 65536) throw new Error();
      if (process.platform !== 'win32' && (stat.mode & 0o077)) {
        throw new Error('permissions');
      }
      keys = JSON.parse(readFileSync(env.EXA_KEYS_FILE, 'utf8'));
    } catch {
      throw new Error('EXA_KEYS_FILE must be a readable JSON array in a private file (chmod 600 on macOS/Linux)');
    }
  } else {
    try {
      keys = env.EXA_API_KEYS ? JSON.parse(env.EXA_API_KEYS) : [env.EXA_API_KEY];
    } catch {
      throw new Error('EXA_API_KEYS must be a JSON array of key strings');
    }
  }
  if (!Array.isArray(keys) || !keys.length || keys.length > 20 ||
      keys.some(k => typeof k !== 'string' || !k.trim() || /[\r\n]/.test(k))) {
    throw new Error('Configure 1–20 non-empty API keys through EXA_KEYS_FILE or EXA_API_KEYS');
  }
  keys = [...new Set(keys.map(k => k.trim()))];
  const strategy = env.EXA_KEY_STRATEGY ?? 'priority';
  if (!['priority', 'round-robin'].includes(strategy)) throw new Error('Invalid EXA_KEY_STRATEGY');
  return {
    keys, strategy,
    timeoutMs: integer(env, 'EXA_TIMEOUT_MS', 12000, 100, 60000),
    deadlineMs: integer(env, 'EXA_DEADLINE_MS', 35000, 100, 120000),
    rateCooldownMs: integer(env, 'EXA_RATE_COOLDOWN_MS', 60000, 1000, 3600000),
    paymentCooldownMs: integer(env, 'EXA_PAYMENT_COOLDOWN_MS', 3600000, 1000, 86400000),
    maxConcurrent: integer(env, 'EXA_MAX_CONCURRENT', 3, 1, 20),
  };
}
