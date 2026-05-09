/**
 * Central env-var loader. Every other module imports `config` from here —
 * no other file should reach into `process.env` directly. This makes the env
 * surface auditable and gives us one place to validate required variables.
 *
 * Required vars throw at import time so misconfiguration never silently
 * degrades into "the bot was running but doing nothing".
 *
 * Numeric env vars are parsed once and stored as `Number` (gas caps, USD
 * thresholds — these are user-tuned values, not on-chain quantities, so
 * Number is the right type at the boundary).
 *
 * `liquidatorAddress` is optional in this module — the monitor enforces it
 * at startup so unit tests of subordinate modules don't need to set it.
 */

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optional(name, fallback = null) {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Env var ${name} must be a number, got "${raw}"`);
  }
  return parsed;
}

export const config = {
  alchemyHttp:        required('ALCHEMY_HTTP_URL'),
  alchemyWs:          optional('ALCHEMY_WS_URL'),
  privateKey:         required('PRIVATE_KEY'),
  liquidatorAddress:  optional('LIQUIDATOR_ADDRESS'),
  discordWebhook:     optional('DISCORD_WEBHOOK_URL'),
  minProfitUsd:       num('MIN_PROFIT_USD', 0.5),
  maxGasGwei:         num('MAX_GAS_PRICE_GWEI', 50),
  priorityFeeGwei:    num('PRIORITY_FEE_GWEI', 1),
  pollIntervalMs:     num('POLL_INTERVAL_MS', 12_000),
  evaluateConcurrency: num('MONITOR_CONCURRENCY', 4),
  dryRun:             (process.env.DRY_RUN ?? '').toLowerCase() === 'true' || process.env.DRY_RUN === '1',
  logLevel:           optional('LOG_LEVEL', 'info'),
};
