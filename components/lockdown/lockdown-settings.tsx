"use client";

// 锁机设置：把「角色能管到什么程度」的闸门全部交给用户自己定。
//
// 三层门槛，从上到下：
//   1. 总开关：关掉即当次锁定解除，角色之后的请求一律忽略；
//   2. 范围与上限：只能锁小手机 / 可锁真机 / 可锁指定应用，单次最多多久；
//   3. 授权：锁真机要浮窗权限，锁应用还要无障碍（否则不知道你在开哪个 App）。
// 界面顺序刻意按这个来——先讲清能做什么，再让用户去开权限。

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Lock, AlertTriangle, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";

import { Toggle } from "@/components/ui/form";
import {
    clearLockdownHistory,
    formatLockdownDuration,
    loadLockdownHistory,
    loadLockdownSettings,
    saveLockdownSettings,
    type LockdownSettings as LockdownSettingsValue,
} from "@/lib/lockdown-storage";
import { getActiveLockdown, refreshActiveLockdown, releaseLockdown, describeLockdown } from "@/lib/lockdown-engine";
import {
    inspectLockdownPermissions,
    listInstalledApps,
    openAccessibilitySettings,
    requestOverlayPermission,
    type InstalledApp,
} from "@/lib/shell-lockdown";

const DURATION_PRESETS = [30, 60, 120, 180, 240, 360];

export function LockdownSettings({ onNotice }: { onNotice?: (msg: string) => void }) {
    const [settings, setSettings] = useState<LockdownSettingsValue>(() => loadLockdownSettings());
    const [perms, setPerms] = useState(() => inspectLockdownPermissions());
    const [apps, setApps] = useState<InstalledApp[]>([]);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [active, setActive] = useState(() => getActiveLockdown());
    const [pickerOpen, setPickerOpen] = useState(false);
    const [manualApp, setManualApp] = useState("");

    const refresh = useCallback(() => {
        setSettings(loadLockdownSettings());
        setPerms(inspectLockdownPermissions());
        setActive(getActiveLockdown());
    }, []);

    useEffect(() => {
        refresh();
        // 从系统设置授权后切回来要立刻看到状态变化
        const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
        document.addEventListener("visibilitychange", onVisible);
        return () => document.removeEventListener("visibilitychange", onVisible);
    }, [refresh]);

    const inShell = perms.inShell;
    const nativeReady = perms.supported && perms.overlay;

    const update = useCallback((patch: Partial<LockdownSettingsValue>) => {
        const next = { ...loadLockdownSettings(), ...patch };
        saveLockdownSettings(next);
        setSettings(next);
        // 改完闸门立刻对已在跑的锁定重新收窄一次，避免旧锁定按旧规则继续跑
        refreshActiveLockdown();
        setActive(getActiveLockdown());
    }, []);

    const toggleEnabled = useCallback((on: boolean) => {
        update({ enabled: on });
        if (!on) {
            releaseLockdown();
            setActive(null);
            onNotice?.("已关闭锁机，正在进行的锁定也解除了");
        }
    }, [update, onNotice]);

    const toggleDevice = useCallback((on: boolean) => {
        update({ allowDevice: on });
        if (on && !nativeReady) {
            onNotice?.("还没给浮窗权限，角色只能锁小手机界面；开启权限后才能盖住其他 App");
        }
    }, [update, onNotice, nativeReady]);

    const addExempt = useCallback((name: string) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const current = loadLockdownSettings();
        if (current.exemptApps.includes(trimmed)) return;
        update({ exemptApps: [...current.exemptApps, trimmed].slice(0, 30) });
    }, [update]);

    const removeExempt = useCallback((name: string) => {
        const current = loadLockdownSettings();
        update({ exemptApps: current.exemptApps.filter(item => item !== name) });
    }, [update]);

    const history = useMemo(
        () => (historyOpen ? loadLockdownHistory() : []),
        [historyOpen, active],
    );

    const loadApps = useCallback(() => {
        if (!perms.supported) {
            onNotice?.("当前不在 App 里，读不到已安装应用清单");
            return;
        }
        const list = listInstalledApps();
        setApps(list);
        setPickerOpen(true);
        if (list.length === 0) onNotice?.("没读到应用清单，可以直接手动输入应用名");
    }, [perms.supported, onNotice]);

    return (
        <div style={{ padding: "16px 16px 40px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={CARD}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={ICON_BOX}><Lock size={17} /></div>
                    <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 15, fontWeight: 600 }}>让角色管住我的手机</div>
                        <div style={HINT}>睡觉时间别刷了——角色说一句就能把手机收走</div>
                    </div>
                </div>
                <div style={{ marginTop: 14, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 14 }}>允许角色锁机</span>
                    <Toggle checked={settings.enabled} onChange={toggleEnabled} />
                </div>
            </div>

            {active && (
                <div style={{ ...CARD, border: "1px solid rgba(255,140,120,.35)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 8 }}>
                        <AlertTriangle size={15} style={{ color: "#ff9a8b" }} />
                        <span>正在锁定中</span>
                    </div>
                    <div style={{ fontSize: 13, lineHeight: 1.7, opacity: 0.8 }}>{describeLockdown(active)}</div>
                    <button
                        type="button"
                        onClick={() => { releaseLockdown(); setActive(null); onNotice?.("已解除"); }}
                        style={PRIMARY_BTN}
                    >
                        现在就解除
                    </button>
                </div>
            )}

            <div style={CARD}>
                <div style={SECTION_TITLE}>锁到什么程度</div>

                <Row
                    label="锁小手机界面"
                    desc="小手机整个被锁屏盖住，要等倒计时或点头确认"
                    right={<Toggle checked={settings.allowVirtual} onChange={on => update({ allowVirtual: on })} />}
                />
                <Row
                    label="锁真机（盖住其他 App）"
                    desc={nativeReady ? "需要浮窗权限，已授权" : "需要浮窗权限；没授权时角色只能锁小手机界面"}
                    tone={settings.allowDevice && !nativeReady ? "warn" : undefined}
                    right={<Toggle checked={settings.allowDevice} onChange={toggleDevice} />}
                />
                <Row
                    label="只锁指定应用"
                    desc={perms.accessibility ? "可以精确到某个 App" : "需要无障碍权限才能知道你正在开哪个 App"}
                    tone={settings.allowAppLock && !perms.accessibility ? "warn" : undefined}
                    right={<Toggle checked={settings.allowAppLock} onChange={on => update({ allowAppLock: on })} />}
                />

                <Row
                    label="单次最长"
                    desc={`角色要求的时长会被收窄到 ${formatLockdownDuration(settings.maxDurationMinutes)} 以内`}
                    right={
                        <select
                            value={settings.maxDurationMinutes}
                            onChange={e => update({ maxDurationMinutes: Number(e.target.value) })}
                            style={SELECT}
                        >
                            {DURATION_PRESETS.map(value => (
                                <option key={value} value={value}>{formatLockdownDuration(value)}</option>
                            ))}
                        </select>
                    }
                />
                <Row
                    label="允许「我记住了」提前放行"
                    desc="关掉就只能等倒计时走完（纯确认式锁定也会被拒绝，避免锁死）"
                    right={<Toggle checked={settings.allowEarlyRelease} onChange={on => update({ allowEarlyRelease: on })} />}
                />
                <Row
                    label="锁屏上显示 TA 的留言"
                    desc="关掉只显示倒计时"
                    right={<Toggle checked={settings.showMessage} onChange={on => update({ showMessage: on })} />}
                />
            </div>

            <div style={CARD}>
                <div style={SECTION_TITLE}>真机权限</div>
                <Row
                    label="显示在其他应用上层"
                    desc={perms.overlay ? "已授权" : "锁真机、锁应用都靠它把界面盖住"}
                    tone={perms.overlay ? undefined : "warn"}
                    right={
                        perms.overlay
                            ? <span style={OK_TEXT}>已开启</span>
                            : <button type="button" style={LINK_BTN} onClick={() => requestOverlayPermission()}>去开启</button>
                    }
                />
                <Row
                    label="无障碍服务"
                    desc={perms.accessibility ? "已开启，能识别当前前台应用" : "锁指定应用必需；不开就只能整机全盖"}
                    tone={perms.accessibility ? undefined : "warn"}
                    right={
                        perms.accessibility
                            ? <span style={OK_TEXT}>已开启</span>
                            : <button type="button" style={LINK_BTN} onClick={() => openAccessibilitySettings()}>去开启</button>
                    }
                />
                <div style={{ ...HINT, marginTop: 6 }}>
                    {inShell
                        ? "这两项是安卓系统级权限，只能你自己在系统设置里打开；随时可以关掉，关掉后角色就锁不住真机。"
                        : "现在不在 App 里（普通浏览器/PWA），只能锁小手机界面。用安卓壳打开才能锁真机。"}
                </div>
            </div>

            <div style={CARD}>
                <div style={SECTION_TITLE}>永远不锁的应用</div>
                <div style={{ ...HINT, marginBottom: 10 }}>电话、信息这类留着自己用；锁机时它们照常能用。</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {settings.exemptApps.length === 0 && <span style={HINT}>还没有豁免应用</span>}
                    {settings.exemptApps.map(name => (
                        <button
                            key={name}
                            type="button"
                            onClick={() => removeExempt(name)}
                            style={CHIP}
                            title="点击移除"
                        >
                            {name} ×
                        </button>
                    ))}
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <input
                        value={manualApp}
                        onChange={e => setManualApp(e.target.value)}
                        placeholder="应用名，如 微信"
                        style={{ ...INPUT, flex: 1 }}
                    />
                    <button
                        type="button"
                        style={LINK_BTN}
                        onClick={() => { addExempt(manualApp); setManualApp(""); }}
                    >
                        添加
                    </button>
                    <button type="button" style={LINK_BTN} onClick={loadApps}>
                        <RefreshCw size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                        读本机应用
                    </button>
                </div>

                {pickerOpen && (
                    <div style={{ marginTop: 12, maxHeight: 240, overflowY: "auto", border: "1px solid rgba(255,255,255,.08)", borderRadius: 12 }}>
                        {apps.length === 0 && <div style={{ padding: 12, ...HINT }}>没有读到应用清单</div>}
                        {apps.map(app => (
                            <button
                                key={app.package}
                                type="button"
                                onClick={() => addExempt(app.label)}
                                style={PICKER_ROW}
                            >
                                {app.label}
                                <span style={{ opacity: 0.4, fontSize: 11, marginLeft: 8 }}>{app.package}</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>

            <div style={CARD}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={SECTION_TITLE}>最近被收走的记录</div>
                    <button type="button" style={LINK_BTN} onClick={() => setHistoryOpen(open => !open)}>
                        {historyOpen ? "收起" : "展开"}
                    </button>
                </div>
                {historyOpen && (
                    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                        {history.length === 0 && <span style={HINT}>还没有记录</span>}
                        {history.map(item => (
                            <div key={item.id} style={{ fontSize: 12.5, lineHeight: 1.7, opacity: 0.8 }}>
                                <b>{item.characterName}</b> · {formatLockdownDuration(item.durationMinutes || 0)}
                                {" · "}
                                {new Date(item.endedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                                {" · "}
                                {item.endedBy === "timer" ? "到点" : item.endedBy === "confirm" ? "你确认后" : "手动解除"}
                            </div>
                        ))}
                        {history.length > 0 && (
                            <button
                                type="button"
                                style={{ ...LINK_BTN, color: "#ff9a8b", marginTop: 4 }}
                                onClick={() => { clearLockdownHistory(); setHistoryOpen(false); }}
                            >
                                <Trash2 size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                                清空记录
                            </button>
                        )}
                    </div>
                )}
            </div>

            <div style={{ ...HINT, display: "flex", gap: 6, alignItems: "flex-start", marginTop: 4 }}>
                <ShieldCheck size={13} style={{ marginTop: 3, flexShrink: 0 }} />
                <span>
                    锁定状态、留言与记录都只存在这台设备上。任何时候你都能从这个页面解除或直接关掉功能——最终决定权一直在你手里。
                    {!nativeReady && inShell && " 当前还缺浮窗权限，锁真机暂时只在小手机内生效。"}
                    {!inShell && " 现在运行在浏览器里。"}
                </span>
            </div>
        </div>
    );
}

// ── 小组件与样式 ──

function Row({ label, desc, right, tone }: { label: string; desc?: string; right: ReactNode; tone?: "warn" }) {
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderTop: "1px solid rgba(255,255,255,.06)" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, display: "flex", alignItems: "center", gap: 6 }}>
                    {label}
                    {tone === "warn" && (
                        <span style={{ fontSize: 10, color: "#ffb27a", border: "1px solid rgba(255,178,122,.4)", borderRadius: 6, padding: "1px 5px" }}>
                            缺权限
                        </span>
                    )}
                </div>
                {desc && <div style={{ ...HINT, marginTop: 3 }}>{desc}</div>}
            </div>
            <div style={{ flexShrink: 0 }}>{right}</div>
        </div>
    );
}

const CARD: CSSProperties = {
    background: "rgba(255,255,255,.045)",
    border: "1px solid rgba(255,255,255,.07)",
    borderRadius: 16,
    padding: 14,
};
const SECTION_TITLE: CSSProperties = { fontSize: 13, fontWeight: 600, opacity: 0.9, marginBottom: 2 };
const HINT: CSSProperties = { fontSize: 11.5, lineHeight: 1.6, opacity: 0.55 };
const OK_TEXT: CSSProperties = { fontSize: 12, color: "#7fd6a4" };
const LINK_BTN: CSSProperties = {
    background: "none", border: "none", color: "inherit", opacity: 0.85,
    fontSize: 12.5, cursor: "pointer", padding: 0, textDecoration: "underline", textUnderlineOffset: 3,
};
const SELECT: CSSProperties = {
    background: "rgba(255,255,255,.08)", color: "inherit", border: "1px solid rgba(255,255,255,.12)",
    borderRadius: 10, padding: "6px 8px", fontSize: 12.5,
};
const INPUT: CSSProperties = {
    background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)",
    borderRadius: 10, padding: "8px 10px", color: "inherit", fontSize: 13, outline: "none",
};
const CHIP: CSSProperties = {
    background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.1)",
    borderRadius: 999, padding: "5px 10px", fontSize: 12, color: "inherit", cursor: "pointer",
};
const PRIMARY_BTN: CSSProperties = {
    marginTop: 12, width: "100%", padding: "10px 14px", borderRadius: 12,
    border: "1px solid rgba(255,255,255,.16)", background: "rgba(255,255,255,.09)",
    color: "inherit", fontSize: 13.5, cursor: "pointer",
};
const ICON_BOX: CSSProperties = {
    width: 38, height: 38, borderRadius: 11, display: "flex", alignItems: "center", justifyContent: "center",
    background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.08)",
};
const PICKER_ROW: CSSProperties = {
    display: "block", width: "100%", textAlign: "left",
    padding: "10px 12px", background: "none", border: "none",
    borderBottom: "1px solid rgba(255,255,255,.05)",
    color: "inherit", fontSize: 13, cursor: "pointer",
};
