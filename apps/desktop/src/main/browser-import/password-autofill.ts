import type { WebContents } from "electron";
import { loginsForOrigin } from "./password-vault";

/**
 * Fill an imported login into a page of the built-in browser.
 *
 * This is the whole point of importing passwords: a cookie expires and the site
 * shows a login form again, and neither the user nor the agent should have to
 * go and look the password up. It behaves the way a browser's own autofill
 * behaves — it fills, and it never submits. Deciding to sign in stays a click
 * somebody makes on purpose.
 *
 * Rules that keep this from becoming a leak:
 *  - the page's own origin must match the saved one exactly, so a look-alike
 *    domain gets nothing;
 *  - exactly one credential must match, because picking between two accounts is
 *    a decision, not a default;
 *  - only an empty password field is filled, so a page that already has one — or
 *    a form the user is typing into — is left alone.
 */
function fillScript(username: string, password: string): string {
  return `(function () {
  var fields = Array.prototype.slice.call(document.querySelectorAll("input[type=password]"));
  var target = fields.filter(function (field) {
    return !field.disabled && !field.readOnly && field.value === "" && field.offsetParent !== null;
  })[0];
  if (!target) return false;

  function assign(field, value) {
    // React and Vue track the previous value on the node itself, so a plain
    // assignment is reverted on the next render. Going through the prototype's
    // setter is what makes the framework see a real edit.
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    if (setter && setter.set) setter.set.call(field, value);
    else field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }

  var user = ${JSON.stringify(username)};
  if (user) {
    var scope = target.form || document;
    var candidates = Array.prototype.slice.call(scope.querySelectorAll("input"));
    var identity = candidates.filter(function (field) {
      var type = (field.getAttribute("type") || "text").toLowerCase();
      return ["text", "email", "tel"].indexOf(type) !== -1 && !field.disabled && !field.readOnly && field.offsetParent !== null;
    });
    // The username box is the last plain field before the password box; a form
    // may well have others after it (a search box in the same document).
    var before = identity.filter(function (field) {
      return field.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING;
    });
    var box = before.length > 0 ? before[before.length - 1] : identity[0];
    if (box && box.value === "") assign(box, user);
  }
  assign(target, ${JSON.stringify(password)});
  return true;
})()`;
}

function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

export function fillSavedCredentials(contents: WebContents, partition?: string): void {
  const origin = originOf(contents.getURL());
  if (!origin) return;
  let matches;
  try {
    // 密码和 cookie 一样按工作区分开：填的必须是这个页面所属那份里的。
    matches = loginsForOrigin(origin, partition);
  } catch {
    return;
  }
  if (matches.length !== 1) return;
  const [entry] = matches;
  void contents
    .executeJavaScript(fillScript(entry.username, entry.password), true)
    .catch(() => {
      // A page that navigated away mid-fill, or one that forbids evaluation.
      // Autofill is a convenience; failing it must never surface as an error.
    });
}
