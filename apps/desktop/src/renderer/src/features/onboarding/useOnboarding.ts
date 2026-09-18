import { useCallback, useState } from "react";
import { clearOnboarding, loadOnboarding, saveOnboarding } from "../../appState";
import type { PermissionDecisions } from "./onboardingSteps";

/**
 * 引导现在该不该出现，以及怎么结束、怎么重来。
 *
 * 判断只在挂载时做一次：引导是整屏的一层，中途重新判定会让它在用户眼前闪。
 */
export function useOnboarding(): {
  /** 引导正在占着整个界面。它为真的时候工作区一概不渲染。 */
  active: boolean;
  /** 走完了。把用户对每一项系统权限的处置一起记下来。 */
  finish: (permissions: PermissionDecisions) => void;
  /** 从设置里重新走一遍。 */
  replay: () => void;
} {
  const [active, setActive] = useState(() => loadOnboarding() === undefined);

  const finish = useCallback((permissions: PermissionDecisions): void => {
    saveOnboarding({ completedAt: new Date().toISOString(), permissions });
    setActive(false);
  }, []);

  const replay = useCallback((): void => {
    clearOnboarding();
    setActive(true);
  }, []);

  return { active, finish, replay };
}
