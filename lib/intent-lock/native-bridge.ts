"use client";

// 意图锁的网页 ↔ 原生桥。
//
// 分工与睡前锁一致：
//   网页 = 记下用户说的话、把待执行的意图整份同步给原生、显示结果
//   原生 = AlarmManager 排检查闹钟 + 到点自己读使用情况判定并锁
//
// 为什么判定也在原生做（不只是定时）：用户说完「我去洗澡」就把手机放下，
// 那一刻 App 在后台、网页被冻结；要判断"他到底放下没有"，只能在原生读。

type IntentNativeBridge = {
  syncIntentRecords?: (json: string) => boolean;
  scheduleIntentCheck?: (intentId: string, checkAtMs: number) => boolean;
  cancelIntentCheck?: (intentId: string) => boolean;
  clearIntentRecords?: () => boolean;
  getIntentOutcome?: (intentId: string) => string;
};

function bridge(): IntentNativeBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { AndroidShell?: IntentNativeBridge }).AndroidShell;
  if (!candidate || typeof candidate !== "object") return null;
  return typeof candidate.syncIntentRecords === "function" ? candidate : null;
}

/** 原生是否支持意图锁（1.0.38 才有；老壳返回 false，界面据此提示升级）。 */
export function supportsIntentLock(): boolean {
  return bridge() !== null;
}

/** 原生侧要用的字段（只传判定必需的，别把整条记录塞过去）。 */
export type NativeIntentPayload = {
  id: string;
  title: string;
  createdAt: number;
  checkAt: number;
  lockMinutes: number;
  allowPackages: string[];
  allowInnerApps: string[];
};

/** 整份同步待执行意图（覆盖式）。返回是否受理。 */
export function syncIntentRecordsNative(payload: NativeIntentPayload[]): boolean {
  const native = bridge();
  if (!native?.syncIntentRecords) return false;
  try {
    return native.syncIntentRecords(JSON.stringify(payload)) === true;
  } catch {
    return false;
  }
}

/** 给某条意图排检查闹钟。 */
export function scheduleIntentCheckNative(intentId: string, checkAtMs: number): boolean {
  try {
    return bridge()?.scheduleIntentCheck?.(intentId, checkAtMs) === true;
  } catch {
    return false;
  }
}

/** 取消某条意图的闹钟。打卡完成、用户取消都必须调，否则到点还会响。 */
export function cancelIntentCheckNative(intentId: string): boolean {
  try {
    return bridge()?.cancelIntentCheck?.(intentId) === true;
  } catch {
    return false;
  }
}

/** 清掉原生侧全部待执行意图（关掉整个功能时）。 */
export function clearIntentRecordsNative(): boolean {
  try {
    return bridge()?.clearIntentRecords?.() === true;
  } catch {
    return false;
  }
}

/** 读某条意图的原生结算结果（后台那次锁没锁，只有原生知道）。 */
export function readIntentOutcomeNative(intentId: string): string {
  try {
    return bridge()?.getIntentOutcome?.(intentId) ?? "";
  } catch {
    return "";
  }
}
