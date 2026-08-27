import { readFileSync } from "node:fs";
import type { CookieHarvest, ImportedCookie } from "./cookie-record";

/**
 * Reader for Safari's `Cookies.binarycookies`.
 *
 * Safari stores its jar in an undocumented but long-stable binary format: a
 * "cook" magic, a table of page sizes, then pages of fixed-layout records with
 * NUL-terminated strings addressed by offsets relative to the record. Nothing
 * is encrypted — the protection is the sandbox container the file lives in, so
 * the only way this fails on a healthy machine is macOS denying the read until
 * the user grants CoilCoil full disk access.
 */
export class SafariAccessDeniedError extends Error {
  constructor() {
    super("macOS 不允许读取 Safari 的 Cookie 文件，请在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」中勾选 CoilCoil 后重试。");
    this.name = "SafariAccessDeniedError";
  }
}

/** Seconds between the Unix epoch and Apple's 2001-01-01 reference date. */
const APPLE_EPOCH_OFFSET = 978_307_200;

const FLAG_SECURE = 1;
const FLAG_HTTP_ONLY = 4;

function readCString(buffer: Buffer, start: number): string {
  if (start <= 0 || start >= buffer.length) return "";
  const end = buffer.indexOf(0, start);
  return buffer.toString("utf8", start, end === -1 ? buffer.length : end);
}

export function parseBinaryCookies(buffer: Buffer): CookieHarvest {
  const cookies: ImportedCookie[] = [];
  let unreadable = 0;
  if (buffer.length < 8 || buffer.toString("latin1", 0, 4) !== "cook") {
    throw new Error("Safari 的 Cookie 文件格式无法识别。");
  }
  const pageCount = buffer.readUInt32BE(4);
  const pageSizes: number[] = [];
  for (let index = 0; index < pageCount; index += 1) pageSizes.push(buffer.readUInt32BE(8 + index * 4));

  let pageStart = 8 + pageCount * 4;
  for (const pageSize of pageSizes) {
    const page = buffer.subarray(pageStart, pageStart + pageSize);
    pageStart += pageSize;
    if (page.length < 12) continue;
    const cookieCount = page.readUInt32LE(4);
    for (let index = 0; index < cookieCount; index += 1) {
      const offsetPosition = 8 + index * 4;
      if (offsetPosition + 4 > page.length) break;
      const cookieStart = page.readUInt32LE(offsetPosition);
      try {
        const record = page.subarray(cookieStart, cookieStart + page.readUInt32LE(cookieStart));
        const flags = record.readUInt32LE(8);
        const host = readCString(record, record.readUInt32LE(16));
        const name = readCString(record, record.readUInt32LE(20));
        const path = readCString(record, record.readUInt32LE(24));
        const value = readCString(record, record.readUInt32LE(28));
        if (!host || !name) {
          unreadable += 1;
          continue;
        }
        const expiry = record.readDoubleLE(40);
        const expiresAt = expiry > 0 ? Math.round(expiry + APPLE_EPOCH_OFFSET) : 0;
        cookies.push({
          host,
          name,
          value,
          path: path || "/",
          secure: (flags & FLAG_SECURE) !== 0,
          httpOnly: (flags & FLAG_HTTP_ONLY) !== 0,
          expiresAt: expiresAt > 0 ? expiresAt : undefined,
          // Safari's format predates SameSite and carries no field for it.
          sameSite: "unspecified",
        });
      } catch {
        unreadable += 1;
      }
    }
  }
  return { cookies, unreadable };
}

export function readSafariCookies(path: string): CookieHarvest {
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") throw new SafariAccessDeniedError();
    throw error;
  }
  return parseBinaryCookies(buffer);
}
