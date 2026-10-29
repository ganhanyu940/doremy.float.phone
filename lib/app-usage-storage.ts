// lib/app-usage-storage.ts
// 屏幕时间：记录这部「虚拟手机」里每个 APP 的使用时长。
//
// 设计要点：
//  1. 数据按「天 × APP」聚合存（不是原始会话流水），30 天滚动保留，
//     整份 JSON 只有几十 KB，不占配额、也不拖慢启动。
//  2. 一次「打开 APP」= 一个会话。会话在切到别的 APP、返回桌面、页面隐藏、
//     定时器到点这四个时机结算成一段时长；页面隐藏（切后台/锁屏）期间不累计，
//     否则放着不管一晚上会凭空多出几小时。
//  3. 定时结算（15s）是防丢兜底：浏览器被强杀时最多丢最后 15 秒。
//  4. 全部读写走 kv-db（IndexedDB + 内存缓存），和宿主其他本地数据一致。

import { ICONS } from "@/lib/desktop-config";
import { customAppIdFromIconId } from "@/lib/custom-app-types";
import { kvGet, kvSet, registerKvMigration } from "@/lib/kv-db";

export const APP_USAGE_STORAGE_KEY = "ai_phone_app_usage_v1";
/** 只保留最近多少天的数据 */
export const APP_USAGE_RETENTION_DAYS = 30;

/** 短于这个长度的片段不计（避免误触留下的 0 秒记录） */
const MIN_SEGMENT_MS = 800;
/** 定时结算间隔：浏览器被强杀时最多丢这么久 */
const FLUSH_INTERVAL_MS = 15_000;

registerKvMigration(APP_USAGE_STORAGE_KEY);

export type AppUsageEntry = {
  /** 图标 id（内置 APP 即 IconId，自定义 APP 为 custom_app:xxx） */
  id: string;
  /** 展示名：取自最近一次记录，改名后自动跟着更新 */
  name: string;
  ms: number;
  opens: number;
};

export type AppUsageDay = {
  date: string; // YYYY-MM-DD（本地时区）
  apps: Record<string, { name: string; ms: number; opens: number }>;
};

export type AppUsageStore = {
  version: 1;
  days: Record<string, AppUsageDay>;
};

export type AppUsageIdentity = { appId: string; appName: string };

export type AppUsageSession = {
  /** 结束本次会话并结算最后一段时长；可重复调用 */
  dispose: () => void;
  /** 本次会话已计入的时长（毫秒，不含隐藏期间） */
  getElapsedMs: () => number;
};

/* ═══════════════════════════════════════════
   日期与格式化
   ═══════════════════════════════════════════ */

/** 本地时区的日期键：YYYY-MM-DD（不能用 toISOString，那是 UTC，会跨天错位） */
export function localDayKey(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dayKeyToDate(dayKey: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 从 endDate 往前数 count 天的日期键（升序，最后一个是 endDate 当天） */
export function recentDayKeys(count: number, endDate: Date = new Date()): string[] {
  const keys: string[] = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const date = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
    date.setDate(date.getDate() - offset);
    keys.push(localDayKey(date));
  }
  return keys;
}

export function shiftDayKey(dayKey: string, deltaDays: number): string {
  const date = dayKeyToDate(dayKey);
  if (!date) return dayKey;
  date.setDate(date.getDate() + deltaDays);
  return localDayKey(date);
}

/** 「1 小时 23 分」「23 分 5 秒」「42 秒」「不到 1 秒」 */
export function formatUsageDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 秒";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 1) return "不到 1 秒";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  if (minutes > 0) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  return `${seconds} 秒`;
}

/** 排行里用的紧凑写法：「2h14m」「14m」「38s」 */
export function formatUsageDurationCompact(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours}h${String(minutes).padStart(2, "0")}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.max(1, totalSeconds)}s`;
}

/** 图表/条形图的友好时间：「3h42m」 → 轴上用不到那么细，直接复用 compact */
export const formatUsageAxisLabel = formatUsageDurationCompact;

/* ═══════════════════════════════════════════
   读写
   ═══════════════════════════════════════════ */

function emptyStore(): AppUsageStore {
  return { version: 1, days: {} };
}

function normalizeStore(raw: unknown): AppUsageStore {
  const store = emptyStore();
  if (!raw || typeof raw !== "object") return store;
  const daysRaw = (raw as { days?: unknown }).days;
  if (!daysRaw || typeof daysRaw !== "object") return store;

  for (const [dayKey, value] of Object.entries(daysRaw as Record<string, unknown>)) {
    if (!dayKeyToDate(dayKey)) continue;
    if (!value || typeof value !== "object") continue;
    const appsRaw = (value as { apps?: unknown }).apps;
    if (!appsRaw || typeof appsRaw !== "object") continue;
    const apps: AppUsageDay["apps"] = {};
    for (const [appId, entryRaw] of Object.entries(appsRaw as Record<string, unknown>)) {
      if (!appId) continue;
      if (!entryRaw || typeof entryRaw !== "object") continue;
      const entry = entryRaw as { name?: unknown; ms?: unknown; opens?: unknown };
      const ms = Number(entry.ms);
      const opens = Number(entry.opens);
      apps[appId] = {
        name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : appId,
        ms: Number.isFinite(ms) && ms > 0 ? ms : 0,
        opens: Number.isFinite(opens) && opens > 0 ? Math.round(opens) : 0
      };
    }
    store.days[dayKey] = { date: dayKey, apps };
  }
  return store;
}

/** 丢掉超过保留窗口的旧数据（就地修改并返回同一个对象） */
export function pruneAppUsageStore(store: AppUsageStore, now: Date = new Date()): AppUsageStore {
  const keep = new Set(recentDayKeys(APP_USAGE_RETENTION_DAYS, now));
  for (const dayKey of Object.keys(store.days)) {
    if (!keep.has(dayKey)) delete store.days[dayKey];
  }
  return store;
}

export function loadAppUsageStore(): AppUsageStore {
  if (typeof window === "undefined") return emptyStore();
  const raw = kvGet(APP_USAGE_STORAGE_KEY);
  if (!raw) return emptyStore();
  try {
    return normalizeStore(JSON.parse(raw));
  } catch {
    return emptyStore();
  }
}

export function saveAppUsageStore(store: AppUsageStore): void {
  if (typeof window === "undefined") return;
  pruneAppUsageStore(store);
  kvSet(APP_USAGE_STORAGE_KEY, JSON.stringify(store));
}

/** 把一段时长记进「某天 · 某 APP」的累计里 */
export function recordAppUsageSegment(params: {
  appId: string;
  appName: string;
  ms: number;
  opens: number;
  at?: number;
}): void {
  const { appId, appName } = params;
  if (!appId) return;
  const ms = Number.isFinite(params.ms) && params.ms > 0 ? Math.round(params.ms) : 0;
  const opens = Number.isFinite(params.opens) && params.opens > 0 ? Math.round(params.opens) : 0;
  if (ms <= 0 && opens <= 0) return;

  const at = new Date(params.at ?? Date.now());
  const dayKey = localDayKey(at);
  const store = loadAppUsageStore();
  const day = store.days[dayKey] ?? { date: dayKey, apps: {} };
  const current = day.apps[appId] ?? { name: appName, ms: 0, opens: 0 };
  current.name = appName || current.name;
  current.ms += ms;
  current.opens += opens;
  day.apps[appId] = current;
  store.days[dayKey] = day;
  saveAppUsageStore(store);
}

/* ═══════════════════════════════════════════
   会话计时
   ═══════════════════════════════════════════ */

function noopSession(): AppUsageSession {
  return { dispose: () => {}, getElapsedMs: () => 0 };
}

/**
 * 开始计一个 APP 的本次使用会话。
 * 调用方在 APP 打开时调用、在离开（切 APP / 返回桌面 / 卸载组件）时 dispose。
 */
export function startAppUsageSession(identity: AppUsageIdentity): AppUsageSession {
  if (typeof window === "undefined") return noopSession();
  const appId = identity.appId;
  if (!appId) return noopSession();
  const appName = identity.appName || appId;

  let segmentStart = Date.now();
  let countedMs = 0;
  let pendingOpens = 1; // 会话第一段结算时记一次「打开」
  let disposed = false;

  const settle = (now: number) => {
    const delta = Math.max(0, now - segmentStart);
    segmentStart = now;
    const opens = pendingOpens;
    pendingOpens = 0;
    // 太短的一段按 0 计：误触留下 200ms 不该变成「不到 1 秒」的噪声记录，
    // 但「打开次数」照记——那是真实发生过的一次点击。
    const ms = delta >= MIN_SEGMENT_MS ? delta : 0;
    if (ms <= 0 && opens === 0) return;
    countedMs += ms;
    recordAppUsageSegment({ appId, appName, ms, opens, at: now });
  };

  const handleVisibility = () => {
    if (disposed) return;
    if (document.visibilityState === "hidden") {
      // 切后台/锁屏：把已计的时间落下，隐藏期间不再累加
      settle(Date.now());
    } else {
      segmentStart = Date.now();
    }
  };

  const handlePageHide = () => {
    if (disposed) return;
    settle(Date.now());
  };

  const timer = window.setInterval(() => {
    if (disposed || document.visibilityState === "hidden") return;
    settle(Date.now());
  }, FLUSH_INTERVAL_MS);

  document.addEventListener("visibilitychange", handleVisibility);
  window.addEventListener("pagehide", handlePageHide);

  return {
    dispose: () => {
      if (disposed) return;
      settle(Date.now());
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", handlePageHide);
    },
    getElapsedMs: () => countedMs + (disposed || document.visibilityState === "hidden" ? 0 : Date.now() - segmentStart)
  };
}

/* ═══════════════════════════════════════════
   名字解析与查询
   ═══════════════════════════════════════════ */

/** 图标 id → { appId, appName }；appId 直接用图标 id，天然唯一 */
export function resolveAppUsageIdentity(
  iconId: string,
  customApps: Array<{ id: string; name: string }> = []
): AppUsageIdentity {
  const customId = customAppIdFromIconId(iconId);
  if (customId) {
    const app = customApps.find(item => item.id === customId);
    const name = app?.name?.trim();
    return { appId: iconId, appName: name || "自定义 APP" };
  }
  const meta = (ICONS as Record<string, { label?: string } | undefined>)[iconId];
  return { appId: iconId, appName: meta?.label || iconId };
}

/** 某天各 APP 的使用记录，按时长从多到少 */
export function readAppUsageEntries(store: AppUsageStore, dayKey: string): AppUsageEntry[] {
  const day = store.days[dayKey];
  if (!day) return [];
  return Object.entries(day.apps)
    .map(([id, entry]) => ({ id, name: entry.name, ms: entry.ms, opens: entry.opens }))
    .filter(entry => entry.ms > 0 || entry.opens > 0)
    .sort((a, b) => b.ms - a.ms);
}

export function readAppUsageTotal(store: AppUsageStore, dayKey: string): number {
  const day = store.days[dayKey];
  if (!day) return 0;
  return Object.values(day.apps).reduce((sum, entry) => sum + entry.ms, 0);
}

export function readAppUsageOpens(store: AppUsageStore, dayKey: string): number {
  const day = store.days[dayKey];
  if (!day) return 0;
  return Object.values(day.apps).reduce((sum, entry) => sum + entry.opens, 0);
}

/** 近 N 天每天的总时长，用于柱状图 */
export function readDailyTotals(store: AppUsageStore, dayKeys: string[]): Array<{ dayKey: string; ms: number }> {
  return dayKeys.map(dayKey => ({ dayKey, ms: readAppUsageTotal(store, dayKey) }));
}

export const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"] as const;

export function weekdayLabel(dayKey: string): string {
  const date = dayKeyToDate(dayKey);
  return date ? WEEKDAY_LABELS[date.getDay()] : "";
}

/** 「7月8日」；今天/昨天返回口语说法 */
export function dayDisplayLabel(dayKey: string, todayKey: string = localDayKey()): string {
  if (dayKey === todayKey) return "今天";
  if (dayKey === shiftDayKey(todayKey, -1)) return "昨天";
  const date = dayKeyToDate(dayKey);
  if (!date) return dayKey;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}
