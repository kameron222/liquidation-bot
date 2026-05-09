import { describe, it, expect, vi } from 'vitest';
import { Notifier } from '../../utils/notifier.js';

const URL = 'https://discord.test/webhook/abc';

function buildHttp() {
  return { post: vi.fn().mockResolvedValue({ status: 204 }) };
}

describe('Notifier', () => {
  it('posts a Discord embed with the level color and provided fields', async () => {
    const http = buildHttp();
    const notifier = new Notifier({ webhookUrl: URL, httpClient: http });

    await notifier.send({
      level: 'success',
      title: 'Liquidated $42.00',
      fields: [
        { name: 'tx', value: '0xabc', inline: true },
        { name: 'profit', value: '$42', inline: true },
      ],
    });

    expect(http.post).toHaveBeenCalledTimes(1);
    const [url, payload] = http.post.mock.calls[0];
    expect(url).toBe(URL);
    expect(payload.embeds).toHaveLength(1);
    const embed = payload.embeds[0];
    expect(embed.title).toBe('Liquidated $42.00');
    expect(embed.color).toBe(0x2ECC71);
    expect(embed.fields).toHaveLength(2);
    expect(typeof embed.timestamp).toBe('string');
  });

  it('no-ops gracefully when webhookUrl is null', async () => {
    const http = buildHttp();
    const notifier = new Notifier({ webhookUrl: null, httpClient: http });
    await notifier.send({ level: 'info', title: 'silent' });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('swallows http errors so the monitor loop is never broken', async () => {
    const http = { post: vi.fn().mockRejectedValue(new Error('500 internal')) };
    const notifier = new Notifier({ webhookUrl: URL, httpClient: http });
    await expect(notifier.send({ level: 'error', title: 'boom' })).resolves.toBeUndefined();
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('falls back to info color for unknown levels', async () => {
    const http = buildHttp();
    const notifier = new Notifier({ webhookUrl: URL, httpClient: http });
    await notifier.send({ level: 'mystery', title: 'huh' });
    expect(http.post.mock.calls[0][1].embeds[0].color).toBe(0x3498DB);
  });
});
