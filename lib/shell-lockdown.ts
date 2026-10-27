// lib/shell-lockdown.ts
//
// 网页 ↔ 安卓壳「锁机」桥。
//
// 分工（重要）：
//   网页侧负责**判断**（该不该锁、锁多久、锁哪些应用、什么时候结束），
//   壳侧只负责**执行**（全屏浮层盖住真机、按前台包名拦截、到点或用户点确认时回收）。
//   判断留在网页，改规则不用重编 APK；执行留在原生，网页被系统冻结也照样有效。
//
// 计时以「绝对到点时间戳」下发（endsAt），不是剩余秒数：壳与网页各自被挂起、
// 恢复的时间点不同，只有绝对时间能让两边算出同一个答案。
//
// 非壳环境（普通浏览器 / PWA）下全部降级为 no-op，调用方无需分支判断。

import { isShellEnvironment, canDrawOverlay, isAccessibilityConnected, requestOverlayPermission, openAccessibilitySettings } from "./shell-call-overlay";

export type ShellLockdownPayload = {
    /** 锁机唯一 id，事件回传时用它校验是哪一次锁定 */
    id: string;
    characterName: string;
    /** 展示在浮层上的留言（已按设置裁剪，空串 = 不显示） */
    message: string;
    /** 开始时间（epoch ms） */
    startedAt: number;
    /** 绝对到点时间（epoch ms）；0 = 无倒计时，只能等用户确认 */
    endsAt: number;
    /** device=true 时：除豁免应用外任何前台 App 都被盖住 */
    blockAllApps: boolean;
    /** 被封锁的应用显示名（壳侧按 label 匹配包名） */
    apps: string[];
    /** 豁免应用显示名（电话、设置等） */
    exemptApps: string[];
    /** 是否显示「我记住了」按钮 */
    allowConfirm: boolean;
};

type LockdownBridgeLike = {
    /** 预热服务（App 在前台时调；后台起前台服务会被系统拒绝） */
    prepareLockdown?: () => boolean;
    startLockdown?: (json: string) => boolean;
    updateLockdown?: (json: string) => void;
    stopLockdown?: () => void;
    /** 已安装可启动应用清单（JSON 数组 [{package,label}]），设置页选应用用 */
    listInstalledApps?: () => string;
};

function bridge(): LockdownBridgeLike | null {
    if (typeof window === "undefined") return null;
    const candidate = (window as unknown as { AndroidShell?: LockdownBridgeLike }).AndroidShell;
    return candidate && typeof candidate === "object" ? candidate : null;
}

/** 壳是否支持锁机能力（老 APK 没有这些方法，网页据此降级为只锁小手机界面） */
export function supportsShellLockdown(): boolean {
    return typeof bridge()?.startLockdown === "function";
}

export const SHELL_LOCKDOWN_EVENT = "shell-lockdown";

export type ShellLockdownEvent = {
    /** unlocked：用户在原生浮层点了确认/自己解除；stopped：壳侧到点回收 */
    action: "unlocked" | "stopped" | "permission";
    /** action='permission' 时缺哪一项：overlay / accessibility */
    need?: string;
};

export function subscribeShellLockdownEvents(listener: (event: ShellLockdownEvent) => void): () => void {
    if (typeof window === "undefined") return () => { };
    const handler = (event: Event) => {
        const detail = (event as CustomEvent).detail as ShellLockdownEvent | undefined;
        if (!detail || typeof detail.action !== "string") return;
        try {
            listener(detail);
        } catch (error) {
            console.warn("[shell-lockdown] 监听器异常", error);
        }
    };
    window.addEventListener(SHELL_LOCKDOWN_EVENT, handler);
    return () => window.removeEventListener(SHELL_LOCKDOWN_EVENT, handler);
}

/**
 * 预热锁机服务（App 在前台时调）。
 *
 * 锁机多半是「用户正在别的 App 里」时由角色触发的，而 Android 12+ 不允许从后台
 * 启动前台服务。所以要在前台先把服务暖起来，真正触发时只是把已存在的浮层显示出来。
 * 返回 false = 没有浮窗权限（锁真机做不了）。
 */
export function prepareShellLockdown(): boolean {
    const b = bridge();
    if (!b?.prepareLockdown) return false;
    try {
        return !!b.prepareLockdown();
    } catch {
        return false;
    }
}

/** 下发一次锁定。返回 false = 壳没有这项能力或缺浮窗权限（调用方据此提示）。 */
export function startShellLockdown(payload: ShellLockdownPayload): boolean {
    const b = bridge();
    if (!b?.startLockdown) return false;
    try {
        return !!b.startLockdown(JSON.stringify(payload));
    } catch {
        return false;
    }
}

/** 更新已下发的内容（用户改了留言/时长，或点了提前放行的按钮前刷新状态） */
export function updateShellLockdown(payload: ShellLockdownPayload): void {
    const b = bridge();
    if (!b?.updateLockdown) return;
    try {
        b.updateLockdown(JSON.stringify(payload));
    } catch {
        /* 浮层不在或 WebView 已销毁，忽略 */
    }
}

/** 收掉原生封锁 */
export function stopShellLockdown(): void {
    const b = bridge();
    if (!b?.stopLockdown) return;
    try {
        b.stopLockdown();
    } catch {
        /* 忽略 */
    }
}

export type InstalledApp = { package: string; label: string };

/** 读已安装可启动应用清单（非壳环境返回空数组）。 */
export function listInstalledApps(): InstalledApp[] {
    const b = bridge();
    if (!b?.listInstalledApps) return [];
    try {
        const raw = b.listInstalledApps();
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((item): item is InstalledApp => !!item && typeof item.package === "string" && typeof item.label === "string")
            .slice(0, 400);
    } catch {
        return [];
    }
}

/**
 * 锁真机需要的两项授权状态。
 *   overlay：能在别的 App 上层画浮层（否则连「盖住」这一步都做不到）；
 *   accessibility：能知道你现在开的是哪个 App（否则只能盲锁，锁不住具体应用）。
 */
export function inspectLockdownPermissions(): {
    inShell: boolean;
    supported: boolean;
    overlay: boolean;
    accessibility: boolean;
} {
    return {
        inShell: isShellEnvironment(),
        supported: supportsShellLockdown(),
        overlay: canDrawOverlay(),
        accessibility: isAccessibilityConnected(),
    };
}

export { requestOverlayPermission, openAccessibilitySettings };
