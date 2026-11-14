"use client";

// 睡前自动锁设置面板。
//
// 这个面板的核心任务不是罗列开关，而是**如实交代两件事**：
//   ① 定时到底在哪儿跑——网页定时器在后台会被系统冻结，所以它由原生的
//      AlarmManager 负责（见 BedtimeScheduler.kt）。用户不需要懂原理，
//      但必须知道「App 没开着也会响」是靠什么实现的，否则他不会信；
//   ② 它靠什么判断「你还醒着」——原生没有读屏幕开合状态的接口，
//      这里用的是「最近 N 分钟有没有前台活动」做代理。这个差别必须写明，
//      不然用户会以为手机在偷看屏幕。
//
// 另外「下次会在几点响」「昨晚到底锁没锁」这两个状态必须可见：
// 睡眠类功能最怕「看起来开着、其实没生效」，而用户第二天根本查不出来。

import { useCallback, useEffect, useMemo, useState } from "react";

import { Toggle } from "@/components/ui/form";
import {
  BEDTIME_FALLBACK_REASON,
  catchUpBedtimeLock,
  loadBedtimeLockConfig,
  loadBedtimeRuntime,
  resetBedtimeStateNative,
  saveBedtimeLockConfig,
  syncBedtimeToNative,
  describeBedtimeWindow,
  supportsBedtimeLock,
  readBedtimeNativeStatus,
  cancelBedtimeLockNative,
  rescheduleBedtimeLockNative,
  testBedtimeLockNow,
  type BedtimeLockConfig,
} from "@/lib/bedtime-lock";
import { isShellEnvironment as isShell } from "@/lib/shell-call-overlay";

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => i);
const MINUTE_OPTIONS = [0, 10, 15, 20, 30, 40, 45, 50];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtWhen(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const isTomorrow = d.getFullYear() === tomorrow.getFullYear()
    && d.getMonth() === tomorrow.getMonth()
    && d.getDate() === tomorrow.getDate();
  const day = sameDay ? "今天" : isTomorrow ? "明天" : `${d.getMonth() + 1}/${d.getDate()}`;
  return `${day} ${fmtClock(ms)}`;
}

export function BedtimeLockSettings({ onNotice }: { onNotice?: (msg: string) => void }) {
  const [config, setConfig] = useState<BedtimeLockConfig>(() => loadBedtimeLockConfig());
  const [native, setNative] = useState(() => readBedtimeNativeStatus());
  const [tick, setTick] = useState(0);

  const inShell = useMemo(() => isShell(), []);
  const supported = useMemo(() => supportsBedtimeLock(), []);

  const refresh = useCallback(() => {
    setConfig(loadBedtimeLockConfig());
    setNative(readBedtimeNativeStatus());
  }, []);

  useEffect(() => {
    refresh();
    // 打开面板时补一次判定：原生闹钟是主力，这里只是「用户刚好正用着手机」
    // 时让遮罩准时盖上的兜底，不是主链路。
    // catchUpBedtimeLock 是模块级函数、引用恒定，不需要进依赖数组。
    try { catchUpBedtimeLock(); } catch { /* 兜底失败不影响面板 */ }

    const onChange = () => refresh();
    window.addEventListener("bedtime-lock-config-changed", onChange);
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);

    // 每分钟刷新一次「下次会在几点响」的倒计时展示（面板开着时才跑）
    const timer = window.setInterval(() => setTick(v => v + 1), 30_000);
    return () => {
      window.removeEventListener("bedtime-lock-config-changed", onChange);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const update = useCallback((patch: Partial<BedtimeLockConfig>) => {
    const next = { ...loadBedtimeLockConfig(), ...patch };
    saveBedtimeLockConfig(next);
    setConfig(next);
    // 每次改动都同步给原生：它会重排或取消闹钟。
    // 漏掉这一步的表现是「界面上改了时间，实际还是按旧时间响」。
    syncBedtimeToNative(next);
    setNative(readBedtimeNativeStatus());
  }, []);

  const runtime = useMemo(() => loadBedtimeRuntime(), [config, tick]);

  // 剩余时间的文字：只在面板能确认有下次触发时显示。
  // 把 tick 放进依赖里，是靠它触发每 30 秒重算一次；否则「约 N 分钟后」
  // 会一直停在打开面板那一刻的数字，看起来像卡死了。
  const nextAt = native?.nextTriggerAt ?? 0;
  const minutesToNext = useMemo(
    () => (nextAt > 0 ? Math.round((nextAt - Date.now()) / 60_000) : 0),
    [nextAt, tick],
  );

  return (
    <div className="per-shell">
      <div className="per-hero">
        <div className="per-hero-head">
          <span className="per-hero-title">到点就让你睡</span>
          <span className="per-state" data-tone={config.enabled && native?.enabled ? "on" : ""}>
            <i className="per-dot is-pulse" />
            {!config.enabled ? "未启用" : native?.enabled ? "原生定时已生效" : "等待原生确认"}
          </span>
        </div>

        {!inShell && (
          <div className="per-note is-warn">
            当前不在小手机 App 内（浏览器/PWA）。这个功能要靠手机系统的精确闹钟，
            在这里只能看界面，改设置不会真正生效。
          </div>
        )}
        {inShell && !supported && (
          <div className="per-note is-warn">
            当前 App 版本还不支持睡前自动锁，需要安卓壳 <b>1.0.37</b> 及以上。
            旧版的网页定时器在切到后台后会被系统冻结，到点根本不响——所以这个功能
            必须靠原生闹钟。
          </div>
        )}

        <div className="per-note is-warn">
          <div style={{ fontWeight: 600 }}>它靠什么判断你还醒着</div>
          <div style={{ marginTop: 6, lineHeight: 1.65 }}>
            到点时会先看<b>最近 {config.idleGraceMinutes} 分钟内手机有没有活动</b>
            （来自「使用情况访问」的应用切换记录）。
            <br />
            没有活动就当你已经睡了，<b>不锁</b>；还在用才锁。
            <br />
            说明一句实话：手机系统没有开放「屏幕开没开」这个接口，所以这是
            <b>间接判断</b>，不是真的在读屏幕。一直盯着同一个页面不动的话，
            它也可能以为你睡了——所以宽容时间要留够。
          </div>
        </div>
      </div>

      <div className="page-menu" style={{ paddingBottom: 40, gap: 16 }}>
        {/* 总开关与时段 */}
        <div>
          <div className="settings-menu-section-title">时段</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">睡前自动锁</span>
                <span className="menu-desc">
                  默认关闭。开了之后，每天到点如果你的手机还在亮着用，就锁上，
                  到起床时间自动解开。
                </span>
              </div>
              <Toggle
                checked={config.enabled}
                onChange={(v: boolean) => {
                  update({ enabled: v });
                  onNotice?.(v
                    ? "已开启。到点它会替你把手机拦下来"
                    : "已关闭，今晚不会锁你");
                }}
              />
            </div>

            <div className="menu-item" style={{ cursor: "default", flexDirection: "column", alignItems: "stretch", gap: 8 }}>
              <span className="menu-label" style={{ fontSize: 13 }}>几点开始管</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <select
                  className="ui-select"
                  value={config.startHour}
                  onChange={e => update({ startHour: Number(e.target.value) })}
                  style={{ flex: 1 }}
                >
                  {HOUR_OPTIONS.map(h => <option key={h} value={h}>{pad(h)} 点</option>)}
                </select>
                <select
                  className="ui-select"
                  value={config.startMinute}
                  onChange={e => update({ startMinute: Number(e.target.value) })}
                  style={{ flex: 1 }}
                >
                  {MINUTE_OPTIONS.map(m => <option key={m} value={m}>{pad(m)} 分</option>)}
                </select>
              </div>
            </div>

            <div className="menu-item" style={{ cursor: "default", flexDirection: "column", alignItems: "stretch", gap: 8 }}>
              <span className="menu-label" style={{ fontSize: 13 }}>几点解开（第二天）</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <select
                  className="ui-select"
                  value={config.endHour}
                  onChange={e => update({ endHour: Number(e.target.value) })}
                  style={{ flex: 1 }}
                >
                  {HOUR_OPTIONS.map(h => <option key={h} value={h}>{pad(h)} 点</option>)}
                </select>
                <select
                  className="ui-select"
                  value={config.endMinute}
                  onChange={e => update({ endMinute: Number(e.target.value) })}
                  style={{ flex: 1 }}
                >
                  {MINUTE_OPTIONS.map(m => <option key={m} value={m}>{pad(m)} 分</option>)}
                </select>
              </div>
              <div className="per-note" style={{ padding: 0 }}>
                当前：<b>{describeBedtimeWindow(config)}</b>
                {config.endHour < config.startHour ? "（跨天，第二天早上解开）" : ""}
                <br />
                注意单次锁机最多 8 小时（硬上限）。超过的部分会在中途自动解开，
                到那时会如实告诉你，不会假装锁满整晚。
              </div>
            </div>
          </div>
        </div>

        {/* 判定口径 */}
        <div>
          <div className="settings-menu-section-title">什么情况下才锁</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default", flexDirection: "column", alignItems: "stretch", gap: 8 }}>
              <span className="menu-label" style={{ fontSize: 13 }}>
                多久没动手机就算你睡了：{config.idleGraceMinutes} 分钟
              </span>
              <input
                type="range"
                min={1}
                max={60}
                step={1}
                value={config.idleGraceMinutes}
                onChange={e => update({ idleGraceMinutes: Number(e.target.value) })}
                style={{ width: "100%" }}
              />
              <div className="per-note" style={{ padding: 0 }}>
                设太短容易冤枉你（只是停下来想了想就被判睡着）；设太长就管不住了。
                10 分钟是个稳妥的折中。
              </div>
            </div>

            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">读不到记录时也锁</span>
                <span className="menu-desc">
                  建议打开。没给「使用情况访问」权限时，就判断不了你有没有在睡——
                  而这种时候恰恰最容易熬通宵。代价是可能在你已经睡了之后白锁一次。
                </span>
              </div>
              <Toggle
                checked={config.lockWhenUnknown}
                onChange={(v: boolean) => update({ lockWhenUnknown: v })}
              />
            </div>

            <div className="menu-item" style={{ cursor: "default", flexDirection: "column", alignItems: "stretch", gap: 8 }}>
              <span className="menu-label" style={{ fontSize: 13 }}>锁上时屏幕上的话</span>
              <input
                className="ui-input"
                value={config.reason}
                placeholder={BEDTIME_FALLBACK_REASON}
                maxLength={60}
                onChange={e => update({ reason: e.target.value })}
                onBlur={e => { if (!e.target.value.trim()) update({ reason: BEDTIME_FALLBACK_REASON }); }}
              />
              <div className="per-note" style={{ padding: 0 }}>
                这句会显示在锁机画面上。写具体一点比写「该睡觉了」有用——
                比如「明天早上要背第三章」。
              </div>
            </div>
          </div>
        </div>

        {/* 实际状态 */}
        <div>
          <div className="settings-menu-section-title">现在到底生效了没有</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">下一次触发</span>
                <span className="menu-desc">
                  {!config.enabled
                    ? "没开启"
                    : nextAt > 0
                      ? `${fmtWhen(nextAt)}${minutesToNext > 0 ? `（约 ${minutesToNext} 分钟后）` : ""}`
                      : "还没排上——点下面「重排闹钟」试试"}
                </span>
              </div>
            </div>

            {native && (
              <div className="menu-item" style={{ cursor: "default" }}>
                <div className="menu-label-group">
                  <span className="menu-label">定时精度</span>
                  <span className="menu-desc" style={{ color: native.exact ? "var(--c-success, #2b8a5f)" : "var(--c-warn, #c9840f)" }}>
                    {native.exact
                      ? "精确闹钟已授权，到点准时叫醒"
                      : "只有非精确闹钟：会响，但系统深度休眠时可能迟到几分钟"}
                  </span>
                </div>
              </div>
            )}

            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">最近一次结果</span>
                <span className="menu-desc">
                  {native?.lastOutcome
                    ? `${native.lastOutcome}${native.lastTriggerAt ? `（${fmtWhen(native.lastTriggerAt)}）` : ""}`
                    : runtime.lastOutcome || "还没触发过"}
                </span>
              </div>
            </div>

            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">今晚是否已锁过</span>
                <span className="menu-desc">
                  {runtime.lastLockDate
                    ? `最近 ${runtime.lastLockDate}${runtime.userUnlockAt && runtime.userUnlockAt > Date.now() - 86_400_000 ? " · 你后来自己解开过（今晚不再锁）" : ""}`
                    : "还没锁过"}
                </span>
              </div>
            </div>

            <div className="menu-item" style={{ cursor: "default", flexDirection: "column", alignItems: "stretch", gap: 10 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className="ui-btn ui-btn-outline"
                  style={{ flex: 1 }}
                  onClick={() => {
                    const ok = syncBedtimeToNative();
                    const again = rescheduleBedtimeLockNative();
                    setNative(readBedtimeNativeStatus());
                    onNotice?.(ok || again ? "已让系统重排闹钟" : "重排失败：可能不是 1.0.37 以上的 App");
                  }}
                >
                  重排闹钟
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-outline"
                  style={{ flex: 1 }}
                  onClick={() => {
                    const result = testBedtimeLockNow();
                    onNotice?.(result.message);
                  }}
                >
                  现在试一次
                </button>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className="ui-btn ui-btn-outline"
                  style={{ flex: 1 }}
                  onClick={() => {
                    cancelBedtimeLockNative();
                    setNative(readBedtimeNativeStatus());
                    onNotice?.("已取消闹钟，今天不会再自动锁");
                  }}
                >
                  取消今天的闹钟
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-outline"
                  style={{ flex: 1 }}
                  onClick={() => {
                    resetBedtimeStateNative();
                    refresh();
                    onNotice?.("已清掉「今晚已锁过/已解开」的记录");
                  }}
                >
                  重置今晚状态
                </button>
              </div>
            </div>
          </div>
          <div className="per-note" style={{ padding: "0 var(--ui-padding, 16px)" }}>
            还要满足两个前提：<b>无障碍服务已开启</b>（锁机靠它，设置 → 角色管我 里能看到状态）；
            以及给过<b>使用情况访问</b>权限（否则判断不了你在不在用手机，见上面那条）。
          </div>
        </div>

        {/* 边界说明 */}
        <div>
          <div className="settings-menu-section-title">它做不到什么</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-desc" style={{ lineHeight: 1.75 }}>
                  · 手机<b>强制停止</b>过这个 App、或重启后没再打开过它，闹钟可能不响
                  （部分国产 ROM 会清理定时任务，需要在系统设置里允许自启动）；
                  <br />
                  · 它拦的是<b>应用</b>，电话和系统设置永远放行——这是刻意留的逃生门；
                  <br />
                  · 它不会因为你解锁过一次就跟你较劲：你解开过，今晚就不再来烦你。
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
