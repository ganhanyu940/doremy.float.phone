"use client";

// 锁机全屏层：角色把手机收走时盖住整个小手机，直到倒计时走完或你亲手点确认。
//
// 这层只盖「小手机」界面（网页里的锁屏）。真机上别的 App 由安卓壳的全屏浮层盖住，
// 两边用的是同一份锁定状态（lib/lockdown-engine），谁到点谁先结算，另一边跟着收。
//
// 两个刻意的设计：
// 1. **随时可撤销**：底部留一个不显眼但一定能点的「现在解除」。这是用户自己
//    请角色管自己的工具，不是关住用户的笼子——用户反悔必须能立刻出去，
//    哪怕角色「不同意」。
// 2. **倒计时按绝对时间算**：页面被系统冻结、隔几个小时回来，剩余时间照样正确，
//    不会出现「挂后台就不走了」的假锁。

import { useCallback, useEffect, useState } from "react";
import { Lock, Moon, ShieldCheck } from "lucide-react";
import {
    confirmLockdown,
    getActiveLockdown,
    releaseLockdown,
    subscribeLockdown,
    syncNativeLockdown,
} from "@/lib/lockdown-engine";
import { formatLockdownDuration, loadLockdownSettings, type LockdownState } from "@/lib/lockdown-storage";
import { subscribeShellLockdownEvents } from "@/lib/shell-lockdown";

function formatCountdown(ms: number): string {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = (n: number) => n.toString().padStart(2, "0");
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export function LockdownOverlay() {
    const [state, setState] = useState<LockdownState | null>(null);
    const [now, setNow] = useState(() => Date.now());
    const [confirming, setConfirming] = useState(false);

    const refresh = useCallback(() => {
        setState(getActiveLockdown());
        setNow(Date.now());
    }, []);

    useEffect(() => {
        refresh();
        const unsubscribe = subscribeLockdown(refresh);
        // 页面回到前台立刻对一次表：后台期间可能已经到点
        const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            unsubscribe();
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [refresh]);

    // 每秒刷新剩余时间；没有锁定时不挂计时器
    useEffect(() => {
        if (!state) return;
        const timer = window.setInterval(() => {
            const next = getActiveLockdown();
            setNow(Date.now());
            if (!next) setState(null);
        }, 1000);
        return () => window.clearInterval(timer);
    }, [state]);

    // 页面每次挂载都对一次原生：刷新页面后原生浮层可能已经没了，需要重下发；
    // 反过来网页这边已经没有锁定了，也要把原生那边收掉。
    useEffect(() => {
        syncNativeLockdown(getActiveLockdown());
    }, []);

    // 原生浮层上点「我记住了」→ 网页这边同步结算
    useEffect(() => subscribeShellLockdownEvents((event) => {
        if (event.action === "unlocked") {
            confirmLockdown();
        }
        refresh();
    }), [refresh]);

    if (!state) return null;

    const settings = loadLockdownSettings();
    const remaining = state.endsAt ? Math.max(0, state.endsAt - now) : 0;
    const showConfirm = state.unlockMode === "confirm" || settings.allowEarlyRelease;

    return (
        <div className="lockdown-layer" role="dialog" aria-modal="true" aria-label="锁机中">
            <style>{`
                .lockdown-layer {
                    position: fixed;
                    inset: 0;
                    z-index: 2147482000;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    padding: 32px 26px calc(24px + env(safe-area-inset-bottom, 0px));
                    box-sizing: border-box;
                    color: #f4f1ea;
                    background: radial-gradient(120% 80% at 50% 0%, #2a2740 0%, #14131c 55%, #0a0a0f 100%);
                    animation: lockdown-in 420ms ease-out both;
                    overscroll-behavior: contain;
                    touch-action: none;
                }
                @keyframes lockdown-in {
                    from { opacity: 0; transform: scale(1.03); }
                    to { opacity: 1; transform: scale(1); }
                }
                .lockdown-badge {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    font-size: 11px;
                    letter-spacing: .16em;
                    text-transform: uppercase;
                    color: rgba(244,241,234,.55);
                    margin-bottom: 22px;
                }
                .lockdown-avatar {
                    width: 58px; height: 58px; border-radius: 50%;
                    display: flex; align-items: center; justify-content: center;
                    font-size: 24px; font-weight: 600;
                    background: linear-gradient(160deg, rgba(255,255,255,.14), rgba(255,255,255,.04));
                    border: 1px solid rgba(255,255,255,.14);
                    margin-bottom: 14px;
                }
                .lockdown-who { font-size: 14px; color: rgba(244,241,234,.72); margin-bottom: 18px; }
                .lockdown-msg {
                    max-width: 340px;
                    font-size: 16px;
                    line-height: 1.85;
                    text-align: center;
                    white-space: pre-wrap;
                    word-break: break-word;
                    margin: 0 0 26px;
                    max-height: 38vh;
                    overflow-y: auto;
                    animation: lockdown-fade 600ms 160ms ease-out both;
                }
                @keyframes lockdown-fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
                .lockdown-clock {
                    font-variant-numeric: tabular-nums;
                    font-size: 44px;
                    font-weight: 300;
                    letter-spacing: .04em;
                    line-height: 1.1;
                }
                .lockdown-clock-label { font-size: 12px; color: rgba(244,241,234,.5); margin-top: 8px; }
                .lockdown-actions { margin-top: 34px; display: flex; flex-direction: column; align-items: center; gap: 14px; width: 100%; }
                .lockdown-confirm {
                    width: min(320px, 100%);
                    padding: 14px 20px;
                    border-radius: 999px;
                    border: 1px solid rgba(255,255,255,.22);
                    background: rgba(255,255,255,.1);
                    color: #fff;
                    font-size: 15px;
                    cursor: pointer;
                }
                .lockdown-confirm:active { transform: scale(.985); }
                .lockdown-confirm[disabled] { opacity: .5; }
                .lockdown-release {
                    background: none;
                    border: none;
                    color: rgba(244,241,234,.36);
                    font-size: 12px;
                    text-decoration: underline;
                    text-underline-offset: 3px;
                    cursor: pointer;
                    padding: 8px;
                }
                .lockdown-note {
                    position: absolute;
                    bottom: calc(14px + env(safe-area-inset-bottom, 0px));
                    font-size: 11px;
                    color: rgba(244,241,234,.28);
                    text-align: center;
                    padding: 0 24px;
                }
            `}</style>

            <div className="lockdown-badge"><Lock size={13} /> 已锁定</div>

            <div className="lockdown-avatar">{(state.characterName || "角").slice(0, 1)}</div>
            <div className="lockdown-who">{state.characterName} 收走了你的手机</div>

            {state.message && <p className="lockdown-msg">{state.message}</p>}

            {state.unlockMode === "timer" ? (
                <div style={{ textAlign: "center" }}>
                    <div className="lockdown-clock">{formatCountdown(remaining)}</div>
                    <div className="lockdown-clock-label">
                        {state.durationMinutes > 0 ? `一共 ${formatLockdownDuration(state.durationMinutes)}` : ""}
                        {state.scope.apps && state.apps.length > 0 ? ` · 只锁了 ${state.apps.join("、")}` : ""}
                    </div>
                </div>
            ) : (
                <div className="lockdown-clock-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Moon size={13} /> 等你亲手确认才肯放行
                </div>
            )}

            <div className="lockdown-actions">
                {showConfirm && (
                    <button
                        type="button"
                        className="lockdown-confirm"
                        disabled={confirming}
                        onClick={() => {
                            setConfirming(true);
                            // 确认是「我记住了」，先给角色留个记录再解除
                            confirmLockdown();
                            setState(null);
                        }}
                    >
                        <ShieldCheck size={15} style={{ verticalAlign: "-3px", marginRight: 6 }} />
                        我记住了
                    </button>
                )}
                <button
                    type="button"
                    className="lockdown-release"
                    onClick={() => { releaseLockdown(); setState(null); }}
                >
                    现在解除（自己反悔也算数）
                </button>
            </div>

            <div className="lockdown-note">
                这是你自己让 {state.characterName} 管你的 · 范围与时长上限在「设置 → 锁机」里改
            </div>
        </div>
    );
}
