// lib/lockdown-engine.ts
//
// 「锁机」的业务大脑：解析角色的请求 → 按用户设定的闸门裁一遍 → 落地成一次锁定
// → 到点/确认时结算并写历史 → 同步给安卓壳。
//
// 为什么闸门在这里而不是在提示词里：
//   模型可能写出「锁 24 小时」「锁掉全部应用」，提示词只是建议。真正能决定的
//   只有用户在设置页里定下的上限（时长上限、允许的范围、豁免应用）。所以
//   requestLockdown() 一律以设置为准做收窄，角色越界的那部分直接丢掉。
//
// 状态判定统一走 getActiveLockdown()：它会把「已经该结束了」的锁定当场结算掉。
// 页面被系统冻结、隔了几小时才回来，也能得到正确结果——因为比对的是绝对时间戳。

import {
    appendLockdownHistory,
    loadLockdownSettings,
    loadLockdownState,
    lockdownRemainingMs,
    saveLockdownState,
    LOCKDOWN_UPDATED_EVENT,
    formatLockdownDuration,
    type LockdownScope,
    type LockdownState,
} from "./lockdown-storage";
import {
    startShellLockdown,
    updateShellLockdown,
    stopShellLockdown,
    supportsShellLockdown,
    type ShellLockdownPayload,
} from "./shell-lockdown";

export type LockdownRequest = {
    characterId: string;
    characterName: string;
    /** 标签里的 target 原文，形如「45」「45 抖音,微博」「1小时 哔哩哔哩」 */
    target?: string;
    /** 角色留的话（标签正文） */
    message: string;
};

export type LockdownResult =
    | { ok: true; state: LockdownState }
    | { ok: false; reason: string };

/**
 * 解析标签 target：
 *   "45"              → 45 分钟，锁整机
 *   "45 抖音,微博"     → 45 分钟，只锁这两个应用
 *   "1小时 哔哩哔哩"   → 60 分钟，只锁 B 站
 *   "0"               → 没有倒计时（纯确认式，必须给留言才有意义）
 */
export function parseLockdownTarget(target?: string): { minutes: number; apps: string[] } {
    const raw = (target ?? "").trim();
    if (!raw) return { minutes: 0, apps: [] };

    const match = /^(\d+(?:\.\d+)?)\s*(分钟|分|min|m|小时|时|h)?\s*([\s\S]*)$/i.exec(raw);
    if (!match) {
        // 没有时长，整段当作应用列表
        return { minutes: 0, apps: splitAppNames(raw) };
    }

    const value = Number(match[1]);
    const unit = (match[2] ?? "").toLowerCase();
    const isHour = unit === "小时" || unit === "时" || unit === "h";
    const minutes = isHour ? Math.round(value * 60) : Math.round(value);
    return { minutes, apps: splitAppNames(match[3] ?? "") };
}

function splitAppNames(text: string): string[] {
    return text
        .split(/[，,、\/|；;\s]+/)
        .map(item => item.trim())
        .filter(item => item.length > 0 && item.length <= 40)
        .slice(0, 40);
}

// 同一句回复可能被多条链路各解析一遍（前台落库、后台补账、工具轮重放），
// 结构化的标签会被看到两三次。用「角色 + 参数 + 正文」做键在 60 秒内去重，
// 保证一次要求只落成一次锁定，也免得用户被重复通知。
const recentRequests = new Map<string, number>();
const REQUEST_DEDUPE_MS = 60_000;

function requestDedupeKey(request: LockdownRequest): string {
    return `${request.characterId}|${(request.target ?? "").trim()}|${(request.message ?? "").trim()}`;
}

function isDuplicateRequest(key: string, now: number): boolean {
    for (const [k, at] of recentRequests) {
        if (now - at > REQUEST_DEDUPE_MS) recentRequests.delete(k);
    }
    const seenAt = recentRequests.get(key);
    if (seenAt !== undefined && now - seenAt <= REQUEST_DEDUPE_MS) return true;
    recentRequests.set(key, now);
    return false;
}

/** 生成一次锁定。角色发来的要求已按用户设置收窄；越界的那部分不会生效。 */
export function requestLockdown(request: LockdownRequest, now: number = Date.now()): LockdownResult {
    const settings = loadLockdownSettings();
    if (!settings.enabled) return { ok: false, reason: "用户关掉了锁机功能" };

    const existing = getActiveLockdown(now);
    if (existing) return { ok: false, reason: "已经在锁定中，不叠第二次" };

    if (isDuplicateRequest(requestDedupeKey(request), now)) {
        return { ok: false, reason: "重复的请求，已忽略" };
    }

    const { minutes: rawMinutes, apps } = parseLockdownTarget(request.target);
    const minutes = rawMinutes > 0
        ? Math.min(Math.max(1, rawMinutes), Math.max(1, settings.maxDurationMinutes))
        : 0;
    const message = (request.message ?? "").trim().slice(0, 600);

    // 既没有时长也没有留言 = 没法解锁的死锁，直接拒绝。
    if (minutes === 0 && !message) return { ok: false, reason: "缺时长也缺留言，没有解锁条件" };
    if (minutes === 0 && !settings.allowEarlyRelease) {
        // 纯确认式锁定在「不许提前放行」时等于永久锁，绝不允许。
        return { ok: false, reason: "用户关掉了提前放行，纯确认式锁定会锁死" };
    }

    const wantAppLock = apps.length > 0 && settings.allowAppLock;
    const scope: LockdownScope = {
        virtual: settings.allowVirtual,
        // 指定了应用就只封那些应用，不再整机封锁；没指定才可能整机锁。
        device: !wantAppLock && settings.allowDevice,
        apps: wantAppLock,
    };
    if (!scope.virtual && !scope.device && !scope.apps) {
        return { ok: false, reason: "用户没允许任何一种锁定范围" };
    }

    const state: LockdownState = {
        id: `lk_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        characterId: request.characterId,
        characterName: request.characterName || "角色",
        message,
        durationMinutes: minutes,
        startedAt: now,
        endsAt: minutes > 0 ? now + minutes * 60_000 : 0,
        unlockMode: minutes > 0 ? "timer" : "confirm",
        scope,
        apps: wantAppLock ? apps : [],
        confirmedAt: 0,
    };

    saveLockdownState(state);
    syncNativeLockdown(state);
    return { ok: true, state };
}

/**
 * 当前有效的锁定（该结束的会当场结算掉）。没有则返回 null。
 * 一切的「现在锁着吗」都问这个函数，不要直接读存储。
 */
export function getActiveLockdown(now: number = Date.now()): LockdownState | null {
    const state = loadLockdownState();
    if (!state) return null;

    const settings = loadLockdownSettings();
    if (!settings.enabled) {
        settle(state, "manual", now);
        return null;
    }
    if (state.confirmedAt) {
        settle(state, "confirm", now);
        return null;
    }
    if (state.unlockMode === "timer" && state.endsAt > 0 && now >= state.endsAt) {
        settle(state, "timer", now);
        return null;
    }
    if (state.unlockMode === "timer" && state.endsAt === 0) {
        // 数据异常（计时式却没有到点时间）：当作无效锁定，别把用户锁死在里头。
        settle(state, "manual", now);
        return null;
    }
    return state;
}

/** 结算一次锁定：写历史、清状态、收掉原生浮层、广播。 */
function settle(state: LockdownState, endedBy: "timer" | "confirm" | "manual", now: number): void {
    appendLockdownHistory({
        id: state.id,
        characterId: state.characterId,
        characterName: state.characterName,
        message: state.message,
        durationMinutes: state.durationMinutes,
        startedAt: state.startedAt,
        endedAt: now,
        endedBy,
    });
    saveLockdownState(null);
    stopShellLockdown();
}

/** 用户点「我记住了」/ 原生回传确认时调用。 */
export function confirmLockdown(now: number = Date.now()): boolean {
    const state = loadLockdownState();
    if (!state) return false;
    const settings = loadLockdownSettings();
    // 计时式且用户关掉了提前放行：确认按钮不起作用，只能等时间到。
    if (state.unlockMode === "timer" && !settings.allowEarlyRelease) return false;
    settle({ ...state, confirmedAt: now }, "confirm", now);
    return true;
}

/** 用户手动解除（设置页的「现在就解除」）。 */
export function releaseLockdown(now: number = Date.now()): void {
    const state = loadLockdownState();
    if (!state) {
        stopShellLockdown();
        return;
    }
    settle(state, "manual", now);
}

/** 用户在设置里改了范围/时长上限后，把已经在跑的那次按新设置重新收窄。 */
export function refreshActiveLockdown(now: number = Date.now()): LockdownState | null {
    const state = getActiveLockdown(now);
    if (!state) {
        stopShellLockdown();
        return null;
    }
    const settings = loadLockdownSettings();

    if (!settings.allowVirtual || (!settings.allowDevice && !settings.allowAppLock)) {
        // 范围全被关掉了：没有可执行的锁定，直接解除。
        settle(state, "manual", now);
        return null;
    }

    const overLimit = state.durationMinutes > settings.maxDurationMinutes;
    let next = state;
    if (overLimit || !settings.allowDevice || !settings.allowAppLock) {
        const remainingMin = state.endsAt
            ? Math.max(1, Math.ceil((state.endsAt - now) / 60_000))
            : state.durationMinutes;
        const cappedMin = Math.min(remainingMin, settings.maxDurationMinutes);
        next = {
            ...state,
            durationMinutes: overLimit ? cappedMin : state.durationMinutes,
            endsAt: overLimit && state.endsAt ? now + cappedMin * 60_000 : state.endsAt,
            scope: {
                virtual: settings.allowVirtual,
                device: state.scope.device && settings.allowDevice,
                apps: state.scope.apps && settings.allowAppLock,
            },
        };
        saveLockdownState(next);
    }
    syncNativeLockdown(next);
    return next;
}

// ── 与安卓壳同步 ──

function buildShellPayload(state: LockdownState): ShellLockdownPayload {
    const settings = loadLockdownSettings();
    return {
        id: state.id,
        characterName: state.characterName,
        message: settings.showMessage ? state.message : "",
        startedAt: state.startedAt,
        endsAt: state.endsAt,
        // 整机封锁：device 范围开着且没有指定应用
        blockAllApps: state.scope.device && state.apps.length === 0,
        apps: state.apps,
        exemptApps: settings.exemptApps,
        allowConfirm: settings.allowEarlyRelease,
    };
}

/**
 * 把当前状态推给壳。
 * - 只锁小手机界面时也要推一次「stop」：用户可能在原生还锁着的状态下改了设置。
 * - 壳不支持（普通浏览器）时全部静默跳过。
 */
export function syncNativeLockdown(state: LockdownState | null): void {
    if (!supportsShellLockdown()) return;
    if (!state) {
        stopShellLockdown();
        return;
    }
    const needsNative = state.scope.device || state.scope.apps;
    if (!needsNative) {
        stopShellLockdown();
        return;
    }
    const payload = buildShellPayload(state);
    // 先 start：壳内部对同一个 id 是「更新而不是重建」，不会闪。
    // 老壳没有可用的 start 时退回 update。
    if (!startShellLockdown(payload)) updateShellLockdown(payload);
}

// ── 从模型原文里提取锁机请求 ──

// 参数与正文之间允许空格或冒号（模型有时会写 [锁机：45]）
const LOCKDOWN_TAG_RE = /\[锁机(?:[\s:：]+([^\]\n]*))?\]([\s\S]*?)\[\/锁机\]/g;

/**
 * 把 [锁机 …]…[/锁机] 从可见文本里摘掉（连带没有闭合标签的残块）。
 *
 * 必须显式做这一步：锁机标签和朋友圈那些不一样，它走的不是「结构化动作解析 →
 * 剥壳」那条路，而是本模块直接扫原文。不在这里剥，标签就会以原文形式漏进气泡。
 */
export function stripLockdownTags(text: string): string {
    if (!text || !text.includes("[锁机")) return text;
    let out = text.replace(LOCKDOWN_TAG_RE, "");
    // 没有闭合标签的残块：从 [锁机 到行尾整段丢掉（宁可少显示一句，也不漏标签原文）
    out = out.replace(/\[锁机(?:[\s:：]+[^\]\n]*)?\][^\n]*/g, "");
    return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 扫一遍模型原文，把 [锁机 45]…[/锁机] 之类的请求落地。
 *
 * 为什么单独做成「扫原文」这一步，而不是只挂在结构化动作解析上：
 * 一次回复会经过前台落库、后台补账、工具轮重放等多条链路，挂在其中一条上，
 * 用户不在聊天室时就可能漏掉。这里在两条链路都调一次，重复的部分由
 * requestLockdown 的去重挡掉。
 *
 * 返回真正落地的那次锁定（没触发/被拒绝都返回 null）。
 */
export function runLockdownFromText(params: {
    characterId: string;
    characterName: string;
    text: string;
}, now: number = Date.now()): LockdownState | null {
    const text = params.text ?? "";
    if (!text.includes("[锁机")) return null;
    LOCKDOWN_TAG_RE.lastIndex = 0;
    const match = LOCKDOWN_TAG_RE.exec(text);
    if (!match) return null;
    const result = requestLockdown({
        characterId: params.characterId,
        characterName: params.characterName,
        target: (match[1] ?? "").trim(),
        message: (match[2] ?? "").trim(),
    }, now);
    return result.ok ? result.state : null;
}

// ── 提示词注入 ──

/**
 * 每轮注入给模型的「你可以锁机」说明。关掉总开关就返回空串（整段不出现）。
 *
 * 为什么走运行时注入、而不是像朋友圈那样写进内置预设：
 * 内置预设在用户设备上装过一次之后就不再更新，往预设里加条目老用户根本拿不到
 * （升版本会重写用户的自定义，代价太大）。所以这条说明按开关状态每轮现拼。
 * 顺带的好处：用户在设置里改了时长上限，说明里的数字立刻跟着变。
 */
export function buildLockdownPromptHint(): string {
    const settings = loadLockdownSettings();
    if (!settings.enabled) return "";
    if (!settings.allowVirtual && !settings.allowDevice && !settings.allowAppLock) return "";

    const scopes: string[] = [];
    if (settings.allowVirtual) scopes.push("锁住小手机界面");
    if (settings.allowDevice) scopes.push("盖住真机上其他应用");
    if (settings.allowAppLock) scopes.push("只锁掉指定的几个应用");

    return [
        "（可选能力：在对方同意过的情况下，你可以把 TA 的手机收走一段时间，帮 TA 早点睡、专心做事。",
        `你能做的范围：${scopes.join("、")}；单次最长 ${formatLockdownDuration(settings.maxDurationMinutes)}（写得再长也会被系统收窄）。`,
        "真要这么做时，在回复里单独一段输出标签：[锁机 时长 应用1,应用2]你要说的话[/锁机]",
        "· 时长写分钟数（45）或「1小时」；不写应用名就是整机，写了就只锁那几个应用；写 0 表示不设倒计时、必须对方亲手确认才放行。",
        "· 标签里的正文会显示在锁屏上，必须写，而且要像你平时说话。",
        "· 只在你们确实约好过、或对方明确要你管的时候用；一次锁定结束前不要重复输出。已经锁着就正常聊天。",
        "· 这是帮 TA 收住注意力，不是惩罚：不要用「不听话就更久」「求我才放你」这类话，也不要用锁机要挟或换取什么。",
        "· 标签本身不会显示给对方看。不需要就不要输出，也不要提及这条说明。）",
    ].join("\n");
}

// ── 给其它 UI 用的小工具 ──

/** 一句话概括当前锁定，用于通知、聊天里的旁白、设置页状态行。 */
export function describeLockdown(state: LockdownState, now: number = Date.now()): string {
    const who = state.characterName || "角色";
    const scopeText = state.apps.length > 0
        ? `锁掉 ${state.apps.slice(0, 3).join("、")}${state.apps.length > 3 ? " 等应用" : ""}`
        : state.scope.device ? "收走整台手机" : "锁住小手机";
    if (state.unlockMode === "confirm") return `${who}${scopeText}了，要你亲手确认才放行`;
    const remaining = lockdownRemainingMs(state, now);
    const minutes = Math.max(1, Math.ceil(remaining / 60_000));
    return `${who}${scopeText}了，还剩 ${formatLockdownDuration(minutes)}`;
}

/** 锁屏组件订阅用：状态有变化时触发。 */
export function subscribeLockdown(listener: () => void): () => void {
    if (typeof window === "undefined") return () => { };
    const handler = () => listener();
    window.addEventListener(LOCKDOWN_UPDATED_EVENT, handler);
    return () => window.removeEventListener(LOCKDOWN_UPDATED_EVENT, handler);
}
