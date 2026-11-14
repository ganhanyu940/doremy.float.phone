"use client";

// 睡前锁的网页 ↔ 原生桥。
//
// 这一层存在的唯一原因：**定时不能放在网页里**。
// 用户实测「切屏挂后台就停止进程」——WebView 进后台后 JS 会被系统冻结，
// setInterval 可能几十分钟才跑一次甚至完全不跑，所以「每分钟检查该不该锁」
// 这种实现在他锁屏睡觉时根本不会执行，到点永远不会锁。
//
// 因此分工是：
//   网页 = 用户配置界面 + 把配置下发给原生 + 显示状态
//   原生 = AlarmManager 精确闹钟 + 到点执行锁定（见 BedtimeScheduler.kt）
//
// 所有方法在非壳环境（浏览器/PWA）安全降级：返回 false / null，调用方据此
// 如实告诉用户「这个功能要在 App 里用」，绝不假装配置成功。

type BedtimeNativeBridge = {
  configureBedtimeLock?: (json: string) => boolean;
  getBedtimeLockStatus?: () => string;
  rescheduleBedtimeLock?: () => boolean;
  cancelBedtimeLock?: () => boolean;
  markBedtimeUnlock?: () => boolean;
  resetBedtimeState?: () => boolean;
};

function bridge(): BedtimeNativeBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { AndroidShell?: BedtimeNativeBridge }).AndroidShell;
  if (!candidate || typeof candidate !== "object") return null;
  return typeof candidate.configureBedtimeLock === "function" ? candidate : null;
}

/** 原生是否支持睡前锁（1.0.37 才有；老壳返回 false，界面据此提示升级）。 */
export function supportsBedtimeLock(): boolean {
  return bridge() !== null;
}

/** 下发配置到原生。返回是否受理；false 时原生不会排闹钟。 */
export function configureBedtimeLockNative(payload: {
  enabled: boolean;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  reason: string;
}): boolean {
  const native = bridge();
  if (!native?.configureBedtimeLock) return false;
  try {
    return native.configureBedtimeLock(JSON.stringify(payload)) === true;
  } catch {
    return false;
  }
}

export type BedtimeNativeStatus = {
  enabled: boolean;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  /** 下一次会在什么时候响（毫秒时间戳）；0 = 没排上 */
  nextTriggerAt: number;
  /**
   * 是否拿到了「精确闹钟」权限。
   *
   * false 不是致命错误：闹钟照样会响，但 Doze 下可能迟到几分钟。
   * 面板必须如实显示这个差别——把「可能迟到」说成「准时」，
   * 用户被放过一次就再也不信这东西了。
   */
  exact: boolean;
  /** 最近一次触发的结果（半夜没锁上时，第二天就靠这条查原因） */
  lastOutcome: string;
  lastTriggerAt: number;
};

/** 读原生状态。非壳或老壳返回 null，调用方退回本地推算。 */
export function readBedtimeNativeStatus(): BedtimeNativeStatus | null {
  const native = bridge();
  if (!native?.getBedtimeLockStatus) return null;
  try {
    const raw = native.getBedtimeLockStatus();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BedtimeNativeStatus>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      enabled: parsed.enabled === true,
      startHour: Number(parsed.startHour ?? 23),
      startMinute: Number(parsed.startMinute ?? 0),
      endHour: Number(parsed.endHour ?? 6),
      endMinute: Number(parsed.endMinute ?? 30),
      nextTriggerAt: Number(parsed.nextTriggerAt ?? 0),
      exact: parsed.exact === true,
      lastOutcome: typeof parsed.lastOutcome === "string" ? parsed.lastOutcome : "",
      lastTriggerAt: Number(parsed.lastTriggerAt ?? 0),
    };
  } catch {
    return null;
  }
}

/** 让原生重排下一次闹钟（改完时间或排查定时失效时用）。 */
export function rescheduleBedtimeLockNative(): boolean {
  try {
    return bridge()?.rescheduleBedtimeLock?.() === true;
  } catch {
    return false;
  }
}

/** 取消闹钟。用户关开关时必须调——不调的话关了还会半夜响。 */
export function cancelBedtimeLockNative(): boolean {
  try {
    return bridge()?.cancelBedtimeLock?.() === true;
  } catch {
    return false;
  }
}

/** 告诉原生「用户这一轮自己解开了」，让后面的闹钟不再锁。 */
export function markBedtimeUnlockNative(): boolean {
  try {
    return bridge()?.markBedtimeUnlock?.() === true;
  } catch {
    return false;
  }
}

/** 清掉「今晚已锁过 / 已解开」的记录。 */
export function resetBedtimeStateNative(): boolean {
  try {
    return bridge()?.resetBedtimeState?.() === true;
  } catch {
    return false;
  }
}
