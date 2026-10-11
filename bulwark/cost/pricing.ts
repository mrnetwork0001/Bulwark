// What an LLM call costs. 0G Compute Router prices come live from its public
// /v1/models endpoint (USD per token, cached on disk for a day); Anthropic-direct
// IDs use a small static table. Unknown models are priced at $0 and flagged, so
// a report never silently invents a number.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Price {
  /** USD per input token. */
  prompt: number;
  /** USD per output token. */
  completion: number;
  /** USD per cache-write token (defaults to 1.25× prompt). */
  cacheWrite?: number;
  /** USD per cache-read token (defaults to 0.1× prompt). */
  cacheRead?: number;
  source: '0g-live' | '0g-cache' | 'static' | 'unknown';
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

// Anthropic first-party list prices (USD per million tokens), Oct 2026.
const ANTHROPIC_PER_MTOK: Record<string, [number, number]> = {
  'claude-fable-5-1': [10, 50],
  'claude-fable-5': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-haiku-4-5': [1, 5],
};

export const STATIC_PRICES: Record<string, Price> = Object.fromEntries(
  Object.entries(ANTHROPIC_PER_MTOK).map(([id, [i, o]]) => [id, { prompt: i / 1e6, completion: o / 1e6, source: 'static' as const }]),
);

/** Dollar cost of one call's token usage at a given price. */
export function costOf(u: TokenUsage, p: Price): number {
  return (
    u.inputTokens * p.prompt +
    u.outputTokens * p.completion +
    (u.cacheWriteTokens ?? 0) * (p.cacheWrite ?? p.prompt * 1.25) +
    (u.cacheReadTokens ?? 0) * (p.cacheRead ?? p.prompt * 0.1)
  );
}

/** Parses the 0G /v1/models payload into a price table. Models without token pricing are skipped. */
export function parseZgModels(payload: unknown): Record<string, Price> {
  const list = (payload as { data?: unknown[] })?.data ?? (Array.isArray(payload) ? payload : []);
  const out: Record<string, Price> = {};
  for (const m of list as { id?: string; pricing_usd?: Record<string, string> }[]) {
    const p = m?.pricing_usd;
    if (!m?.id || !p || p.prompt === undefined || p.completion === undefined) continue;
    out[m.id] = {
      prompt: Number(p.prompt),
      completion: Number(p.completion),
      ...(p.cache_write ? { cacheWrite: Number(p.cache_write) } : {}),
      ...(p.cache_read ? { cacheRead: Number(p.cache_read) } : {}),
      source: '0g-live',
    };
  }
  return out;
}

export interface PriceBook {
  priceFor(model: string): Price;
  /** Where the 0G table came from, for reports. */
  zgSource: 'live' | 'cache' | 'unavailable';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Builds a price book: 0G live prices (fetched once, cached at `cachePath` for a
 * day, stale cache used if the network fails) plus the static Anthropic table.
 */
export async function loadPriceBook(opts: { provider?: 'anthropic' | '0g'; cachePath?: string; fetchImpl?: typeof fetch } = {}): Promise<PriceBook> {
  const cachePath = opts.cachePath ?? '.bulwark/pricing-0g.json';
  let zg: Record<string, Price> = {};
  let zgSource: PriceBook['zgSource'] = 'unavailable';

  let cached: { fetchedAt: number; prices: Record<string, Price> } | undefined;
  try {
    if (existsSync(cachePath)) cached = JSON.parse(readFileSync(cachePath, 'utf8'));
  } catch {
    cached = undefined;
  }
  if (cached && Date.now() - cached.fetchedAt < DAY_MS) {
    zg = cached.prices;
    zgSource = 'cache';
  } else {
    try {
      const base = process.env.ZG_ROUTER_BASE_URL || 'https://router-api.0g.ai';
      const res = await (opts.fetchImpl ?? fetch)(`${base}/v1/models`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      zg = parseZgModels(await res.json());
      zgSource = 'live';
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now(), prices: zg }, null, 2));
    } catch {
      if (cached) {
        zg = cached.prices;
        zgSource = 'cache';
      }
    }
  }
  const tag = (p: Price): Price => ({ ...p, source: zgSource === 'live' ? '0g-live' : '0g-cache' });

  return {
    zgSource,
    priceFor(model: string): Price {
      // On 0G the router's own price wins; Anthropic direct uses the static table.
      // 0G spells versions with dots ("claude-opus-4.6"), Anthropic with dashes.
      const dotted = model.replace(/-(\d+)-(\d+)$/, '-$1.$2');
      const zgHit = zg[model] ?? zg[dotted];
      if (opts.provider !== 'anthropic' && zgHit) return tag(zgHit);
      return STATIC_PRICES[model] ?? (zgHit ? tag(zgHit) : { prompt: 0, completion: 0, source: 'unknown' });
    },
  };
}
