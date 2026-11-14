"use client";

// 睡前自动锁：判定与执行（唯一决策点）。
//
// 用户要的是：「到了睡觉的点，如果我还亮着屏幕在玩，就把手机锁上」。
// 针对的是他自述的气血亏、易困——熬夜是直接原因。
//
// 关键取舍（改之前先读）：
//
// ① 怎么判断「屏幕还亮着」。
//    原生**没有**提供读屏幕开合状态的桥（我查过 PerceptionBridge 与
//    DeviceActionBridge，都没有），所以不能假装能读。这里用「使用情况时间线
//    里最近有没有活动」做代理：最近 N 分钟一个前台段都没有，就当他睡了。
//    这个代理很准——真睡了手机不会有任何前台切换；但它有个已知盲区：
//    一直盯着同一个页面不动，时间线也不会刷新。所以宽容时间不能设太短
//    （默认 10 分钟），面板上也要如实告诉用户这是代理判断，不是读屏幕。
//
// ② 读不到数据时锁不锁。
//    默认锁，并如实说明「无法确认你是否还在用」。理由：这套东西要防的
//    恰恰是熬夜的人，而没给使用情况权限的用户正是最需要被拦的那批。
//    如果读不到就不锁，功能会在最该生效的场合静默失效——那比白锁一次糟得多。
//
// ③ 只锁一次。
//    锁过就记日期，同一晚不重复锁。反复锁 = 用户直接关掉功能 = 彻底失效。
//    用户自己解开过，当晚也不再锁（见 markBedtimeUserUnlock）。
//
// ④ 不在该锁的时候绝不锁。
//    时间窗支持跨天（23:00 → 06:30），窗口内的「已锁过/已解开」都从宽处理。

import { appendPerceptionLog } from "../perception/storage";
import { getPhoneLockStatus, lockPhoneFor, lockPhoneUntil, openAppByPackage } from "../phone-lock";
import { loadAppUsageTimeline, supportsUsageTimeline } from "../perception/bridge";
import { loadPhoneLockConfig } from "../device-lock/storage";
import {
  configureBedtimeLockNative,
  markBedtimeUnlockNative,
} from "./native-bridge";
import {
  loadBedtimeLockConfig,
  loadBedtimeRuntime,
  saveBedtimeRuntime,
  type BedtimeLockConfig,
} from "./storage";

/** 一次判定的结论。never 静默：任何「没锁」都要能说出为什么。 */
export type BedtimeDecision = {
  /** 现在该不该动手 */
  shouldLock: boolean;
  /** 为什么（给用户/面板看的一句话） */
  reason: string;
  /** 本应锁到什么时候（毫秒时间戳）；不该锁时为 0 */
  lockUntilMs: number;
  /** 是否属于「时间窗内」 */
  inWindow: boolean;
};

function dateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function describeBedtimeWindow(config: BedtimeLockConfig): string {
  return `${clock(config.startHour, config.startMinute)} → ${clock(config.endHour, config.endMinute)}`;
}

/**
 * 算「此刻在不在时间窗内」，并给出这一轮该锁到几点。
 *
 * 跨天支持：开始 23:00、结束 06:30 是最常见的情况，所以不能简单比较
 * 「now 是否在 start~end 之间」——那样跨天永远判不进去。
 *
 * 另外处理一种容易出错的情形：晚上 23:00 开始管，用户 23:00 前就点亮屏幕，
 * 判定发生在 23:01，这时锁到「第二天 06:30」才对，不能锁 8 小时锁到 07:01。
 */
export function evaluateBedtimeWindow(
  config: BedtimeLockConfig,
  now = Date.now(),
): { inWindow: boolean; lockUntilMs: number } {
  const cur = new Date(now);
  const startToday = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate(), config.startHour, config.startMinute, 0, 0);
  const endToday = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate(), config.endHour, config.endMinute, 0, 0);

  const startMs = startToday.getTime();
  const endMs = endToday.getTime();
  const crossesMidnight = endMs <= startMs;

  if (!crossesMidnight) {
    // 同日窗口，例如 22:00 → 23:30
    if (now >= startMs && now < endMs) return { inWindow: true, lockUntilMs: endMs };
    return { inWindow: false, lockUntilMs: 0 };
  }

  // 跨天窗口：今天的 [start, 明天 end) 与昨天的 [start, 今天 end)
  if (now >= startMs) {
    const endNext = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1, config.endHour, config.endMinute, 0, 0);
    return { inWindow: true, lockUntilMs: endNext.getTime() };
  }
  if (now < endMs) {
    // 凌晨，属于昨晚开始的那一轮
    return { inWindow: true, lockUntilMs: endMs };
  }
  return { inWindow: false, lockUntilMs: 0 };
}

/**
 * 最近 graceMinutes 分钟内有没有前台活动。
 *
 * 返回 null 表示**读不到**（没授权、壳版本低、没有时间线数据），
 * 由调用方按 lockWhenUnknown 决定怎么办。绝不返回一个假的 false。
 */
export function hasRecentActivity(graceMinutes: number, now = Date.now()): boolean | null {
  if (!supportsUsageTimeline()) return null;
  try {
    const segments = loadAppUsageTimeline(80);
    if (!segments.length) return null;
    const since = now - Math.max(1, graceMinutes) * 60_000;
    // 任何一段的结束时间落在宽容期内，就说明最近还在用手机。
    // 用 endAt 而不是「当前是否在前台」：用户切走锁屏后，最后一段的 endAt
    // 就是他离开的时刻，这正是我们要的「最后一次动手时间」。
    return segments.some(segment => segment.endAt >= since);
  } catch {
    return null;
  }
}

/** 判定此刻要不要锁。不产生任何副作用。 */
export function evaluateBedtimeLock(config: BedtimeLockConfig, now = Date.now()): BedtimeDecision {
  if (!config.enabled) {
    return { shouldLock: false, reason: "睡前自动锁没开启", lockUntilMs: 0, inWindow: false };
  }

  const window = evaluateBedtimeWindow(config, now);
  if (!window.inWindow) {
    return {
      shouldLock: false,
      reason: `现在不在管的时段内（${describeBedtimeWindow(config)}）`,
      lockUntilMs: 0,
      inWindow: false,
    };
  }

  // 已经在锁定中就不要重复下单：原生那边重新 lockPhone 会覆盖结束时间，
  // 用户看到的倒计时突然变长，像被耍了。
  const status = getPhoneLockStatus();
  if (status.locked) {
    return { shouldLock: false, reason: "手机已经处于锁定状态", lockUntilMs: 0, inWindow: true };
  }
  if (!status.available) {
    return {
      shouldLock: false,
      reason: "锁机通道不可用：无障碍服务没开启，到点也不会锁上",
      lockUntilMs: 0,
      inWindow: true,
    };
  }

  const runtime = loadBedtimeRuntime();
  const today = dateKey(now);
  if (runtime.lastLockDate === today) {
    return { shouldLock: false, reason: "今晚已经锁过一次了，不再重复", lockUntilMs: 0, inWindow: true };
  }
  if (runtime.userUnlockAt) {
    // 用户自己解开过：这一轮不再锁。
    //
    // 判据不能只看「解锁日期 === 今天」：跨天窗口下（23:00 → 06:30），
    // 凌晨 1 点解锁记的日期是**第二天**，只比日期会把这一轮误判成没解开过，
    // 于是刚解开又被锁上——那是这个功能最招人烦的失败方式。
    //
    // 所以直接问「解锁那一刻是否也处在本轮窗口内」：是，就说明用户是在
    // 这一轮里解开的，本轮不再动手。这个判断对同日窗口和跨天窗口都成立。
    const unlockWindow = evaluateBedtimeWindow(config, runtime.userUnlockAt);
    if (unlockWindow.inWindow) {
      return {
        shouldLock: false,
        reason: "你这一轮自己解开过了，不再锁",
        lockUntilMs: 0,
        inWindow: true,
      };
    }
  }

  const active = hasRecentActivity(config.idleGraceMinutes, now);
  if (active === true) {
    return {
      shouldLock: false,
      reason: `你 ${config.idleGraceMinutes} 分钟内还在用手机，先不锁（真在用就不拦第一次，只是到点提醒）`,
      lockUntilMs: 0,
      inWindow: true,
    };
  }
  if (active === null) {
    if (!config.lockWhenUnknown) {
      return {
        shouldLock: false,
        reason: "读不到你是否还在用手机（未授予使用情况访问），按你的设置没有锁",
        lockUntilMs: 0,
        inWindow: true,
      };
    }
    return {
      shouldLock: true,
      reason: "到了该睡的时间，读不到你是否还在用手机，按设置照样锁",
      lockUntilMs: window.lockUntilMs,
      inWindow: true,
    };
  }
  // active === false：最近没有活动，当他已经睡了，不锁
  return {
    shouldLock: false,
    reason: `最近 ${config.idleGraceMinutes} 分钟没有动过手机，估计已经睡了，不锁`,
    lockUntilMs: 0,
    inWindow: true,
  };
}

/**
 * 把本地配置下发给原生，让原生排闹钟。
 *
 * 这是「睡前锁到底会不会生效」的唯一开关：网页不排任何定时器。
 * 关掉时也调一次（enabled=false），原生会顺手取消已排的闹钟——
 * 不取消的话用户关了开关，半夜照样被锁，那是最糟的体验。
 */
export function syncBedtimeToNative(config?: BedtimeLockConfig): boolean {
  const cfg = config ?? loadBedtimeLockConfig();
  try {
    return configureBedtimeLockNative({
      enabled: cfg.enabled,
      startHour: cfg.startHour,
      startMinute: cfg.startMinute,
      endHour: cfg.endHour,
      endMinute: cfg.endMinute,
      reason: cfg.reason,
    });
  } catch {
    return false;
  }
}

/**
 * 打开设置面板 / App 回到前台时补一次判定。
 *
 * 为什么要这一步：原生闹钟是主力，但如果用户刚好在这个时刻正用着手机，
 * 网页侧补一次能让遮罩准时盖上，不必等下一次系统唤醒。**这只是兜底**，
 * 不能当成主链路——App 在后台时这个函数根本不会被执行。
 */
export function catchUpBedtimeLock(now = Date.now()): BedtimeLockOutcome | null {
  const config = loadBedtimeLockConfig();
  if (!config.enabled) return null;
  const decision = evaluateBedtimeLock(config, now);
  if (!decision.shouldLock) return null;
  return runBedtimeLockIfDue(now);
}

/** 一次锁机动作的结果。放在使用它的函数之前——类型虽会提升，
 *  但 eslint 的 no-use-before-define 会因此报错，别为省一行让它变红。 */
export type BedtimeLockOutcome = {
  /** 这次调用是否真的把手机锁上了 */
  locked: boolean;
  /** 一句话结果（给人看的，失败也是一整句） */
  message: string;
  /** 锁到几点（毫秒），没锁为 0 */
  lockUntilMs: number;
};

/**
 * 判定并执行。
 *
 * 这个函数是幂等的：同一晚重复调用只会锁一次。挂在 60 秒轮询里是安全的。
 */
export function runBedtimeLockIfDue(now = Date.now()): BedtimeLockOutcome {
  const config = loadBedtimeLockConfig();
  const decision = evaluateBedtimeLock(config, now);

  if (!decision.shouldLock) {
    return { locked: false, message: decision.reason, lockUntilMs: 0 };
  }

  const reason = config.reason || "这个点该睡了";
  const result = lockPhoneUntil(decision.lockUntilMs, reason, "bedtime");
  if (!result.ok) {
    const runtime = loadBedtimeRuntime();
    saveBedtimeRuntime({ ...runtime, lastOutcome: `锁机失败：${result.message || "未知原因"}` });
    return { locked: false, message: `该锁的时候没锁上：${result.message || "锁机失败"}`, lockUntilMs: 0 };
  }

  const runtime = loadBedtimeRuntime();
  saveBedtimeRuntime({
    ...runtime,
    lastLockDate: dateKey(now),
    lastLockAt: now,
    lastOutcome: `已锁到 ${clock(config.endHour, config.endMinute)}`,
  });

  // 锁上后按角色锁机那套配置把用户拉回学习应用（他主要用背单词和考点工坊）。
  // 拉起失败不算锁失败——锁已经生效了，两件事分开报。
  const characterConfig = loadPhoneLockConfig();
  if (characterConfig.pullBackPackage) {
    try { openAppByPackage(characterConfig.pullBackPackage); } catch { /* 忽略 */ }
  }

  logBedtime(`到点锁机：锁到 ${clock(config.endHour, config.endMinute)}，理由「${reason}」`);

  return {
    locked: true,
    message: `已锁到明早 ${clock(config.endHour, config.endMinute)}（${decision.reason}）`,
    lockUntilMs: decision.lockUntilMs,
  };
}

/** 用户从锁机台手动解除时调用，让今晚不再重复锁。 */
export function markBedtimeUnlockedByUser(): void {
  try {
    const config = loadBedtimeLockConfig();
    if (!config.enabled) return;
    const runtime = loadBedtimeRuntime();
    saveBedtimeRuntime({ ...runtime, userUnlockAt: Date.now(), lastOutcome: "你手动解开了" });
    // **必须同时告诉原生**：闹钟还在，下一个还会照锁。只写网页侧的记录
    // 等于没生效——这是这条链路最容易漏掉的一处。
    markBedtimeUnlockNative();
    logBedtime("用户手动解开了睡前锁，这一晚不再锁");
  } catch {
    /* 失败不影响解锁本身 */
  }
}

function logBedtime(payload: string): void {
  try {
    appendPerceptionLog({
      id: `bedtime_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      at: new Date().toISOString(),
      capability: "deviceAction",
      type: "睡前锁",
      payload: payload.slice(0, 200),
      outcome: "已执行",
    });
  } catch {
    /* 记流水失败不该影响锁机本身 */
  }
}

/** 给面板/角色的一句话现状。 */
export function describeBedtimeStatus(): string {
  const config = loadBedtimeLockConfig();
  if (!config.enabled) return "睡前自动锁未开启。";
  const runtime = loadBedtimeRuntime();
  const window = evaluateBedtimeWindow(config);
  const head = `每天 ${describeBedtimeWindow(config)} 生效`;
  const last = runtime.lastLockDate
    ? `最近一次 ${runtime.lastLockDate}（${runtime.lastOutcome || "已锁"}）`
    : "还没锁过";
  return `${head}，${window.inWindow ? "现在在管的时段内" : "现在不在管的时段"}，${last}。`;
}

/** 提前锁一次到起床时间（面板上的「现在就试一下」）。 */
export function testBedtimeLockNow(now = Date.now()): BedtimeLockOutcome {
  const config = loadBedtimeLockConfig();
  const window = evaluateBedtimeWindow(config, now);
  const until = window.inWindow && window.lockUntilMs > now
    ? window.lockUntilMs
    : now + 5 * 60_000; // 不在时段内就锁 5 分钟，够验证链路
  const status = getPhoneLockStatus();
  if (!status.available) {
    return { locked: false, message: "锁机通道不可用：无障碍服务没开启", lockUntilMs: 0 };
  }
  if (!config.enabled) {
    return { locked: false, message: "先打开总开关再试", lockUntilMs: 0 };
  }
  const result = lockPhoneFor(Math.max(1, Math.ceil((until - now) / 60_000)), config.reason || "这个点该睡了", "bedtime");
  if (!result.ok) return { locked: false, message: `没能锁上：${result.message || "锁机失败"}`, lockUntilMs: 0 };
  logBedtime("手动试锁（面板按钮）");
  return { locked: true, message: `测试锁机已生效，${window.inWindow ? "到起床时间自动解除" : "5 分钟后解除"}`, lockUntilMs: until };
}
