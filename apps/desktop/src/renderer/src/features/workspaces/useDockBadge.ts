import { useEffect } from "react";
import { unreadConversationCount } from "./sessionList";

/**
 * 让 Dock（macOS）/任务栏角标跟着「跑完了还没看」的对话数走。
 *
 * 盯的是 sessionActivity 的最终状态，而不是各个改动它的地方：未读会从好几条路径
 * 产生（回复结束、从对话切走、归档），逐个去通知一定会漏掉一条。
 */
export function useDockBadge(sessionActivity: Record<string, { running: boolean; unread: boolean }>): void {
  useEffect(() => {
    void window.coilcoil.setBadgeCount?.(unreadConversationCount(sessionActivity));
  }, [sessionActivity]);
}
