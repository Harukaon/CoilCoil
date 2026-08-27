import { Compass, Download, Globe, KeyRound, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { BrowserDataStats, ImportableProfile, SavedLoginSummary } from "../../../../shared/desktop-api";
import { ConfirmDialog } from "../../ui/dialog";
import { toastError, toastInfo, toastSuccess } from "../../ui/toast";

function profileKey(profile: ImportableProfile): string {
  return `${profile.browser}:${profile.id}`;
}

function describeProfile(profile: ImportableProfile): string {
  if (profile.problem) return profile.problem;
  const parts: string[] = [];
  if (profile.email) parts.push(profile.email);
  if (profile.cookieCount !== undefined) parts.push(`${profile.cookieCount} 条 Cookie`);
  if (profile.passwordCount) parts.push(`${profile.passwordCount} 个密码`);
  return parts.join(" · ");
}

/**
 * Import another browser's signed-in state, and drop our own.
 *
 * The built-in browser is a separate jar from every browser on the Mac, so the
 * agent meets every site logged out. Taking a copy of one profile's cookies is
 * what makes it useful, and the profile picker is the point of the screen:
 * Chrome keeps one persona per profile and the user rarely wants all of them.
 *
 * The clear button is deliberately as prominent as the import button. Handing an
 * agent your live sessions is only reasonable when taking them back is one click.
 */
export function BrowserSettings(): React.JSX.Element {
  const [profiles, setProfiles] = useState<ImportableProfile[]>();
  const [stats, setStats] = useState<BrowserDataStats>();
  const [logins, setLogins] = useState<SavedLoginSummary[]>([]);
  const [withPasswords, setWithPasswords] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [confirmClear, setConfirmClear] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    const [found, current, saved] = await Promise.all([
      window.coilcoil.listImportableBrowsers(),
      window.coilcoil.getBrowserDataStats(),
      window.coilcoil.listSavedLogins(),
    ]);
    setProfiles(found);
    setStats(current);
    setLogins(saved);
  }, []);

  useEffect(() => {
    void refresh().catch((caught: unknown) => toastError(caught instanceof Error ? caught.message : String(caught)));
  }, [refresh]);

  const importFrom = async (profile: ImportableProfile): Promise<void> => {
    setBusy(profileKey(profile));
    try {
      const summary = await window.coilcoil.importBrowserCookies({
        browser: profile.browser,
        profile: profile.id,
        includePasswords: withPasswords,
      });
      if (summary.error) {
        toastError(summary.error);
      } else if (summary.imported === 0 && summary.passwords === 0) {
        toastError("没有可导入的登录状态，可能这个配置文件本来就是空的。");
      } else {
        // The unreadable count is worth surfacing: it is the difference between
        // "everything came over" and "your one important site did not".
        const failed = summary.failed + summary.unreadable;
        toastSuccess(
          `已导入 ${summary.imported} 条 Cookie，覆盖 ${summary.hosts} 个网站`
          + (summary.passwords > 0 ? `，另存 ${summary.passwords} 个密码` : "")
          + (failed > 0 ? `，${failed} 条读不出来已跳过` : "")
          + "。",
        );
      }
      if (summary.note) toastInfo(summary.note);
      await refresh();
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(undefined);
    }
  };

  const clearAll = async (): Promise<void> => {
    setConfirmClear(false);
    setBusy("clear");
    try {
      setStats(await window.coilcoil.clearBrowserData());
      setLogins([]);
      toastSuccess("内置浏览器已退出所有登录，缓存和已保存的密码也一并清空。");
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(undefined);
    }
  };

  const nothingToClear = (stats?.cookies ?? 0) === 0 && (stats?.savedLogins ?? 0) === 0;

  return (
    <div className="browser-settings">
      <section className="browser-section">
        <div className="browser-section-head">
          <div>
            <h3>从已有浏览器导入登录状态</h3>
            <p className="browser-lead">
              把某个浏览器配置文件里的 Cookie 复制一份到 CoilCoil 的内置浏览器，Agent 就能带着你的登录态访问网站。
              原浏览器不受任何影响。首次导入时 macOS 会弹出钥匙串授权，那是解密 Cookie 必需的一步。
            </p>
          </div>
          <button className="browser-ghost-button" type="button" disabled={busy !== undefined} onClick={() => void refresh()}>
            <RefreshCw size={13} />刷新
          </button>
        </div>

        <label className="browser-check">
          <input type="checkbox" checked={withPasswords} onChange={(event) => setWithPasswords(event.target.checked)} />
          <span>
            <strong>连保存的密码一起导入</strong>
            <small>
              密码单独加密存在 CoilCoil 里，只用于在内置浏览器的登录页自动填充，永远不会交给模型，也不会跟着远程控制离开这台 Mac。
              Safari 的密码在钥匙串里，系统不允许整批导出。
            </small>
          </span>
        </label>

        {profiles === undefined ? (
          <p className="browser-lead">正在查找这台电脑上的浏览器…</p>
        ) : profiles.length === 0 ? (
          <p className="browser-empty">没有找到可以导入的浏览器。目前只支持 macOS 上的 Chrome 系浏览器和 Safari。</p>
        ) : (
          <ul className="browser-profile-list">
            {profiles.map((profile) => (
              <li key={profileKey(profile)} className={profile.available ? "" : "unavailable"}>
                <span className="browser-profile-icon">
                  {profile.browser === "safari" ? <Compass size={16} /> : <Globe size={16} />}
                </span>
                <div className="browser-profile-label">
                  <strong>{profile.browserName}<span className="browser-profile-name"> · {profile.name}</span></strong>
                  <span className="browser-profile-meta">{describeProfile(profile)}</span>
                </div>
                <button
                  className="browser-import-button"
                  type="button"
                  disabled={!profile.available || busy !== undefined}
                  onClick={() => void importFrom(profile)}
                >
                  {busy === profileKey(profile) ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />}
                  导入
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="browser-section">
        <div className="browser-section-head">
          <div>
            <h3>内置浏览器的数据</h3>
            <p className="browser-lead">
              {stats === undefined
                ? "正在统计…"
                : nothingToClear
                  ? "内置浏览器目前是干净的，没有任何登录状态。"
                  : `当前保存了 ${stats.cookies} 条 Cookie，覆盖 ${stats.hosts} 个网站`
                    + (stats.savedLogins > 0 ? `，另有 ${stats.savedLogins} 个已保存的密码。` : "。")}
            </p>
          </div>
          <button
            className="browser-danger-button"
            type="button"
            disabled={busy !== undefined || nothingToClear}
            onClick={() => setConfirmClear(true)}
          >
            {busy === "clear" ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}
            一键清空
          </button>
        </div>

        {logins.length === 0 ? null : (
          <ul className="browser-login-list">
            {logins.map((login) => (
              <li key={`${login.origin} ${login.username}`}>
                <KeyRound size={13} />
                <span className="browser-login-origin">{login.origin.replace(/^https?:\/\//, "")}</span>
                <span className="browser-login-user">{login.username || "（无用户名）"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={confirmClear}
        title="清空内置浏览器的数据？"
        description="所有 Cookie、本地存储、缓存和已保存的密码都会删除，内置浏览器会退出全部登录。你自己的 Chrome、Safari 不受影响。"
        actions={[
          { label: "取消", onClick: () => setConfirmClear(false) },
          { label: "清空", variant: "danger", onClick: () => void clearAll() },
        ]}
        onClose={() => setConfirmClear(false)}
      />
    </div>
  );
}
