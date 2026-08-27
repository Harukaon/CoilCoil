import { execFile } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { promisify } from "node:util";
import type { ChromiumBrowserDescriptor } from "./browser-catalog";

const run = promisify(execFile);

/**
 * Chromium's macOS cookie encryption, reproduced.
 *
 * Every Chromium browser on macOS stores one random passphrase in the login
 * keychain ("<Browser> Safe Storage") and derives an AES-128 key from it with
 * fixed parameters that have not changed since 2011: PBKDF2-SHA1, the literal
 * salt "saltysalt", 1003 iterations, and an IV of sixteen spaces. Values are
 * tagged "v10" so a future scheme can be told apart from this one.
 *
 * Reading the passphrase is what makes the import a privileged operation: macOS
 * shows the keychain prompt for CoilCoil the first time, and the user's answer
 * is the real consent for the whole feature.
 */
const KEY_SALT = "saltysalt";
const KEY_ITERATIONS = 1003;
const KEY_LENGTH = 16;
const VERSION_TAG = "v10";

/**
 * macOS `security` exit codes worth telling apart.
 *
 * 36 is `errSecInteractionNotAllowed`: the keychain would have asked the user,
 * but the process has no window session to ask in. That is not a refusal, and
 * saying "denied" for it sends the user looking for a prompt that never came.
 * 44 is the item simply not being there, which means that browser has never run.
 */
const INTERACTION_NOT_ALLOWED = 36;
const ITEM_NOT_FOUND = 44;

export class KeychainDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeychainDeniedError";
  }
}

function keychainFailure(browserName: string, code: number | undefined): KeychainDeniedError {
  if (code === ITEM_NOT_FOUND) {
    return new KeychainDeniedError(`钥匙串里没有「${browserName}」的加密密码，这个浏览器可能从未在本机运行过。`);
  }
  if (code === INTERACTION_NOT_ALLOWED) {
    return new KeychainDeniedError(
      `系统不允许弹出钥匙串授权窗口，所以读不到「${browserName}」的密码。`
      + "这通常是因为 CoilCoil 不是从桌面启动的（例如从远程终端启动）；请从访达或程序坞正常打开 CoilCoil 后重试。",
    );
  }
  return new KeychainDeniedError(`无法读取「${browserName}」的钥匙串密码，导入已取消。`);
}

export async function readSafeStorageKey(browser: ChromiumBrowserDescriptor): Promise<Buffer> {
  let passphrase: string;
  try {
    const { stdout } = await run("/usr/bin/security", [
      "find-generic-password",
      "-w",
      "-s",
      browser.keychainService,
      "-a",
      browser.keychainAccount,
    ]);
    passphrase = stdout.trim();
  } catch (error) {
    const code = (error as { code?: number }).code;
    throw keychainFailure(browser.name, typeof code === "number" ? code : undefined);
  }
  if (!passphrase) throw keychainFailure(browser.name, undefined);
  return pbkdf2Sync(passphrase, KEY_SALT, KEY_ITERATIONS, KEY_LENGTH, "sha1");
}

/**
 * Recent Chrome versions bind a cookie to its host by prefixing the plaintext
 * with SHA-256 of the host key. The prefix is not part of the value and must be
 * stripped — but only when it really is the hash, because older cookies written
 * by earlier versions of the same browser sit in the same database untouched.
 */
function stripHostBinding(plaintext: Buffer, hostKey: string): Buffer {
  // Passwords are not host-bound; callers pass an empty key to say so.
  if (hostKey === "" || plaintext.length < 32) return plaintext;
  const expected = createHash("sha256").update(hostKey, "utf8").digest();
  return plaintext.subarray(0, 32).equals(expected) ? plaintext.subarray(32) : plaintext;
}

/**
 * Returns the cleartext value, or undefined when the record uses a scheme we do
 * not implement. One unreadable cookie must never fail an import of thousands,
 * so callers count these instead of throwing.
 */
export function decryptChromiumValue(encrypted: Buffer, hostKey: string, key: Buffer): string | undefined {
  if (encrypted.length === 0) return "";
  if (encrypted.subarray(0, 3).toString("latin1") !== VERSION_TAG) return undefined;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
    const plaintext = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    return stripHostBinding(plaintext, hostKey).toString("utf8");
  } catch {
    return undefined;
  }
}
