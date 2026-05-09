import { describe, it, expect, vi } from 'vitest';
import { createRotatingHttpTransport } from '../../utils/rpcRotator.js';

// Build a transport whose request() can be scripted: each call shifts off the
// next outcome from `responses`. An outcome can be { ok: value } or
// { err: Error|{message,status} }.
function fakeTransport(responses) {
  const calls = [];
  return {
    transport: () => () => ({
      async request(args) {
        calls.push(args);
        const next = responses.shift();
        if (!next) throw new Error('no more responses scripted');
        if ('ok' in next) return next.ok;
        const e = new Error(next.err.message ?? 'fake');
        if (next.err.status) e.status = next.err.status;
        throw e;
      },
    }),
    calls,
  };
}

// Replace the imported `http` symbol indirectly: we install our fake into
// the transports list by passing options via opts.httpOpts is not enough —
// instead, monkey-patch the rotator by passing fake URLs and stubbing the
// actual http() with vi.mock at the top of file would be heavier than we
// need. Easier: spy via module replacement.

vi.mock('viem', async () => {
  const actual = await vi.importActual('viem');
  return {
    ...actual,
    // `http` here is what rpcRotator imports. We re-export a factory that
    // routes each URL to a per-URL stub stored on a global registry that
    // tests populate.
    http: (url) => () => ({
      async request(args) {
        const stub = globalThis.__rpcStub.get(url);
        if (!stub) throw new Error(`no stub for ${url}`);
        return stub(args);
      },
    }),
  };
});

function setStub(url, fn) {
  if (!globalThis.__rpcStub) globalThis.__rpcStub = new Map();
  globalThis.__rpcStub.set(url, fn);
}

describe('rpcRotator', () => {
  it('uses the first URL on the happy path', async () => {
    const a = vi.fn().mockResolvedValue('hello');
    const b = vi.fn();
    setStub('https://a', a); setStub('https://b', b);

    const transport = createRotatingHttpTransport(['https://a', 'https://b'], { backoffMs: 0 });
    const inst = transport({});
    const result = await inst.request({ method: 'eth_blockNumber' });

    expect(result).toBe('hello');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it('fails over to the next URL on 429', async () => {
    const e = new Error('429 rate limited'); e.status = 429;
    const a = vi.fn().mockRejectedValue(e);
    const b = vi.fn().mockResolvedValue('from-b');
    setStub('https://a', a); setStub('https://b', b);

    const transport = createRotatingHttpTransport(['https://a', 'https://b'], { backoffMs: 0 });
    const inst = transport({});
    const result = await inst.request({ method: 'eth_blockNumber' });

    expect(result).toBe('from-b');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('throws an aggregated error when every URL fails', async () => {
    const ea = new Error('502 bad gateway'); ea.status = 502;
    const eb = new Error('503 unavailable'); eb.status = 503;
    setStub('https://a', vi.fn().mockRejectedValue(ea));
    setStub('https://b', vi.fn().mockRejectedValue(eb));

    const transport = createRotatingHttpTransport(['https://a', 'https://b'], { backoffMs: 0 });
    const inst = transport({});
    await expect(inst.request({ method: 'x' })).rejects.toThrow(/exhausted 2 URLs/);
  });

  it('does not fail over on a non-retryable error', async () => {
    const e = new Error('reverted: bad calldata'); e.status = 400;
    const a = vi.fn().mockRejectedValue(e);
    const b = vi.fn();
    setStub('https://a', a); setStub('https://b', b);

    const transport = createRotatingHttpTransport(['https://a', 'https://b'], { backoffMs: 0 });
    const inst = transport({});
    await expect(inst.request({ method: 'x' })).rejects.toThrow(/bad calldata/);
    expect(b).not.toHaveBeenCalled();
  });

  it('throws when constructed with an empty URL list', () => {
    expect(() => createRotatingHttpTransport([])).toThrow(/at least one URL/);
  });
});
