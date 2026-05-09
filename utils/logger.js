// Winston logger: JSON-formatted logs with timestamps, written to both the
// console and logs/bot.log. Level controlled by LOG_LEVEL env var (default
// "info"). Default ESM export.

import { createLogger, format, transports } from 'winston';

const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.splat(),
    format.json(),
  ),
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf(({ timestamp, level, message, ...meta }) => {
          const rest = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} ${level} ${message}${rest}`;
        }),
      ),
    }),
    new transports.File({ filename: 'logs/bot.log' }),
  ],
});

export default logger;
