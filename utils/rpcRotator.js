/**
 * Rotating HTTP transport for viem. Wraps a list of RPC URLs and fails over
 * on transient errors (HTTP 429, 5xx, fetch/timeout) by retrying the same
 * request against the next URL.
 *
 * Used for `eth_getLogs` against free public Base RPCs — any one of them
 * may rate-limit at any moment, but at least one usually responds. Last-good
 * URL is sticky across calls so we don't pay the failover cost twice in a
 * row.
 *
 * Surfaces a single error containing every attempt when all URLs fail.
 */

import { http } from 'viem';
import logger from './logger.js';

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * @param {string[]} urls
 * @param {{ httpOpts?: object, backoffMs?: number }} [opts]
 * @returns {import('viem').Transport}
 */
export function createRotatingHttpTransport(urls, opts = {}) {
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error('createRotatingHttpTransport: at least one URL required');
  }
  const backoffMs = opts.backoffMs ?? 250;
  const transports = urls.map((url) => http(url, opts.httpOpts));
  let stickyIdx = 0;

  return (cfgArgs) => {
    const inits = transports.map((t) => t(cfgArgs));

    return {
      ...inits[0],
      async request(args) {
        const attempts = [];
        for (let i = 0; i < inits.length; i++) {
          const idx = (stickyIdx + i) % inits.length;
          try {
            const result = await inits[idx].request(args);
            stickyIdx = idx;
            return result;
          } catch (err) {
            attempts.push({ url: urls[idx], error: err?.message ?? String(err) });
            if (!isRetryable(err) || i === inits.length - 1) {
              if (i === inits.length - 1) {
                const e = new Error(
                  `rpcRotator exhausted ${urls.length} URLs: ${attempts.map((a) => `${a.url} → ${a.error}`).join(' | ')}`,
                );
                e.cause = err;
                e.attempts = attempts;
                throw e;
              }
              throw err;
            }
            logger.warn('rpcRotator failover', { failed: urls[idx], next: urls[(idx + 1) % urls.length], error: err?.message });
            if (backoffMs > 0) await sleep(backoffMs);
          }
        }
        // unreachable — loop either returns or throws
        throw new Error('rpcRotator: unreachable');
      },
    };
  };
}

function isRetryable(err) {
  if (!err) return false;
  const status = err.status ?? err.statusCode ?? err?.cause?.status;
  if (typeof status === 'number' && RETRYABLE_STATUSES.has(status)) return true;
  const msg = err.message ?? String(err);
  return /429|rate ?limit|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up|EAI_AGAIN|HTTP request failed/i.test(msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
