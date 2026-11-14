"use client";

// 睡前锁的前台兜底触发器。
//
// **这不是主链路**，主链路在原生的 AlarmManager（见 lib/bedtime-lock/native-bridge.ts）。
// 它只补一个窄缝：用户恰好在这个点正用着手机，而原生闹钟还没响到，
// 回到前台时立刻补一次判定，让遮罩准时盖上，不必等系统下一次唤醒。
//
// 为什么还留它：原生闹钟是精确的，但 Doze 下可能迟到几分钟；而用户
// 如果此刻正在刷小手机，遮罩晚盖几分钟就等于多刷几分钟——正是他要防的事。
//
// 刻意**不做成 60 秒轮询**（学习约定那边是那样）：约定是「到点结算一次」，
// 而这里如果靠网页轮询，切后台就失效，留着只会让人误以为它一直在工作。
// 返回 null 的组件，挂载即跑、卸载即停。

import { useEffect } from "react";

import { catchUpBedtimeLock, loadBedtimeLockConfig, syncBedtimeToNative } from "@/lib/bedtime-lock";

export function BedtimeLockWatcher() {
  useEffect(() => {
    let disposed = false;

    const run = () => {
      if (disposed) return;
      try {
        const config = loadBedtimeLockConfig();
        if (!config.enabled) return;
        // 每次回前台顺便把配置同步一次：用户可能在别处改过时间，
        // 而原生那边的闹钟是按旧时间排的。这个幂等操作很便宜。
        syncBedtimeToNative(config);
        catchUpBedtimeLock();
      } catch {
        // 兜底失败绝不能影响页面，主链路在原生那边
      }
    };

    // 启动后立刻跑一次：App 关了整晚、早上才打开时，直接把过期的判定走一遍
    run();
    const onVisible = () => { if (document.visibilityState === "visible") run(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("bedtime-lock-config-changed", run);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("bedtime-lock-config-changed", run);
    };
  }, []);
  return null;
}
