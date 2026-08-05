import winston from 'winston';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// Logs belong to the server, not to whichever project it is serving, so they go
// next to the package (or LOG_DIR) instead of into the current cwd. When the
// package lives somewhere unwritable — an npx cache, a global install — fall
// back to the temp directory rather than refusing to start.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function usableLogDir(): string | undefined {
  const candidates = [
    process.env.LOG_DIR && path.resolve(process.env.LOG_DIR),
    path.join(packageRoot, 'logs'),
    path.join(os.tmpdir(), 'deepseek-subagents-logs'),
  ].filter((dir): dir is string => Boolean(dir));

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

const logDir = usableLogDir();

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'deepseek-subagents' },
  transports: [
    // File transports only when a writable directory was found; stderr always works.
    ...(logDir
      ? [
          new winston.transports.File({
            filename: path.join(logDir, 'combined.log'),
            maxsize: 5242880, // 5MB
            maxFiles: 5,
          }),
          new winston.transports.File({
            filename: path.join(logDir, 'error.log'),
            level: 'error',
            maxsize: 5242880,
            maxFiles: 5,
          }),
        ]
      : []),
    // Console output directed strictly to STDERR so stdout remains clean for MCP RPC
    new winston.transports.Console({
      stderrLevels: ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'],
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, service, ...metadata }) => {
          let metaStr = '';
          if (Object.keys(metadata).length > 0 && metadata.service === undefined) {
            metaStr = ` ${JSON.stringify(metadata)}`;
          }
          return `[${timestamp}] [${level}]: ${message}${metaStr}`;
        })
      ),
    }),
  ],
});
