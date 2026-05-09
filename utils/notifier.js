/**
 * Discord webhook notifier. One method, four levels.
 *
 * Discord embeds use a 24-bit integer for `color`. We map levels to colors
 * matching the standard Discord/log convention:
 *   info     → blue
 *   success  → green
 *   warn     → yellow
 *   error    → red
 *
 * Behavior contract:
 *   - Never throws. A failing webhook must NEVER break the monitor loop.
 *   - If the webhook URL is null/empty, log + return — useful for dev mode.
 *   - Always logs the same payload via the local logger so we never lose an
 *     event if Discord is down.
 *
 * The `httpClient` injection is for tests: production passes axios; tests
 * pass a `vi.fn()`.
 */

import axios from 'axios';
import logger from './logger.js';

const COLOR = {
  info:    0x3498DB, // blue
  success: 0x2ECC71, // green
  warn:    0xF1C40F, // yellow
  error:   0xE74C3C, // red
};

export class Notifier {
  /**
   * @param {{ webhookUrl?: string|null, httpClient?: { post: Function } }} cfg
   */
  constructor(cfg = {}) {
    this.webhookUrl = cfg.webhookUrl ?? null;
    this.http = cfg.httpClient ?? axios;
  }

  /**
   * @param {{
   *   level: 'info'|'success'|'warn'|'error',
   *   title: string,
   *   description?: string,
   *   fields?: Array<{ name: string, value: string, inline?: boolean }>,
   * }} msg
   */
  async send({ level, title, description, fields }) {
    const color = COLOR[level] ?? COLOR.info;
    const payload = {
      embeds: [
        {
          title,
          description,
          color,
          fields: fields ?? [],
          timestamp: new Date().toISOString(),
        },
      ],
    };

    const logLevel = level === 'success' || !(level in COLOR) ? 'info' : level;
    logger.log(logLevel, `notifier.${level}`, { title, fields });

    if (!this.webhookUrl) return;

    try {
      await this.http.post(this.webhookUrl, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 5_000,
      });
    } catch (err) {
      // Logged but swallowed — webhook outages must not stop the bot.
      logger.warn('notifier.send failed', { error: err?.message ?? String(err) });
    }
  }
}
