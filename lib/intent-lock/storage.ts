"use client";

// 「说一句，它就记着」——临时意图锁的配置与记录。
//
// 用户的原话把这套东西说清楚了：
//   「我说我要去洗澡，但是我把手机带进去玩了20分钟才开始洗澡，
//     他检测到我没有洗澡而是在玩手机就会把我手机锁了让我去洗澡」
//
// 所以他真正要的不是「动作队列」（按顺序执行几个动作），而是：
//   ① 用户用一句话说出一件即将要去做的事；
//   ② 记住它，到点看看手机还在不在被使用；
//   ③ 还在用 → 锁，让他去做那件事；
//   ④ 做完了打卡 → 立刻解开，并且让角色知道「他是主动做完的」。
//
// 为什么叫「意图」，不叫「任务」或「待办」：
//   待办是**我该做但可能不做**的事，需要被追踪、被催促、被统计完成率；
//   这里是**我马上就去做**的事，只要一小段时间的看守就够了。
//   做成待办清单会立刻膨胀成一个任务管理器，那是另一个产品，
//   而且用户已经明确说过不要（他回的是「要么及时触发，要么加个临时取消」）。
//
// 三个来自用户的硬约束（改之前先读）：
//   · 一刀切。不判断"你在用什么应用所以算不算玩"——说了去做事，那段时间除了
//     你自己填的放行清单，一律算玩。用户原话：「最好的办法是一刀切，完全专注」。
//   · 默认时长尽量短。推测出来的时长宁可短，不够再续；长了就是折磨。
//   · 有事耽搁了就不锁。过了有效窗口就作废，不攒着、不秋后算账。

import { kvGet, kvSet, registerKvMigration } from "../kv-db";

const CONFIG_KEY = "ai_phone_intent_lock_config_v1";
const RECORDS_KEY = "ai_phone_intent_lock_records_v1";
registerKvMigration(CONFIG_KEY);
registerKvMigration(RECORDS_KEY);

/** 配置变更事件：面板与角色侧都据此刷新。 */
export const INTENT_LOCK_CONFIG_EVENT = "intent-lock-config-changed";
/** 记录变更事件（新建 / 锁定 / 打卡 / 取消）。 */
export const INTENT_LOCK_RECORDS_EVENT = "intent-lock-records-changed";

export type IntentLockConfig = {
  /** 总开关。默认关——会锁手机的东西都得用户自己开。 */
  enabled: boolean;
  /**
   * 用户没说时长时，默认锁多少分钟。
   *
   * 用户明确要求「尽量短」：推测的时长长了会变成折磨，
   * 短了他洗完了还没锁完，自己打卡就能解开（见 markIntentDone）。
   */
  defaultMinutes: number;
  /**
   * 说完之后等多久才开始检查（分钟）。
   *
   * 这是「给他一点时间真的去做」的缓冲：说了去洗澡，总得先走两步、
   * 放个水，不可能一秒就把手机放下。设 0 会立刻判他"还在玩"。
   */
  graceMinutes: number;
  /**
   * 意图的存活窗口（分钟）：说了之后超过这么久还没触发检查，就作废。
   *
   * 对应「中途有事耽搁了就不锁了，等下一次开始再触发」——
   * 不攒着旧意图秋后算账，那是让人莫名其妙被锁的主要原因。
   */
  expireMinutes: number;
  /**
   * 放行清单（float 内部应用名）+ 放行包名（真实应用）。
   *
   * 用户的选择是：**默认空**，让他自己填。
   * 空 = 一刀切，除了电话/桌面/系统设置全锁，包括学习应用——
   * 「洗澡就洗澡，出来再听歌不行吗」。
   */
  allowInnerApps: string[];
  allowPackages: string[];
};

export const INTENT_LOCK_DEFAULTS: IntentLockConfig = {
  enabled: false,
  defaultMinutes: 20,
  graceMinutes: 5,
  expireMinutes: 120,
  allowInnerApps: [],
  allowPackages: [],
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item ?? "").trim()).filter(Boolean).slice(0, 60);
}

export function loadIntentLockConfig(): IntentLockConfig {
  try {
    const raw = kvGet(CONFIG_KEY);
    if (!raw) return { ...INTENT_LOCK_DEFAULTS, allowInnerApps: [], allowPackages: [] };
    const parsed = JSON.parse(raw) as Partial<IntentLockConfig>;
    return {
      enabled: parsed.enabled === true,
      // 上限 120 分钟：再长就不叫「临时」了，那是角色锁机的活
      defaultMinutes: clampInt(parsed.defaultMinutes, 1, 120, INTENT_LOCK_DEFAULTS.defaultMinutes),
      graceMinutes: clampInt(parsed.graceMinutes, 0, 60, INTENT_LOCK_DEFAULTS.graceMinutes),
      expireMinutes: clampInt(parsed.expireMinutes, 10, 720, INTENT_LOCK_DEFAULTS.expireMinutes),
      allowInnerApps: cleanList(parsed.allowInnerApps),
      allowPackages: cleanList(parsed.allowPackages),
    };
  } catch {
    return { ...INTENT_LOCK_DEFAULTS, allowInnerApps: [], allowPackages: [] };
  }
}

export function saveIntentLockConfig(config: IntentLockConfig): void {
  kvSet(CONFIG_KEY, JSON.stringify(config));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(INTENT_LOCK_CONFIG_EVENT));
  }
}

/**
 * 一个意图的生命周期。
 *
 * 刻意把「被锁着做完」和「主动打卡完成」分成两个状态：
 * 角色对这两件事的反应应该完全不同——前者是"我拦住了你"，
 * 后者是"你自己做到了"。混成一个 done，角色就没法区分该夸还是该讲道理。
 */
export type IntentStatus =
  /** 已记下，还没到检查时刻 */
  | "pending"
  /** 到点检查发现还在用手机，已锁上 */
  | "locked"
  /** 用户主动打卡说他做完了 */
  | "done"
  /** 用户取消（计划有变） */
  | "cancelled"
  /** 过了有效窗口还没触发，作废 */
  | "expired"
  /** 到点检查发现手机没在动，估计他真去做了，不锁 */
  | "skipped"
  /** 想锁但锁不上（无障碍没开等），如实记录 */
  | "failed";

export type IntentRecord = {
  id: string;
  /** 用户原话说的那件事，如「去洗澡」。原话保存，别改写。 */
  title: string;
  /** 由谁记下：角色在对话里记的，还是用户自己在面板上加的 */
  createdBy: "character" | "user";
  /** 是哪个角色记的（用于事后让角色来问一句） */
  characterId?: string;
  /** 来自哪个会话：解锁后角色要在这里说话 */
  sessionId?: string;
  createdAt: number;
  /** 什么时候开始检查（createdAt + graceMinutes） */
  checkAt: number;
  /** 超过这个时刻还没结算就作废 */
  expireAt: number;
  /** 真要锁的话锁多久 */
  lockMinutes: number;
  status: IntentStatus;
  /** 状态最后一次变化的时间 */
  updatedAt: number;
  /** 结算时的一句话（给人看，也给角色看） */
  note?: string;
  /** 锁到几点（锁上后才有） */
  lockUntil?: number;
  /** 打卡完成时间 */
  doneAt?: number;
};

/** 只保留最近这些条：这是短期看守，不是档案。 */
const MAX_RECORDS = 200;
/** 结算超过这么久的记录就不再显示在主列表里（保留用于统计） */
export const INTENT_VISIBLE_HOURS = 48;

export function loadIntentRecords(): IntentRecord[] {
  try {
    const raw = kvGet(RECORDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is IntentRecord => {
        if (!item || typeof item !== "object") return false;
        const record = item as IntentRecord;
        return typeof record.id === "string"
          && typeof record.title === "string"
          && typeof record.status === "string"
          && Number.isFinite(record.createdAt);
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export function saveIntentRecords(records: IntentRecord[]): void {
  kvSet(RECORDS_KEY, JSON.stringify(records.slice(0, MAX_RECORDS)));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(INTENT_LOCK_RECORDS_EVENT));
  }
}

/** 还没结束的意图（pending / locked），面板与判定都用它。 */
export function loadOpenIntents(): IntentRecord[] {
  return loadIntentRecords().filter(item => item.status === "pending" || item.status === "locked");
}

/**
 * 今天已经真的锁了几次。
 *
 * **只用于显示，不用于限制。**
 * 用户明确否掉了「每日上限」（原话：我就是需要它管我所以我才要他锁）。
 * 留这个函数是因为健康系统面板要给他看"这周它管了我几次"——
 * 那是让人判断这套东西有没有用的依据，不是刹车。
 */
export function countTodayLocks(now = Date.now()): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const since = start.getTime();
  return loadIntentRecords().filter(item => (
    (item.status === "locked" || item.status === "done")
    && Number(item.lockUntil) > 0
    && item.updatedAt >= since
  )).length;
}
