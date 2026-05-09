import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PnlLedger, PNL_STATUS } from '../../core/PnlLedger.js';

let tmpDir;
let ledgerPath;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pnl-'));
  ledgerPath = path.join(tmpDir, 'pnl.jsonl');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('PnlLedger', () => {
  it('appends each record as JSONL with a default ts', async () => {
    const ledger = new PnlLedger({ path: ledgerPath });
    const before = Date.now() - 1;
    const rec = await ledger.append({
      borrower: '0xabc', estProfitUsd: 5, estGasUsd: 0.3, estNetUsd: 4.7,
      status: PNL_STATUS.SUCCESS, txHash: '0x1', actualGasUsd: 0.27, actualNetUsd: 4.73,
    });
    const after = Date.now() + 1;
    expect(Date.parse(rec.ts)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(rec.ts)).toBeLessThanOrEqual(after);

    const raw = await fs.readFile(ledgerPath, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.borrower).toBe('0xabc');
    expect(parsed.status).toBe('success');
  });

  it('summarise: counts by status and sums est/actual nets', async () => {
    const ledger = new PnlLedger({ path: ledgerPath });
    await ledger.append({ borrower: '0x1', estNetUsd: 5,  status: PNL_STATUS.SUCCESS, actualNetUsd: 4.5,  actualGasUsd: 0.5 });
    await ledger.append({ borrower: '0x2', estNetUsd: 3,  status: PNL_STATUS.SUCCESS, actualNetUsd: 2.8,  actualGasUsd: 0.4 });
    await ledger.append({ borrower: '0x3', estNetUsd: 2,  status: PNL_STATUS.REVERTED, actualNetUsd: -0.3, actualGasUsd: 0.3 });
    await ledger.append({ borrower: '0x4', estNetUsd: 1,  status: PNL_STATUS.SKIPPED_STALE });

    const s = await ledger.summarise(0);
    expect(s.total).toBe(4);
    expect(s.byStatus.success).toBe(2);
    expect(s.byStatus.reverted).toBe(1);
    expect(s.byStatus['skipped-stale']).toBe(1);
    expect(s.estNetUsd).toBeCloseTo(11);
    expect(s.actualNetUsd).toBeCloseTo(7);
    expect(s.actualGasUsd).toBeCloseTo(1.2);
  });

  it('summarise: filters by sinceMs', async () => {
    const ledger = new PnlLedger({ path: ledgerPath });
    const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const recent = new Date().toISOString();
    await ledger.append({ ts: old, borrower: '0x1', estNetUsd: 99, status: PNL_STATUS.SUCCESS });
    await ledger.append({ ts: recent, borrower: '0x2', estNetUsd: 1, status: PNL_STATUS.SUCCESS });

    const s = await ledger.summarise(Date.now() - 24 * 3600 * 1000);
    expect(s.total).toBe(1);
    expect(s.estNetUsd).toBeCloseTo(1);
  });

  it('summarise: returns empty summary when ledger file missing', async () => {
    const ledger = new PnlLedger({ path: ledgerPath });
    const s = await ledger.summarise();
    expect(s.total).toBe(0);
    expect(s.byStatus).toEqual({});
  });
});
