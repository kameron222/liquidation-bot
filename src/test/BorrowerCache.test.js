import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BorrowerCache } from '../../core/BorrowerCache.js';

let dir;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'borrower-cache-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('BorrowerCache', () => {
  it('returns empty when the file does not exist', async () => {
    const cache = new BorrowerCache({ path: path.join(dir, 'missing.json') });
    const { borrowers, lastScannedBlock } = await cache.load();
    expect(borrowers.size).toBe(0);
    expect(lastScannedBlock).toBe(0n);
  });

  it('round-trips borrowers and lastScannedBlock through the disk', async () => {
    const cache = new BorrowerCache({ path: path.join(dir, 'state.json') });
    await cache.save({
      borrowers: new Set(['0xAAA', '0xBBB']),
      lastScannedBlock: 12_345_678n,
    });
    const loaded = await cache.load();
    expect([...loaded.borrowers].sort()).toEqual(['0xAAA', '0xBBB']);
    expect(loaded.lastScannedBlock).toBe(12_345_678n);
  });

  it('writes are atomic — no .tmp file remains after save', async () => {
    const target = path.join(dir, 'state.json');
    const cache = new BorrowerCache({ path: target });
    await cache.save({ borrowers: new Set(['0x1']), lastScannedBlock: 1n });
    const entries = await fs.readdir(dir);
    expect(entries).toContain('state.json');
    expect(entries.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('treats a corrupt JSON file as "no cache" and returns empty', async () => {
    const target = path.join(dir, 'state.json');
    await fs.writeFile(target, '{not valid json');
    const cache = new BorrowerCache({ path: target });
    const { borrowers, lastScannedBlock } = await cache.load();
    expect(borrowers.size).toBe(0);
    expect(lastScannedBlock).toBe(0n);
  });

  it('creates the parent directory if it does not exist', async () => {
    const target = path.join(dir, 'nested', 'deep', 'state.json');
    const cache = new BorrowerCache({ path: target });
    await cache.save({ borrowers: new Set(['0xA']), lastScannedBlock: 5n });
    const stat = await fs.stat(target);
    expect(stat.isFile()).toBe(true);
  });
});
