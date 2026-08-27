import assert from "node:assert/strict";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import test from "node:test";
import { toElectronCookie } from "../src/main/browser-import/cookie-record.ts";
import { decryptChromiumValue } from "../src/main/browser-import/chromium-crypto.ts";
import { parseBinaryCookies } from "../src/main/browser-import/safari-cookies.ts";
import { chromiumTimeToUnixSeconds } from "../src/main/browser-import/sqlite-snapshot.ts";

const KEY = pbkdf2Sync("peanuts", "saltysalt", 1003, 16, "sha1");

/** Produce a record exactly the way Chromium's OSCrypt writes one. */
function encrypt(value: string, hostKey?: string): Buffer {
  const cipher = createCipheriv("aes-128-cbc", KEY, Buffer.alloc(16, " "));
  const prefix = hostKey === undefined ? Buffer.alloc(0) : createHash("sha256").update(hostKey, "utf8").digest();
  const body = Buffer.concat([prefix, Buffer.from(value, "utf8")]);
  return Buffer.concat([Buffer.from("v10", "latin1"), cipher.update(body), cipher.final()]);
}

test("a Chromium cookie written by an older browser decrypts as-is", () => {
  assert.equal(decryptChromiumValue(encrypt("session-token"), ".example.com", KEY), "session-token");
});

test("the host binding a recent Chrome prepends is stripped", () => {
  assert.equal(decryptChromiumValue(encrypt("abc", ".example.com"), ".example.com", KEY), "abc");
});

test("a value that merely starts with 32 bytes is not mistaken for a host binding", () => {
  const value = "x".repeat(40);
  assert.equal(decryptChromiumValue(encrypt(value), ".example.com", KEY), value);
});

test("a record encrypted for another host stays unreadable rather than being truncated", () => {
  // The prefix belongs to a different host, so it is part of the value as far
  // as this cookie is concerned and must survive intact.
  const decrypted = decryptChromiumValue(encrypt("abc", ".other.com"), ".example.com", KEY);
  assert.equal(decrypted?.endsWith("abc"), true);
  assert.notEqual(decrypted, "abc");
});

test("an unknown version tag is reported instead of guessed at", () => {
  const record = Buffer.concat([Buffer.from("v20", "latin1"), Buffer.alloc(16)]);
  assert.equal(decryptChromiumValue(record, ".example.com", KEY), undefined);
});

test("Chromium's 1601 epoch becomes Unix seconds", () => {
  assert.equal(chromiumTimeToUnixSeconds(11_644_473_600_000_000), 0);
  assert.equal(chromiumTimeToUnixSeconds(13_000_000_000_000_000), 1_355_526_400);
  assert.equal(chromiumTimeToUnixSeconds(0), 0);
});

interface SafariCookieInput {
  host: string;
  name: string;
  path: string;
  value: string;
  flags: number;
  expiry: number;
}

function safariRecord(cookie: SafariCookieInput): Buffer {
  const header = Buffer.alloc(56);
  const strings = [cookie.host, cookie.name, cookie.path, cookie.value];
  const encoded = strings.map((text) => Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([0])]));
  let offset = header.length;
  const offsets: number[] = [];
  for (const part of encoded) {
    offsets.push(offset);
    offset += part.length;
  }
  header.writeUInt32LE(offset, 0);
  header.writeUInt32LE(cookie.flags, 8);
  header.writeUInt32LE(offsets[0], 16);
  header.writeUInt32LE(offsets[1], 20);
  header.writeUInt32LE(offsets[2], 24);
  header.writeUInt32LE(offsets[3], 28);
  header.writeDoubleLE(cookie.expiry, 40);
  header.writeDoubleLE(0, 48);
  return Buffer.concat([header, ...encoded]);
}

function safariFile(cookies: SafariCookieInput[]): Buffer {
  const records = cookies.map(safariRecord);
  const tableSize = 8 + records.length * 4 + 4;
  let cursor = tableSize;
  const page = Buffer.alloc(tableSize);
  page.writeUInt32BE(0x00000100, 0);
  page.writeUInt32LE(records.length, 4);
  records.forEach((record, index) => {
    page.writeUInt32LE(cursor, 8 + index * 4);
    cursor += record.length;
  });
  const body = Buffer.concat([page, ...records]);
  const header = Buffer.alloc(8 + 4);
  header.write("cook", 0, "latin1");
  header.writeUInt32BE(1, 4);
  header.writeUInt32BE(body.length, 8);
  return Buffer.concat([header, body]);
}

test("Safari's binary jar yields cookies with their flags and expiry", () => {
  const file = safariFile([
    { host: ".example.com", name: "sid", path: "/", value: "42", flags: 5, expiry: 700_000_000 },
    { host: "plain.test", name: "a", path: "/x", value: "b", flags: 0, expiry: 0 },
  ]);
  const { cookies, unreadable } = parseBinaryCookies(file);
  assert.equal(unreadable, 0);
  assert.deepEqual(cookies[0], {
    host: ".example.com",
    name: "sid",
    value: "42",
    path: "/",
    secure: true,
    httpOnly: true,
    expiresAt: 700_000_000 + 978_307_200,
    sameSite: "unspecified",
  });
  assert.equal(cookies[1].secure, false);
  assert.equal(cookies[1].httpOnly, false);
  // A zero expiry is Safari's session cookie, not a cookie that expired in 2001.
  assert.equal(cookies[1].expiresAt, undefined);
});

test("a file that is not a cookie jar is refused", () => {
  assert.throws(() => parseBinaryCookies(Buffer.from("not a jar at all")), /无法识别/);
});

test("a domain cookie keeps its leading dot in the domain but not in the URL", () => {
  const mapped = toElectronCookie({
    host: ".example.com",
    name: "sid",
    value: "1",
    path: "sub",
    secure: true,
    httpOnly: true,
    expiresAt: 123,
    sameSite: "lax",
  });
  assert.equal(mapped.url, "https://example.com/sub");
  assert.equal(mapped.domain, ".example.com");
  assert.equal(mapped.path, "/sub");
});

test("an insecure cookie cannot claim SameSite=None, which Electron would reject", () => {
  const mapped = toElectronCookie({
    host: "example.com",
    name: "a",
    value: "b",
    path: "/",
    secure: false,
    httpOnly: false,
    sameSite: "no_restriction",
  });
  assert.equal(mapped.url, "http://example.com/");
  assert.equal(mapped.sameSite, "unspecified");
  assert.equal(mapped.expirationDate, undefined);
});
