import { useCallback, useEffect, useState } from "react";
import type { UpdateAvailable } from "../../../../shared/desktop-api";
import { Modal } from "../dialog";
import { toastError } from "../toast";

function displayVersion(version: string): string {
  return version.replace(/^\d+\.\d+\.\d+-/, "");
}

export function UpdateDialog(): React.JSX.Element | null {
  const [update, setUpdate] = useState<UpdateAvailable>();
  const [opening, setOpening] = useState(false);

  useEffect(() => window.coilcoil.onUpdateAvailable(setUpdate), []);

  const close = useCallback(() => {
    if (!opening) setUpdate(undefined);
  }, [opening]);

  const download = useCallback(async (): Promise<void> => {
    if (!update) return;
    setOpening(true);
    try {
      await window.coilcoil.openExternal(update.url);
      setUpdate(undefined);
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setOpening(false);
    }
  }, [update]);

  if (!update) return null;
  const latest = displayVersion(update.latest);
  const current = displayVersion(update.current);
  return (
    <Modal
      open
      size="sm"
      title={`有新版 ${latest}`}
      description={`当前版本 ${current}。要去下载页更新吗？`}
      onClose={close}
      footer={
        <>
          <button className="coil-modal-button" type="button" disabled={opening} onClick={close}>稍后</button>
          <button className="coil-modal-button primary" type="button" disabled={opening} onClick={() => void download()}>
            {opening ? "正在打开…" : "去下载"}
          </button>
        </>
      }
    />
  );
}
