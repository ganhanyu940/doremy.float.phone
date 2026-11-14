"use client";

// 意图锁的同步层：把网页侧的「待执行意图」推给原生排闹钟。
//
// 单独一个文件，是因为「什么时候该同步」这件事比想象中容易漏，集中写在一处
// 比散落在各个界面可靠。三个必须同步的时刻：
//   ① 新建意图后     —— 不推就根本不会响（最要命的一个）
//   ② 打卡/取消后   —— 不推的话闹钟还在，到点照样响、照样锁
//   ③ App 回到前台  —— 网页可能在后台被系统回收过，原生那份要重新对齐

import {
  loadIntentLockConfig,
  loadIntentRecords,
  type IntentRecord,
} from "./storage";
import type { NativeIntentPayload } from "./native-bridge";
import {
  cancelIntentCheckNative,
  clearIntentRecordsNative,
  scheduleIntentCheckNative,
  syncIntentRecordsNative,
} from "./native-bridge";

/**
 * 只有 pending 且还没过期的意图需要原生排闹钟。
 *
 * 放行清单从配置里取：原生判定时也用这份，两边不能不一致——
 * 不一致的表现是「网页说这个算放行、原生说算玩」，然后你被误锁。
 */
function toPayload(record: IntentRecord, allowPackages: string[], allowInnerApps: string[], now: number): NativeIntentPayload | null {
  if (record.status !== "pending") return null;
  if (record.checkAt > record.expireAt) return null;
  if (record.expireAt <= now) return null;
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    checkAt: record.checkAt,
    lockMinutes: record.lockMinutes,
    allowPackages,
    allowInnerApps,
  };
}

/**
 * 把当前所有待执行意图整份推给原生（覆盖式），并逐条排闹钟。
 *
 * 用覆盖而不是增量：增量要处理"这条被取消了但没通知到"的情况，
 * 而那种幽灵条目会让用户在取消之后还被锁——覆盖最不容易出错。
 */
export function syncIntentsToNative(now = Date.now()): void {
  const config = loadIntentLockConfig();
  if (!config.enabled) {
    // 关掉功能时也要清：不清的话已排的闹钟还会响，用户关了开关照样被锁。
    clearIntentRecordsNative();
    return;
  }
  const payloads = loadIntentRecords()
    .map(record => toPayload(record, config.allowPackages, config.allowInnerApps, now))
    .filter((item): item is NativeIntentPayload => item !== null);

  syncIntentRecordsNative(payloads);
  for (const payload of payloads) {
    // 同一 id 用同一 requestCode，重复调用只更新时刻，不会叠出多个闹钟。
    scheduleIntentCheckNative(payload.id, payload.checkAt);
  }
}

/** 单条意图结束后立刻取消它的闹钟。打卡、取消、结算成功都要调。 */
export function cancelIntentNative(intentId: string): void {
  cancelIntentCheckNative(intentId);
}
