"use client";

// 睡前自动锁的配置。
//
// 为什么不塞进 device-lock/storage：
//   · device-lock 管的是「角色可以锁我」这层授权，发起方是角色；
//     这里管的是「到点自己锁自己」，发起方是作息本身。两者授权语义完全不同——
//     把「允许角色锁机」和「每天半夜自动锁」混在一个开关下，用户根本想不到
//     自己开的是哪一件；
//   · 锁机是一次性的（锁 N 分钟就完了），睡前锁是周期性的（每天到点），
//     边界条件完全不一样：跨天、重复触发、手动解锁后当天不再锁……
//   · 混写迟早出岔子，而这个东西一出岔子就是半夜手机被锁、用户气的不是
//     「功能不好用」而是「这破东西还管到我头上」。
//
// 用户的原话是「到点 + 屏幕还亮着就锁」，针对的是熬夜伤气血。
// 所以他真正要的不是「强制睡觉」，是**在他本来该睡、却还在刷手机的那一刻拦一下**。
// 这决定了两个设计：到点发现没在用手机就不锁、自己解锁过一次当天就不再烦他。

import { kvGet, kvSet, registerKvMigration } from "../kv-db";

const CONFIG_KEY = "ai_phone_bedtime_lock_config_v1";
registerKvMigration(CONFIG_KEY);

/** 「到点」的默认时间：23:00。 */
export const BEDTIME_DEFAULT_START = { hour: 23, minute: 0 };
/** 起床解锁的默认时间：06:30。 */
export const BEDTIME_DEFAULT_END = { hour: 6, minute: 30 };

export type BedtimeLockConfig = {
  /** 总开关。默认关——半夜自动锁手机这种事，必须用户自己开。 */
  enabled: boolean;
  /** 几点开始管（本地时区） */
  startHour: number;
  startMinute: number;
  /** 几点解锁（可以早于开始时间，表示跨天，如 23:00 → 6:30） */
  endHour: number;
  endMinute: number;
  /**
   * 到点后如果发现「最近这么多分钟内手机毫无活动」，就当他已经睡了，不锁。
   *
   * 这是「屏幕还亮着才锁」的落地方式。原生目前没有提供读屏幕开合状态的桥，
   * 所以我们用使用时间线做代理判断——**这一点必须在面板上说清楚**，
   * 不能让用户以为我们在读屏幕。
   */
  idleGraceMinutes: number;
  /**
   * 读不到使用记录时怎么处理。
   *
   * true（默认）= 照锁，并如实说明「无法确认你是否还在用」。
   * 理由：用户开这个功能是为了防熬夜，读不到状态恰恰是最容易熬的那批人
   * （没给「使用情况访问」权限）。宁可他睡了被白锁一次，也不要他通宵。
   */
  lockWhenUnknown: boolean;
  /** 锁机遮罩上显示的理由 */
  reason: string;
  /** 是否在锁上时给一条本地通知（壳不支持时静默跳过） */
  notifyOnLock: boolean;
};

export const BEDTIME_LOCK_DEFAULTS: BedtimeLockConfig = {
  enabled: false,
  startHour: BEDTIME_DEFAULT_START.hour,
  startMinute: BEDTIME_DEFAULT_START.minute,
  endHour: BEDTIME_DEFAULT_END.hour,
  endMinute: BEDTIME_DEFAULT_END.minute,
  idleGraceMinutes: 10,
  lockWhenUnknown: true,
  // 文案默认写成它该有的语气：不是惩罚，是拦一下。
  // 用户明确要求过「不许当惩罚威胁」，所以默认就不带威胁词。
  reason: "这个点该睡了。明天还要看书，先把手机放下",
  notifyOnLock: true,
};

/** 默认锁机理由（用户清空输入框时回退到它，不能空着——遮罩必须有话说）。 */
export const BEDTIME_FALLBACK_REASON = BEDTIME_LOCK_DEFAULTS.reason;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function loadBedtimeLockConfig(): BedtimeLockConfig {
  try {
    const raw = kvGet(CONFIG_KEY);
    if (!raw) return { ...BEDTIME_LOCK_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<BedtimeLockConfig>;
    return {
      enabled: parsed.enabled === true,
      startHour: clampInt(parsed.startHour, 0, 23, BEDTIME_LOCK_DEFAULTS.startHour),
      startMinute: clampInt(parsed.startMinute, 0, 59, BEDTIME_LOCK_DEFAULTS.startMinute),
      endHour: clampInt(parsed.endHour, 0, 23, BEDTIME_LOCK_DEFAULTS.endHour),
      endMinute: clampInt(parsed.endMinute, 0, 59, BEDTIME_LOCK_DEFAULTS.endMinute),
      // 宽容时间上限 120 分钟：再长就不叫「睡前锁」了，白天会被误触发
      idleGraceMinutes: clampInt(parsed.idleGraceMinutes, 1, 120, BEDTIME_LOCK_DEFAULTS.idleGraceMinutes),
      lockWhenUnknown: parsed.lockWhenUnknown !== false,
      reason: (typeof parsed.reason === "string" && parsed.reason.trim())
        ? parsed.reason.trim().slice(0, 120)
        : BEDTIME_LOCK_DEFAULTS.reason,
      notifyOnLock: parsed.notifyOnLock !== false,
    };
  } catch {
    return { ...BEDTIME_LOCK_DEFAULTS };
  }
}

export function saveBedtimeLockConfig(config: BedtimeLockConfig): void {
  kvSet(CONFIG_KEY, JSON.stringify(config));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("bedtime-lock-config-changed"));
  }
}

// ── 运行态：什么时候锁过、用户什么时候自己解开过 ──
//
// 单独存一份而不是塞进配置：这两个是状态不是设置，
// 混进配置会让「改个时间」这种动作意外重置「今天已经锁过了」。

const RUNTIME_KEY = "ai_phone_bedtime_lock_runtime_v1";
registerKvMigration(RUNTIME_KEY);

export type BedtimeLockRuntime = {
  /** 最近一次真的锁上的日期（YYYY-MM-DD，锁机开始那天） */
  lastLockDate: string;
  /** 最近一次锁上的时间戳 */
  lastLockAt: number;
  /**
   * 用户手动解开的时间戳。
   *
   * 用来实现「你解开过一次，今晚就不再来烦你」——被同一个东西反复锁住，
   * 换谁都会直接把这个功能关掉，那还不如不做。
   */
  userUnlockAt: number;
  /** 昨晚是不是真的锁了（面板显示用，也避免虚报成功） */
  lastOutcome: string;
};

export const BEDTIME_RUNTIME_DEFAULTS: BedtimeLockRuntime = {
  lastLockDate: "",
  lastLockAt: 0,
  userUnlockAt: 0,
  lastOutcome: "",
};

export function loadBedtimeRuntime(): BedtimeLockRuntime {
  try {
    const raw = kvGet(RUNTIME_KEY);
    if (!raw) return { ...BEDTIME_RUNTIME_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<BedtimeLockRuntime>;
    return {
      lastLockDate: typeof parsed.lastLockDate === "string" ? parsed.lastLockDate : "",
      lastLockAt: Number(parsed.lastLockAt) || 0,
      userUnlockAt: Number(parsed.userUnlockAt) || 0,
      lastOutcome: typeof parsed.lastOutcome === "string" ? parsed.lastOutcome : "",
    };
  } catch {
    return { ...BEDTIME_RUNTIME_DEFAULTS };
  }
}

export function saveBedtimeRuntime(runtime: BedtimeLockRuntime): void {
  kvSet(RUNTIME_KEY, JSON.stringify(runtime));
}

/** 记下「用户自己解开了」，供今晚不再锁用。 */
export function markBedtimeUserUnlock(): void {
  const runtime = loadBedtimeRuntime();
  saveBedtimeRuntime({ ...runtime, userUnlockAt: Date.now() });
}
