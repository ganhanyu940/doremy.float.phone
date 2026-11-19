"use client";

// 健康系统的前台兜底触发器。
//
// **主链路在原生**（AlarmManager 精确闹钟），这里只补两个窄缝：
//   ① 用户此刻正用着手机时，让判定准时发生，不必等系统下一次唤醒；
//   ② App 被系统回收过之后，把网页与原生那份数据重新对齐。
//
// 为什么不像学习约定那样做 60 秒轮询：
//   学习约定是"到点结算一次"的纯计算，轮询够用；而这套东西一旦轮询，
//   会让用户误以为"它在后台一直盯着"。真相是：切到后台就停，
//   真正在盯的是原生闹钟。少一点假装，比多一层兜底重要。
//
// 返回 null 的组件，挂载即跑、卸载即停。

import { useEffect } from "react";

import { loadIntentLockConfig, settleDueIntents, syncIntentsToNative } from "@/lib/intent-lock";
import { syncWakeupPlansToNative } from "@/lib/wakeup";

/** 结算结果里"真的锁了"的那几条，广播出去让聊天侧有机会让角色说话。 */
export const INTENT_SETTLED_EVENT = "intent-lock-settled";

export function DisciplineWatcher() {
  useEffect(() => {
    let disposed = false;

    const run = () => {
      if (disposed) return;
      try {
        // ① 意图：先补算到期未结算的（网页可能刚从后台回来），再对齐原生。
        if (loadIntentLockConfig().enabled) {
          const settled = settleDueIntents();
          if (settled.length) {
            window.dispatchEvent(new CustomEvent(INTENT_SETTLED_EVENT, {
              detail: {
                results: settled.map(item => ({
                  id: item.record.id,
                  title: item.record.title,
                  locked: item.locked,
                  message: item.message,
                  characterId: item.record.characterId,
                  sessionId: item.record.sessionId,
                })),
              },
            }));
          }
        }
        // 无论开关状态都同步一次：关掉时这一步负责把原生已排的闹钟清掉。
        syncIntentsToNative();

        // ② 起床：无论开关状态都同步一次，关掉时负责清掉原生已排的闹钟。
        syncWakeupPlansToNative();
      } catch {
        // 兜底失败绝不能影响页面，主链路在原生
      }
    };

    run();
    const onVisible = () => { if (document.visibilityState === "visible") run(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("intent-lock-config-changed", run);
    window.addEventListener("wakeup-config-changed", run);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("intent-lock-config-changed", run);
      window.removeEventListener("wakeup-config-changed", run);
    };
  }, []);
  return null;
}
