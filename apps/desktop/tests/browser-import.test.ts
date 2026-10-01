import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import test from "node:test";
import { cookiesFromDatabase } from "../src/main/browser-import/chromium-cookies.ts";
import { toElectronCookie } from "../src/main/browser-import/cookie-record.ts";
import { decryptChromiumValue } from "../src/main/browser-import/chromium-crypto.ts";
import { parseBinaryCookies } from "../src/main/browser-import/safari-cookies.ts";
import {
  browserDescriptor, browserUserDataRoot, CHROMIUM_BROWSERS, chromiumBrowsersForPlatform,
  isPermissionDenied, listChromiumProfiles, profileDirectory,
} from "../src/main/browser-import/browser-catalog.ts";
import { chromiumTimeToUnixSeconds } from "../src/main/browser-import/sqlite-snapshot.ts";
import { clearWindowsChromiumKeys, decryptWindowsChromiumValue } from "../src/main/browser-import/windows-chromium-crypto.ts";

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

const WINDOWS_LEGACY = Buffer.alloc(32, 0x1a);
const WINDOWS_APP_BOUND = Buffer.alloc(32, 0x8b);

function encryptWindows(value: string, version: "v10" | "v20", host?: string): Buffer {
  const key = version === "v20" ? WINDOWS_APP_BOUND : WINDOWS_LEGACY;
  const nonce = Buffer.alloc(12, 0x4a);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = host ? Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value)]) : Buffer.from(value);
  return Buffer.concat([Buffer.from(version), nonce, cipher.update(body), cipher.final(), cipher.getAuthTag()]);
}

test("Windows 同一配置里的 v10 与 v20 用不同密钥解密，不能混用", () => {
  const keys = { kind: "windows" as const, legacy: Buffer.from(WINDOWS_LEGACY), appBound: Buffer.from(WINDOWS_APP_BOUND) };
  assert.equal(decryptWindowsChromiumValue(encryptWindows("old", "v10", ".example.com"), ".example.com", keys), "old");
  assert.equal(decryptWindowsChromiumValue(encryptWindows("new", "v20", ".example.com"), ".example.com", keys), "new");
  assert.equal(decryptWindowsChromiumValue(encryptWindows("saved-password", "v10"), "", keys), "saved-password");
  assert.equal(decryptWindowsChromiumValue(encryptWindows("secret", "v20"), "", keys), "secret");
  assert.equal(decryptWindowsChromiumValue(encryptWindows("new", "v20", ".example.com"), ".example.com", { kind: "windows", legacy: keys.legacy }), undefined);
  clearWindowsChromiumKeys(keys);
  assert.equal(keys.legacy.every((byte) => byte === 0), true);
  assert.equal(keys.appBound.every((byte) => byte === 0), true);
});

test("Windows v20 错误站点、篡改过的记录和未知加密版均不导入", () => {
  const keys = { kind: "windows" as const, legacy: WINDOWS_LEGACY, appBound: WINDOWS_APP_BOUND };
  const encrypted = encryptWindows("value", "v20", ".example.com");
  assert.equal(decryptWindowsChromiumValue(encrypted, ".wrong.com", keys), undefined);
  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 0x01;
  assert.equal(decryptWindowsChromiumValue(tampered, ".example.com", keys), undefined);
  assert.equal(decryptWindowsChromiumValue(Buffer.concat([Buffer.from("v30"), encrypted.subarray(3)]), ".example.com", keys), undefined);
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

test("主机专属的 Cookie 不带 domain，否则会被悄悄放宽到子域", () => {
  // Electron 会给拿到的 domain 前面补一个点，所以传了就等于把「只属于这个
  // 主机」改成「连子域一起算」——比原来的范围大，也不是 Chrome 里的样子。
  const mapped = toElectronCookie({
    host: "accounts.google.com",
    name: "sid",
    value: "1",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
  });
  assert.equal(mapped.domain, undefined);
  assert.equal(mapped.url, "https://accounts.google.com/");
});

test("__Host- 前缀的 Cookie 能导进去", () => {
  // 这一条正是以前全军覆没的那一类：__Host- 只有在完全不带 Domain 属性时才
  // 会被接受，而我们每条都塞了 domain，于是每一条都被浏览器拒绝——偏偏
  // Google 登录就重度依赖这一族。
  const mapped = toElectronCookie({
    host: "accounts.google.com",
    name: "__Host-GAPS",
    value: "1",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
  });
  assert.equal(mapped.domain, undefined, "带上 domain 就一定会被拒");
  assert.equal(mapped.path, "/");
  assert.equal(mapped.secure, true);
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

test("a cookie whose expiry overflows a JavaScript number is still imported", () => {
  // Chromium's microseconds-since-1601 timestamps passed Number.MAX_SAFE_INTEGER
  // in the 19th century, so every real cookie carries one that node:sqlite
  // refuses to narrow. Reading a live Chrome profile fails outright without this.
  const directory = mkdtempSync(join(tmpdir(), "coilcoil-cookie-test-"));
  const path = join(directory, "Cookies");
  try {
    const database = new DatabaseSync(path);
    database.exec(`CREATE TABLE cookies(
      creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, top_frame_site_key TEXT NOT NULL,
      name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL, path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL,
      last_access_utc INTEGER NOT NULL, has_expires INTEGER NOT NULL, is_persistent INTEGER NOT NULL,
      priority INTEGER NOT NULL, samesite INTEGER NOT NULL, source_scheme INTEGER NOT NULL,
      source_port INTEGER NOT NULL, last_update_utc INTEGER NOT NULL, source_type INTEGER NOT NULL,
      has_cross_site_ancestor INTEGER NOT NULL)`);
    database
      .prepare(
        "INSERT INTO cookies VALUES (0, '.example.com', '', 'sid', '', ?, '/', 13453916603943569, 1, 1, 0, 1, 1, 1, 2, 2, 443, 0, 0, 0)",
      )
      .run(encrypt("token", ".example.com"));
    database.close();

    const { cookies, unreadable } = cookiesFromDatabase(path, KEY);
    assert.equal(unreadable, 0);
    assert.equal(cookies[0].value, "token");
    assert.equal(cookies[0].secure, true);
    assert.equal(cookies[0].httpOnly, true);
    assert.equal(cookies[0].sameSite, "strict");
    assert.equal(cookies[0].expiresAt, Math.round(13_453_916_603_943_569 / 1_000_000 - 11_644_473_600));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * macOS 27 起，别的 App 在 Application Support 下的数据目录受系统保护：没权限时
 * `stat` 照样成功，但列目录抛 EPERM。以前这里的异常被吞掉、返回空数组，于是
 * 「没权限」和「没装」长得一模一样，Chrome 整个从导入列表里消失，只剩 Safari。
 */
test("没权限和没装要分得开，不能都当成没装", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "Windows / root 不受 chmod 限制" : false }, () => {
  const chrome = CHROMIUM_BROWSERS[0];
  const root = mkdtempSync(join(tmpdir(), "coilcoil-chromium-"));
  try {
    mkdirSync(join(root, "Default"));
    writeFileSync(join(root, "Default", "Cookies"), "");

    const listed = listChromiumProfiles(chrome, root);
    assert.equal(listed.kind, "profiles");
    assert.deepEqual(listed.kind === "profiles" ? listed.profiles.map((profile) => profile.id) : [], ["Default"]);

    // 目录还在、stat 还成功，只是读不了——这正是系统拒绝时的样子。
    chmodSync(root, 0o000);
    assert.equal(listChromiumProfiles(chrome, root).kind, "denied");
  } finally {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

test("目录真的不在才算没装", () => {
  assert.equal(listChromiumProfiles(CHROMIUM_BROWSERS[0], join(tmpdir(), "coilcoil-no-such-browser-xyz")).kind, "absent");
});

test("Windows 的导入来源同时包含 Chrome 和 Edge，不误列 Mac 专属浏览器", () => {
  assert.deepEqual(chromiumBrowsersForPlatform("win32").map((browser) => browser.id), ["chrome", "edge"]);
  assert.equal(browserDescriptor("edge", "win32")?.name, "Microsoft Edge");
  assert.equal(browserDescriptor("safari", "win32"), undefined);
  assert.equal(browserDescriptor("brave", "win32"), undefined);
  assert.deepEqual(chromiumBrowsersForPlatform("linux"), []);
  assert.deepEqual(chromiumBrowsersForPlatform("darwin").map((browser) => browser.id), CHROMIUM_BROWSERS.map((browser) => browser.id));
});

test("Windows 的 Chrome、Edge 各自读取 %LOCALAPPDATA% 下的 User Data", () => {
  const chrome = browserDescriptor("chrome", "win32")!;
  const edge = browserDescriptor("edge", "win32")!;
  const home = "C:\\Users\\tester";
  const local = "D:\\BrowserData";
  assert.equal(browserUserDataRoot(chrome, "win32", home, local), "D:\\BrowserData\\Google\\Chrome\\User Data");
  assert.equal(browserUserDataRoot(edge, "win32", home, local), "D:\\BrowserData\\Microsoft\\Edge\\User Data");
  assert.equal(profileDirectory(edge, "Profile 1", "win32", home, local), "D:\\BrowserData\\Microsoft\\Edge\\User Data\\Profile 1");
  assert.equal(browserUserDataRoot(chrome, "win32", home, ""), "C:\\Users\\tester\\AppData\\Local\\Google\\Chrome\\User Data");
  assert.equal(browserUserDataRoot(chrome, "darwin", "/Users/tester"), "/Users/tester/Library/Application Support/Google/Chrome");
});

test("配置文件只能是源浏览器根目录里的单层目录，不能用 IPC 参数访问别处", () => {
  const chrome = browserDescriptor("chrome", "win32")!;
  for (const id of ["", ".", "..", "../other", "..\\other", "Default/Network", "C:\\Users\\other", "bad\0name"]) {
    assert.throws(() => profileDirectory(chrome, id, "win32", "C:\\Users\\tester", "C:\\Users\\tester\\AppData\\Local"), /配置目录无效/);
  }
  assert.equal(profileDirectory(chrome, "Default", "win32", "C:\\Users\\tester", "C:\\Users\\tester\\AppData\\Local"), "C:\\Users\\tester\\AppData\\Local\\Google\\Chrome\\User Data\\Default");
});

test("只有系统拒绝才算拒绝，找不到不算", () => {
  assert.equal(isPermissionDenied(Object.assign(new Error("denied"), { code: "EPERM" })), true);
  assert.equal(isPermissionDenied(Object.assign(new Error("denied"), { code: "EACCES" })), true);
  assert.equal(isPermissionDenied(Object.assign(new Error("gone"), { code: "ENOENT" })), false);
  assert.equal(isPermissionDenied(new Error("nothing at all")), false);
});
