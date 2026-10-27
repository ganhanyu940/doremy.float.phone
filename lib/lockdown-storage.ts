// lib/lockdown-storage.ts
//
// 「锁机」的本地存储层：配置 + 当前锁定状态 + 历史。
//
// 产品定位（改这个文件前先读）：
//   这是**用户自己**请求角色管住自己的一套自律工具，不是角色单方面控制用户的
//   监控装置。因此三条边界必须守住：
//   1. 用户永远有最终开关：设置里可以随时关掉「允许角色锁机」，关掉即当次锁定
//      立即解除（见 engine 的 releaseLockdown 调用点）。
//   2. 房间里有闸：单次时长上限、锁定范围、豁免应用都由用户先定好，角色只能在
//      用户给的范围内提要求，越界的一律按上限收窄，绝不照单全收。
//   3. 一切都记在本地：锁定状态、历史都在 kv 里，不经网络、不上云。
//
// 存储用 kv-db（IndexedDB 后端 + 同步内存缓存），与其它设置模块一致：读是同步的，
// 写是同步 + 异步落盘，页面刷新不丢。

import { kvGet, kvSet } from "./kv-db";

export type LockdownUnlockMode = "timer" | "confirm";

/** 锁定范围。三者可叠加：虚拟手机锁屏 + 真机全屏封锁 + 指定应用封锁 */
export type LockdownScope = {
    /** 小手机界面被全屏锁屏盖住 */
    virtual: boolean;
    /** 真机其他 App 也被原生全屏浮层盖住（需浮窗权限） */
    device: boolean;
    /** 只封指定应用（需无障碍 + 浮窗权限） */
    apps: boolean;
};

export type LockdownState = {
    id: string;
    /** 发起锁定的角色 */
    characterId: string;
    characterName: string;
    /** 角色留的话（可为空，纯计时锁机时通常为空） */
    message: string;
    /** 时长（分钟）。0 = 没有倒计时，只能由用户确认解锁 */
    durationMinutes: number;
    startedAt: number;
    /** 到点时间；durationMinutes=0 时为 0 */
    endsAt: number;
    unlockMode: LockdownUnlockMode;
    scope: LockdownScope;
    /** 被封锁的应用显示名（原生侧按 label 匹配包名） */
    apps: string[];
    /** 用户提前放行的时间（先点过「我记住了」）；0 = 没点过 */
    confirmedAt?: number;
};

export type LockdownHistoryEntry = {
    id: string;
    characterId: string;
    characterName: string;
    message: string;
    durationMinutes: number;
    startedAt: number;
    endedAt: number;
    /** 怎么结束的：倒计时到点 / 用户确认 / 用户关闭功能 / 手动解除 */
    endedBy: "timer" | "confirm" | "manual";
};

export type LockdownSettings = {
    /** 总开关：关掉后角色发来的锁机请求一律忽略，当场锁定也会解除 */
    enabled: boolean;
    /** 允许角色锁小手机界面 */
    allowVirtual: boolean;
    /** 允许角色锁真机（其他 App 也被盖住） */
    allowDevice: boolean;
    /** 允许角色只封指定应用 */
    allowAppLock: boolean;
    /** 单次时长上限（分钟），角色要求的时长会被收窄到这个值 */
    maxDurationMinutes: number;
    /** 允许用户点「我记住了」提前结束倒计时（关掉 = 只能等时间到） */
    allowEarlyRelease: boolean;
    /** 豁免应用（永不封锁，如电话、信息） */
    exemptApps: string[];
    /** 角色的留言是否在锁屏上显示（关掉只显示倒计时） */
    showMessage: boolean;
};

const STATE_KEY = "lockdown-state-v1";
const SETTINGS_KEY = "lockdown-settings-v1";
const HISTORY_KEY = "lockdown-history-v1";
const MAX_HISTORY = 60;

export const LOCKDOWN_UPDATED_EVENT = "lockdown-updated";

/** 默认豁免：断网也还要能打电话。用户在设置里可以继续加。 */
const DEFAULT_EXEMPT_APPS = ["电话", "信息", "设置", "相机"];

export const DEFAULT_LOCKDOWN_SETTINGS: LockdownSettings = {
    enabled: true,
    allowVirtual: true,
    allowDevice: true,
    allowAppLock: true,
    maxDurationMinutes: 180,
    allowEarlyRelease: true,
    exemptApps: [...DEFAULT_EXEMPT_APPS],
    showMessage: true,
};

function notifyUpdated(): void {
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(LOCKDOWN_UPDATED_EVENT));
    }
}

function clampDuration(minutes: number, settings: LockdownSettings): number {
    if (!Number.isFinite(minutes) || minutes <= 0) return 0;
    return Math.min(Math.round(minutes), Math.max(1, settings.maxDurationMinutes));
}

function normalizeAppName(value: unknown): string {
    return typeof value === "string" ? value.trim().slice(0, 40) : "";
}

// ── 设置 ──

export function loadLockdownSettings(): LockdownSettings {
    try {
        const raw = kvGet(SETTINGS_KEY);
        if (!raw) return { ...DEFAULT_LOCKDOWN_SETTINGS, exemptApps: [...DEFAULT_EXEMPT_APPS] };
        const parsed = JSON.parse(raw) as Partial<LockdownSettings>;
        const maxDuration = Number(parsed.maxDurationMinutes);
        return {
            enabled: parsed.enabled !== false,
            allowVirtual: parsed.allowVirtual !== false,
            allowDevice: parsed.allowDevice !== false,
            allowAppLock: parsed.allowAppLock !== false,
            maxDurationMinutes: Number.isFinite(maxDuration)
                ? Math.min(Math.max(Math.round(maxDuration), 1), 720)
                : DEFAULT_LOCKDOWN_SETTINGS.maxDurationMinutes,
            allowEarlyRelease: parsed.allowEarlyRelease !== false,
            exemptApps: Array.isArray(parsed.exemptApps)
                ? parsed.exemptApps.map(normalizeAppName).filter(Boolean).slice(0, 30)
                : [...DEFAULT_EXEMPT_APPS],
            showMessage: parsed.showMessage !== false,
        };
    } catch {
        return { ...DEFAULT_LOCKDOWN_SETTINGS, exemptApps: [...DEFAULT_EXEMPT_APPS] };
    }
}

export function saveLockdownSettings(settings: LockdownSettings): void {
    kvSet(SETTINGS_KEY, JSON.stringify(settings));
    notifyUpdated();
}

// ── 当前锁定状态 ──

function normalizeScope(raw: unknown, settings: LockdownSettings): LockdownScope {
    const value = (raw ?? {}) as Partial<LockdownScope>;
    // 用户没允许的范围一律置空：角色在标签里写什么都不作数。
    return {
        virtual: settings.allowVirtual && value.virtual !== false,
        device: settings.allowDevice && value.device === true,
        apps: settings.allowAppLock && value.apps === true,
    };
}

export function loadLockdownState(): LockdownState | null {
    try {
        const raw = kvGet(STATE_KEY);
        if (!raw) return null;
        const settings = loadLockdownSettings();
        const parsed = JSON.parse(raw) as Partial<LockdownState>;
        if (!parsed || typeof parsed.startedAt !== "number") return null;
        const durationMinutes = clampDuration(Number(parsed.durationMinutes) || 0, settings);
        const apps = Array.isArray(parsed.apps)
            ? parsed.apps.map(normalizeAppName).filter(Boolean).slice(0, 40)
            : [];
        return {
            id: typeof parsed.id === "string" && parsed.id ? parsed.id : `lk_${parsed.startedAt}`,
            characterId: typeof parsed.characterId === "string" ? parsed.characterId : "",
            characterName: typeof parsed.characterName === "string" ? parsed.characterName : "角色",
            message: typeof parsed.message === "string" ? parsed.message.slice(0, 600) : "",
            durationMinutes,
            startedAt: parsed.startedAt,
            endsAt: typeof parsed.endsAt === "number" ? parsed.endsAt : 0,
            unlockMode: parsed.unlockMode === "confirm" ? "confirm" : "timer",
            scope: normalizeScope(parsed.scope, settings),
            apps,
            confirmedAt: typeof parsed.confirmedAt === "number" ? parsed.confirmedAt : 0,
        };
    } catch {
        return null;
    }
}

export function saveLockdownState(state: LockdownState | null): void {
    if (state) kvSet(STATE_KEY, JSON.stringify(state));
    else kvSet(STATE_KEY, "");
    notifyUpdated();
}

// ── 历史 ──

export function loadLockdownHistory(): LockdownHistoryEntry[] {
    try {
        const raw = kvGet(HISTORY_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((item): item is LockdownHistoryEntry =>
                !!item && typeof item === "object" && typeof (item as LockdownHistoryEntry).endedAt === "number")
            .slice(0, MAX_HISTORY);
    } catch {
        return [];
    }
}

export function appendLockdownHistory(entry: LockdownHistoryEntry): void {
    const current = loadLockdownHistory();
    // 同一次锁定只记一条：结算会在多个入口被调用（锁屏层、后台守望、原生回传），
    // React StrictMode 下初始化的副作用也会跑两遍，重复写入会让「记录」莫名其妙变多。
    if (current.some(item => item.id === entry.id)) return;
    kvSet(HISTORY_KEY, JSON.stringify([entry, ...current].slice(0, MAX_HISTORY)));
}

export function clearLockdownHistory(): void {
    kvSet(HISTORY_KEY, "");
    notifyUpdated();
}

// ── 展示辅助 ──

/** 把分钟数说成人话：90 → 「1 小时 30 分钟」 */
export function formatLockdownDuration(minutes: number): string {
    const total = Math.max(0, Math.round(minutes));
    if (total < 60) return `${total} 分钟`;
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}

/** 剩余毫秒数（已到点或没有倒计时都返回 0） */
export function lockdownRemainingMs(state: LockdownState, now: number = Date.now()): number {
    if (!state.endsAt) return 0;
    return Math.max(0, state.endsAt - now);
}
