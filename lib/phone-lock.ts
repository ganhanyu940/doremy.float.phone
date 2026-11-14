// lib/phone-lock.ts — 锁机（白名单硬锁）的网页侧接口
//
// 真正的拦截在原生层（android-shell 的 LockGuard + CallControlService），
// 本模块只负责：配置下发、锁定/解锁、状态读取、以及给用户挑应用的白名单数据。
//
// 为什么网页不能自己做：自定义 APP 和网页都跑在沙盒里，只能管住自己，
// 管不住抖音、微信这些外部应用。只有无障碍服务能看见「现在是哪个应用在前台」
// 并盖上系统级浮层。
//
// 设计边界（重要）：
// - 电话、系统设置永远放行。系统设置是关闭无障碍服务的入口，也是防止把自己
//   彻底锁死的最后保险；
// - 单次锁定有上限（原生侧 8 小时），不提供"永久锁定"；
// - 不记录任何应用使用内容，不上传数据。

export type PhoneLockStatus = {
  /** 原生锁机能力是否可用（= 无障碍服务是否已开启） */
  available: boolean;
  /** 功能是否已启用 */
  enabled: boolean;
  /** 当前是否正在锁定 */
  locked: boolean;
  /** 锁定结束时间戳（毫秒）；未锁定为 0 */
  lockedUntil: number;
  /** 剩余毫秒 */
  remainingMs: number;
  /** 锁定理由（显示在遮罩上，通常是角色说的话） */
  reason: string;
  /** 触发来源：manual / bedtime / character 等 */
  source: string;
  /** 白名单包名数组 */
  whitelist: string[];
};

export type LaunchableApp = {
  package: string;
  label: string;
};

type NativeLockBridge = {
  isLockGuardAvailable?: () => boolean;
  configureLockGuard?: (json: string) => boolean;
  lockPhone?: (untilMs: number, reason: string, source: string) => string;
  unlockPhone?: (source: string) => string;
  getLockGuardStatus?: () => string;
  listLaunchableApps?: () => string;
  openApp?: (packageName: string) => string;
};

function bridge(): NativeLockBridge | null {
  if (typeof window === "undefined") return null;
  const shell = (window as unknown as { AndroidShell?: NativeLockBridge }).AndroidShell;
  if (shell && typeof shell.lockPhone === "function") return shell;
  return null;
}

/** 锁机能力是否可用（壳内且无障碍服务已开启）。 */
export function isPhoneLockAvailable(): boolean {
  const native = bridge();
  if (!native?.isLockGuardAvailable) return false;
  try {
    return native.isLockGuardAvailable() === true;
  } catch {
    return false;
  }
}

/** 读当前锁机状态。非壳环境返回"不可用"的安全默认值。 */
export function getPhoneLockStatus(): PhoneLockStatus {
  const empty: PhoneLockStatus = {
    available: false, enabled: false, locked: false,
    lockedUntil: 0, remainingMs: 0, reason: "", source: "", whitelist: [],
  };
  const native = bridge();
  if (!native?.getLockGuardStatus) return empty;
  try {
    const raw = JSON.parse(native.getLockGuardStatus() || "{}") as Record<string, unknown>;
    let whitelist: string[] = [];
    try {
      const parsed = JSON.parse(String(raw.whitelist ?? "[]"));
      if (Array.isArray(parsed)) whitelist = parsed.map(String).filter(Boolean);
    } catch { /* 保持空数组 */ }
    return {
      available: raw.available === true,
      enabled: raw.enabled === true,
      locked: raw.locked === true,
      lockedUntil: Number(raw.lockedUntil ?? 0),
      remainingMs: Number(raw.remainingMs ?? 0),
      reason: String(raw.reason ?? ""),
      source: String(raw.source ?? ""),
      whitelist,
    };
  } catch {
    return empty;
  }
}

/** 下发配置（白名单 / 启用状态）。不会因此触发锁定。 */
export function configurePhoneLock(config: {
  enabled?: boolean;
  whitelist?: string[];
  reason?: string;
  source?: string;
}): boolean {
  const native = bridge();
  if (!native?.configureLockGuard) return false;
  try {
    return native.configureLockGuard(JSON.stringify({
      enabled: config.enabled,
      whitelist: config.whitelist ?? [],
      reason: config.reason ?? "",
      source: config.source ?? "",
    })) === true;
  } catch {
    return false;
  }
}

export type LockResult = { ok: boolean; until?: number; minutes?: number; message?: string };

/**
 * 立刻锁定一段时间。
 * @param minutes 锁定分钟数（原生侧上限 8 小时 = 480 分钟）
 * @param reason 显示在遮罩上的理由，通常是角色说的话
 */
export function lockPhoneFor(minutes: number, reason: string, source = "manual"): LockResult {
  const native = bridge();
  if (!native?.lockPhone) return { ok: false, message: "当前环境不支持锁机" };
  const safeMinutes = Math.max(1, Math.min(480, Math.round(minutes)));
  try {
    const raw = JSON.parse(native.lockPhone(Date.now() + safeMinutes * 60_000, reason, source) || "{}");
    if (raw.ok === false) {
      return { ok: false, message: String(raw.message || "锁机失败") };
    }
    return { ok: true, until: Number(raw.until ?? 0), minutes: Number(raw.minutes ?? safeMinutes) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "锁机失败" };
  }
}

/** 锁定到某个时间点（如"到明早 7 点"）。 */
export function lockPhoneUntil(untilMs: number, reason: string, source = "manual"): LockResult {
  const minutes = Math.ceil((untilMs - Date.now()) / 60_000);
  if (minutes <= 0) return { ok: false, message: "解锁时间必须晚于现在" };
  return lockPhoneFor(minutes, reason, source);
}

/** 解锁。需要说明来源，便于事后分辨是人工解除还是到点解除。 */
export function unlockPhone(source = "manual"): LockResult {
  const native = bridge();
  if (!native?.unlockPhone) return { ok: false, message: "当前环境不支持锁机" };
  try {
    const raw = JSON.parse(native.unlockPhone(source) || "{}");
    return raw.ok === false ? { ok: false, message: String(raw.message || "解锁失败") } : { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "解锁失败" };
  }
}

/** 列出手机里可启动的应用（供白名单勾选）。 */
export function listLaunchableApps(): LaunchableApp[] {
  const native = bridge();
  if (!native?.listLaunchableApps) return [];
  try {
    const parsed = JSON.parse(native.listLaunchableApps() || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(item => ({
        package: String((item as Record<string, unknown>)?.package ?? ""),
        label: String((item as Record<string, unknown>)?.label ?? ""),
      }))
      .filter(item => item.package)
      .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
  } catch {
    return [];
  }
}

/** 打开一个应用（锁机后"自动拉起学习软件"用它）。 */
export function openAppByPackage(packageName: string): boolean {
  const native = bridge();
  if (!native?.openApp) return false;
  try {
    const raw = native.openApp(packageName) || "{}";
    return JSON.parse(raw).ok === true;
  } catch {
    return false;
  }
}

/** 把剩余毫秒格式化成 HH:MM:SS，给倒计时显示用。 */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export type ShellLockEvent = {
  action: "lock" | "unlock" | "blocked" | "error";
  until?: number;
  reason?: string;
  source?: string;
  package?: string;
  message?: string;
};

/** 订阅原生锁机事件（window 上的 shell-lock）。 */
export function onShellLockEvent(listener: (event: ShellLockEvent) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent).detail as ShellLockEvent | undefined;
    if (detail && typeof detail.action === "string") listener(detail);
  };
  window.addEventListener("shell-lock", handler as EventListener);
  return () => window.removeEventListener("shell-lock", handler as EventListener);
}
