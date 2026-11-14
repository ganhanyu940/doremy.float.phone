"use client";

// 角色锁机的执行入口（唯一决策点）。
//
// 分工：lib/phone-lock.ts 是「怎么调原生」，这里是「该不该做、能不能做、怎么措辞」。
// 原生（LockGuard.kt）只执行，不判断——它连「是不是角色发起的」都不知道。
//
// 门控（任一不过就不执行，且都给出人话原因）：
//   ① 用户是否允许角色锁机（默认关）
//   ② 壳是否支持（未装 APK / APK 版本过低）
//   ③ 无障碍服务是否开启（锁机依赖它，没开就是完全不能生效）
//
// 设计原则：**失败必须说清楚**。角色以为锁上了其实没锁，比拒绝执行更糟——
// 所以每个失败分支都带整句原因，绝不静默吞掉，也绝不允许它假装成功。

import {
  getPhoneLockStatus,
  isPhoneLockAvailable,
  lockPhoneFor,
  openAppByPackage,
  unlockPhone,
} from "../phone-lock";
import { appendPerceptionLog } from "../perception/storage";
import { loadPhoneLockConfig, PHONE_LOCK_MAX_MINUTES } from "./storage";

/** 一次锁机/解锁动作的结论。ok=false 时 reason 一定是给人看的整句。 */
export type PhoneLockOutcome = {
  ok: boolean;
  /** 成功时的结果描述（给角色看的） */
  message?: string;
  /** 失败原因 */
  reason?: string;
};

function logLock(type: string, payload: string): void {
  try {
    appendPerceptionLog({
      id: `lock_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      at: new Date().toISOString(),
      capability: "deviceAction",
      type,
      payload: payload.slice(0, 200),
      outcome: "已执行",
    });
  } catch {
    // 记流水失败不该影响动作本身（锁已经真的生效了）
  }
}

/** 把分钟数说成人话。 */
export function humanizeLockMinutes(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h <= 0) return `${m} 分钟`;
  return rest ? `${h} 小时 ${rest} 分钟` : `${h} 小时`;
}

/**
 * 角色锁机是否可用（设置面板用它显示三态）。
 *
 * 分开报 configEnabled / bridgeAvailable / accessibilityReady：
 * 用户看到「不可用」时必须知道具体卡在哪一步，否则只能干瞪眼。
 */
export function checkCharacterLockAvailability(): {
  configEnabled: boolean;
  bridgeAvailable: boolean;
  accessibilityReady: boolean;
  available: boolean;
} {
  const config = loadPhoneLockConfig();
  const status = getPhoneLockStatus();
  // bridgeAvailable 用 status 是否读得出来判断：读得到就说明壳里桥在。
  // 不能只看 isPhoneLockAvailable()——后者在无障碍没开时也是 false，
  // 那会把「没装壳」和「壳在但没开无障碍」混成一种情况，用户就无从下手了。
  const bridgeAvailable = status.available || hasUsableBridge();
  const accessibilityReady = status.available === true;
  return {
    configEnabled: config.allowCharacterLock,
    bridgeAvailable,
    accessibilityReady,
    available: config.allowCharacterLock && bridgeAvailable && accessibilityReady,
  };
}

/** 壳里有没有锁机桥（不管无障碍开没开）。 */
function hasUsableBridge(): boolean {
  if (typeof window === "undefined") return false;
  const shell = (window as unknown as { AndroidShell?: { lockPhone?: unknown } }).AndroidShell;
  return typeof shell?.lockPhone === "function";
}

/**
 * 角色发起锁定。
 *
 * @param minutesArg 角色给的分钟数（会被夹到用户设定的上限）
 * @param reasonArg  显示在锁屏遮罩上的理由（角色说的话）
 * @param characterName 用来标注「是谁锁的」，写进来源与流水
 */
export function runCharacterLock(
  minutesArg: unknown,
  reasonArg: unknown,
  characterName?: string,
): PhoneLockOutcome {
  const config = loadPhoneLockConfig();
  if (!config.allowCharacterLock) {
    return { ok: false, reason: "TA 还没有允许角色锁机（设置 → 角色管我 → 允许角色锁机）" };
  }
  if (!hasUsableBridge()) {
    return { ok: false, reason: "当前 App 版本不支持锁机，需要更新安卓壳（1.0.33 及以上）" };
  }
  const status = getPhoneLockStatus();
  if (!status.available) {
    return {
      ok: false,
      reason: "锁机通道不可用：TA 手机上的无障碍服务没开启，锁机完全不会生效。需要去「设置 → 无障碍」把 float 打开",
    };
  }

  // 参数夹紧。角色说不清时长或给了离谱值时，**不猜一个默认值悄悄锁上**——
  // 锁机是有存在感的动作，参数不明就应当拒绝并要求它说清楚。
  const rawMinutes = Number(minutesArg);
  if (!Number.isFinite(rawMinutes) || rawMinutes <= 0) {
    return { ok: false, reason: "需要 minutes 参数（要锁多少分钟，正整数）" };
  }
  const requested = Math.round(rawMinutes);
  const capped = Math.min(requested, config.maxMinutes, PHONE_LOCK_MAX_MINUTES);
  const wasCapped = capped < requested;

  const reason = String(reasonArg ?? "").trim().slice(0, 120);
  if (!reason) {
    return { ok: false, reason: "需要 reason 参数：锁机画面上要显示一句为什么锁，不能空着" };
  }

  const who = (characterName ?? "").trim();
  const source = who ? `character:${who}`.slice(0, 80) : "character";

  const result = lockPhoneFor(capped, reason, source);
  if (!result.ok) {
    return { ok: false, reason: result.message || "锁机失败" };
  }

  // 锁上后按用户的选择把 TA 拉回学习应用。
  // 拉起失败**不算锁机失败**：锁已经生效了，两件事分开报，
  // 否则角色会以为锁没锁上，重复去锁。
  let pullBackNote = "";
  if (config.pullBackPackage) {
    const opened = openAppByPackage(config.pullBackPackage);
    pullBackNote = opened
      ? "并已把 TA 拉回学习应用"
      : "但没能自动拉起学习应用（可以提醒 TA 从桌面点开）";
  }

  const human = humanizeLockMinutes(capped);
  const message = `已锁定手机 ${human}${wasCapped ? `（你要求的 ${humanizeLockMinutes(requested)} 超过 TA 设置的上限，已按上限执行）` : ""}${pullBackNote}`;
  logLock("角色锁机", `${who || "角色"}锁了 ${human}：${reason}`);
  return { ok: true, message };
}

/**
 * 角色主动解锁。
 *
 * 用户明确要求「可以自动解锁，更像真人」，所以放开了这条路；
 * 但**必须说明理由**——理由既是给用户看的交代，也是事后可回查的依据。
 * 不做成静默解锁：真人也不会一句话不说就把人放了。
 */
export function runCharacterUnlock(
  reasonArg: unknown,
  characterName?: string,
): PhoneLockOutcome {
  const config = loadPhoneLockConfig();
  if (!config.allowCharacterLock) {
    return { ok: false, reason: "TA 还没有允许角色锁机，解锁同样不可用" };
  }
  if (!hasUsableBridge()) {
    return { ok: false, reason: "当前 App 版本不支持锁机，需要更新安卓壳" };
  }
  const status = getPhoneLockStatus();
  if (!status.locked) {
    // 没锁着时说「解开」是假话：如实说本来就没锁，别让它顺着话头编。
    return { ok: true, message: "手机当前没有处于锁定状态，不需要解锁" };
  }
  const reason = String(reasonArg ?? "").trim().slice(0, 120);
  if (!reason) {
    return { ok: false, reason: "需要 reason 参数：说明你为什么要提前把它放开" };
  }
  const who = (characterName ?? "").trim();
  const source = who ? `character:${who}`.slice(0, 80) : "character";
  const result = unlockPhone(source);
  if (!result.ok) {
    return { ok: false, reason: result.message || "解锁失败" };
  }
  logLock("角色解锁", `${who || "角色"}提前解锁：${reason}`);
  return { ok: true, message: `已提前解锁手机（理由：${reason}）` };
}

/** 读一眼锁机状态，给角色一个可解释的现场。 */
export function describePhoneLockStatus(): string {
  const status = getPhoneLockStatus();
  if (!status.available) {
    return "锁机通道不可用（无障碍服务没开启），此时锁机不会生效。";
  }
  if (!status.locked) return "手机当前没有锁定。";
  const remaining = humanizeLockMinutes(status.remainingMs / 60_000);
  const why = status.reason ? `，画面上的理由：「${status.reason}」` : "";
  const by = status.source.startsWith("character:") ? `（由${status.source.slice("character:".length)}锁的）` : "";
  return `手机正锁定中，还剩约 ${remaining}${by}${why}。`;
}

export { isPhoneLockAvailable };
