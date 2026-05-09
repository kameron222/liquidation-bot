/**
 * Etherscan V2 logs API client (replaces deprecated Basescan V1). Used as an
 * alternative to Alchemy's `eth_getLogs` for borrower discovery, because
 * Alchemy's free tier caps the block range at 10 blocks per call —
 * unworkable for full-history scans of 25M+ blocks.
 *
 * Etherscan V2 unified all chain APIs behind a single endpoint with a
 * `chainid` query param. Base mainnet is chainid 8453. The Basescan API key
 * works against this endpoint unchanged.
 *
 * REST endpoint accepts arbitrary block ranges and paginates at 1000
 * records per page. Free tier: 5 req/s, 100k req/day.
 *
 * Reference:
 *   https://docs.etherscan.io/v2-migration
 *   https://docs.etherscan.io/api-endpoints/logs
 *
 * Returned records look like (numeric fields are 0x-prefixed hex strings):
 *   { address, topics: [t0, t1, ...], data, blockNumber, timeStamp,
 *     transactionHash, transactionIndex, logIndex, ... }
 */

import axios from 'axios';

const ENDPOINT = 'https://api.etherscan.io/v2/api';
const BASE_CHAIN_ID = 8453;
const PAGE_SIZE = 1000;
const PACE_MS = 250;

/**
 * Fetch all logs matching `address` + `topic0` between `fromBlock` and
 * `toBlock` (inclusive), transparently paginating until no more records.
 *
 * @param {{
 *   apiKey: string,
 *   address: `0x${string}`,
 *   topic0: `0x${string}`,
 *   fromBlock: bigint|number,
 *   toBlock:   bigint|number,
 *   httpClient?: { get: Function },
 *   sleep?: (ms: number) => Promise<void>,
 * }} cfg
 * @returns {Promise<Array<{address: string, topics: string[], data: string, blockNumber: string, transactionHash: string}>>}
 */
export async function fetchBasescanLogs(cfg) {
  if (!cfg?.apiKey)  throw new Error('fetchBasescanLogs: apiKey required');
  if (!cfg?.address) throw new Error('fetchBasescanLogs: address required');
  if (!cfg?.topic0)  throw new Error('fetchBasescanLogs: topic0 required');

  const http  = cfg.httpClient ?? axios;
  const sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  const results = [];
  let page = 1;
  while (true) {
    const { data } = await http.get(ENDPOINT, {
      params: {
        chainid:   cfg.chainId ?? BASE_CHAIN_ID,
        module:    'logs',
        action:    'getLogs',
        address:   cfg.address,
        topic0:    cfg.topic0,
        fromBlock: String(cfg.fromBlock),
        toBlock:   String(cfg.toBlock),
        page,
        offset:    PAGE_SIZE,
        apikey:    cfg.apiKey,
      },
      timeout: 15_000,
    });

    // status:'1' with array result → success.
    // status:'0' message:'No records found' → empty page (legitimate end).
    // anything else → error.
    if (data.status !== '1') {
      if (data.message === 'No records found') break;
      throw new Error(`Etherscan getLogs failed: ${data.message ?? 'unknown'} ${typeof data.result === 'string' ? data.result : ''}`);
    }
    const records = Array.isArray(data.result) ? data.result : [];
    results.push(...records);
    if (records.length < PAGE_SIZE) break;
    page++;
    await sleep(PACE_MS);
  }
  return results;
}
