"use client";

// 锁机的后台守望：网页不在聊天室里时，锁定也得收得住。
//
// 三件事，都挂在桌面壳这种「一直在跑」的地方：
//  1. 订阅原生事件：用户在原生浮层点「我记住了」→ 结算；原生到点回收 → 对齐状态；
//  2. 定时对表：原生按绝对时间自己会闭，网页这边也要跟上（避免页面上还挂着一层）；
//  3. 页面回到前台时立刻对一次，用户从别的 App 切回来看到的就是真实状态。
//
// 不在这里做任何「判断该不该锁」的事——锁的发起只在聊天回复的解析环节，
// 那才是角色真正开口的地方。

import { useEffect } from "react";

import { confirmLockdown, getActiveLockdown, syncNativeLockdown } from "@/lib/lockdown-engine";
import { loadLockdownSettings } from "@/lib/lockdown-storage";
import { subscribeShellLockdownEvents, prepareShellLockdown } from "@/lib/shell-lockdown";

export function LockdownNativeWatcher() {
    useEffect(() => {
        const tick = () => {
            // getActiveLockdown 会把「该结束了」的锁定当场结算（含写入历史、收掉原生浮层）
            getActiveLockdown();
        };

        // 预热原生锁机服务：锁机常常在用户已经切到别的 App 之后才触发，
        // 而那时不允许起前台服务。所以趁现在（App 在前台、用户刚打开）先暖好。
        // 只在用户确实允许锁真机时才暖，否则白白常驻一个前台服务。
        const warmUp = () => {
            const settings = loadLockdownSettings();
            if (!settings.enabled) return;
            if (!settings.allowDevice && !settings.allowAppLock) return;
            prepareShellLockdown();
        };

        // 每 5 秒对一次表。锁定是分钟级的事，不需要更密。
        const timer = window.setInterval(tick, 5000);

        const onVisible = () => {
            if (document.visibilityState !== "visible") return;
            tick();
            // 回到前台时补一次预热：服务可能被系统回收过（后台清理内存、重启）
            warmUp();
            // 网页侧还锁着但原生浮层被系统清了（重启、权限被撤）：补下发一次
            const state = getActiveLockdown();
            if (state && (state.scope.device || state.scope.apps)) syncNativeLockdown(state);
        };
        document.addEventListener("visibilitychange", onVisible);
        warmUp();

        const unsubscribe = subscribeShellLockdownEvents((event) => {
            if (event.action === "unlocked") {
                // 只认「用户点了确认」，计时式且用户关掉提前放行时 confirmLockdown 会自己拒绝
                confirmLockdown();
                return;
            }
            if (event.action === "stopped") {
                // 原生到点回收：状态以网页的绝对时间为准，这里只是重新核一遍
                tick();
            }
        });

        return () => {
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisible);
            unsubscribe();
        };
    }, []);

    return null;
}
