"use client";

// 起床叫醒的网页 ↔ 原生桥。
//
// 网页负责：跟角色商量几点起、提前把话合成成音频、把计划交给原生。
// 原生负责：到点响（播音频/振动/闹铃音）、最多响几轮、记住结果。
//
// 为什么音频要提前合成：早上叫醒那一刻 App 在后台被冻结，网页发不出
// Minimax 请求。所以必须在睡前（App 活着时）就合成好存本地。

type WakeupNativeBridge = {
  syncWakeupPlans?: (json: string) => boolean;
  scheduleWakeup?: (planId: string, atMs: number) => boolean;
  cancelWakeup?: (planId: string) => boolean;
  stopWakeupRinging?: () => boolean;
  getWakeupStatus?: () => string;
  getWakeupOutcome?: (planId: string) => string;
};

function bridge(): WakeupNativeBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { AndroidShell?: WakeupNativeBridge }).AndroidShell;
  if (!candidate || typeof candidate !== "object") return null;
  return typeof candidate.scheduleWakeup === "function" ? candidate : null;
}

/** 原生是否支持起床叫醒（1.0.38 才有）。 */
export function supportsWakeup(): boolean {
  return bridge() !== null;
}

/** 交给原生的计划（只传它要用到的，别整条塞过去）。 */
export type NativeWakeupPlan = {
  id: string;
  at: number;
  speech: string;
  characterName: string;
  audioDataUrl: string;
  volume: number;
  rampSeconds: number;
  vibrate: boolean;
  playAlarmTone: boolean;
  repeatEveryMinutes: number;
  maxRounds: number;
};

/** 整份下发（覆盖式）。 */
export function syncWakeupPlansNative(plans: NativeWakeupPlan[]): boolean {
  const native = bridge();
  if (!native?.syncWakeupPlans) return false;
  try {
    return native.syncWakeupPlans(JSON.stringify(plans)) === true;
  } catch {
    return false;
  }
}

export function scheduleWakeupNative(planId: string, atMs: number): boolean {
  try {
    return bridge()?.scheduleWakeup?.(planId, atMs) === true;
  } catch {
    return false;
  }
}

export function cancelWakeupNative(planId: string): boolean {
  try {
    return bridge()?.cancelWakeup?.(planId) === true;
  } catch {
    return false;
  }
}

/** 面板上的「别响了」。 */
export function stopWakeupRingingNative(): boolean {
  try {
    return bridge()?.stopWakeupRinging?.() === true;
  } catch {
    return false;
  }
}

/** 现在是不是正在响。非壳环境恒为 false。 */
export function isWakeupRinging(): boolean {
  try {
    const raw = bridge()?.getWakeupStatus?.();
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { ringing?: boolean };
    return parsed.ringing === true;
  } catch {
    return false;
  }
}

/** 读那次叫醒的真实结果（响了没、几轮、是不是自己起来的）。 */
export function readWakeupOutcomeNative(planId: string): string {
  try {
    return bridge()?.getWakeupOutcome?.(planId) ?? "";
  } catch {
    return "";
  }
}
