"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { PageShell } from "@/components/ui/page-shell";
import { CustomAppGlyph, IconGlyph } from "@/components/icon-glyph";
import { ICONS, type IconId, type IconMeta } from "@/lib/desktop-config";
import { customAppIdFromIconId, type InstalledCustomApp } from "@/lib/custom-app-types";
import {
  APP_USAGE_RETENTION_DAYS,
  dayDisplayLabel,
  formatUsageDuration,
  formatUsageDurationCompact,
  loadAppUsageStore,
  localDayKey,
  readAppUsageEntries,
  readAppUsageOpens,
  readDailyTotals,
  recentDayKeys,
  shiftDayKey,
  weekdayLabel,
  type AppUsageStore
} from "@/lib/app-usage-storage";

/** 本 APP 自己也在被统计：这条记录用它的图标 id */
const SELF_ICON_ID = "screentime";

type ScreenTimeAppProps = {
  onClose: () => void;
  customApps?: InstalledCustomApp[];
};

const STYLES = `
.stx-root { padding: 6px 14px calc(28px + env(safe-area-inset-bottom, 0px)); font-size: 14px; color: var(--c-text, #797e85); }
.stx-datenav { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 2px 12px; }
.stx-navbtn { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 12px; border: 1px solid var(--c-card-border, #e0e0e0);
  background: var(--c-card, rgba(255,255,255,0.7)); color: var(--c-text-title, #2c3440); cursor: pointer; }
.stx-navbtn:disabled { opacity: 0.35; cursor: default; }
.stx-datecur { flex: 1; text-align: center; line-height: 1.35; }
.stx-datecur b { display: block; font-size: 15px; font-weight: 600; color: var(--c-text-title, #2c3440); letter-spacing: 0.02em; }
.stx-datecur span { font-size: 11px; opacity: 0.7; }
.stx-card { border-radius: 18px; border: 1px solid var(--c-card-border, #e0e0e0); background: var(--c-card, rgba(255,255,255,0.72));
  padding: 16px; margin-bottom: 14px; }
.stx-hero-label { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.65; }
.stx-hero-value { display: block; margin-top: 4px; font-size: 30px; line-height: 1.2; font-weight: 600;
  color: var(--c-text-title, #2c3440); letter-spacing: -0.01em; }
.stx-hero-sub { display: block; margin-top: 6px; font-size: 12px; opacity: 0.75; }
.stx-chart { display: flex; align-items: flex-end; gap: 6px; height: 74px; margin-top: 14px; }
.stx-chart-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 5px; background: none; border: 0; padding: 0;
  cursor: pointer; min-width: 0; }
.stx-chart-barwrap { width: 100%; height: 56px; display: flex; align-items: flex-end; justify-content: center; }
.stx-chart-bar { width: 68%; min-height: 3px; border-radius: 5px; background: var(--c-icon-active, #5b8fb9); opacity: 0.45;
  transition: opacity 160ms ease; }
.stx-chart-col[data-active="1"] .stx-chart-bar { opacity: 1; }
.stx-chart-col[data-today="1"] .stx-chart-bar { opacity: 0.85; }
.stx-chart-col[data-empty="1"] .stx-chart-bar { background: currentColor; opacity: 0.18; }
.stx-chart-lab { font-size: 10px; opacity: 0.6; white-space: nowrap; }
.stx-chart-col[data-active="1"] .stx-chart-lab { opacity: 1; font-weight: 600; color: var(--c-text-title, #2c3440); }
.stx-section { display: flex; align-items: baseline; justify-content: space-between; padding: 2px 4px 8px; }
.stx-section h3 { margin: 0; font-size: 13px; font-weight: 600; color: var(--c-text-title, #2c3440); }
.stx-section span { font-size: 11px; opacity: 0.6; }
.stx-list { display: flex; flex-direction: column; gap: 2px; border-radius: 18px; border: 1px solid var(--c-card-border, #e0e0e0);
  background: var(--c-card, rgba(255,255,255,0.72)); padding: 6px 12px; }
.stx-row { display: flex; gap: 10px; align-items: flex-start; padding: 10px 0; border-bottom: 1px solid rgba(128,128,128,0.12); }
.stx-row:last-child { border-bottom: 0; }
.stx-tile { flex: 0 0 auto; width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; overflow: hidden; }
.stx-tile-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.stx-glyph { width: 20px; height: 20px; display: block; }
.stx-glyph svg { width: 100%; height: 100%; display: block; }
.stx-row-main { flex: 1; min-width: 0; }
.stx-row-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.stx-row-name { font-size: 13.5px; font-weight: 500; color: var(--c-text-title, #2c3440); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.stx-row-dur { flex: 0 0 auto; font-size: 12.5px; font-variant-numeric: tabular-nums; color: var(--c-text-title, #2c3440); opacity: 0.85; }
.stx-bar-track { margin-top: 6px; height: 5px; border-radius: 3px; background: rgba(128,128,128,0.16); overflow: hidden; }
.stx-bar-fill { height: 100%; border-radius: 3px; transition: width 220ms ease; }
.stx-row-meta { margin-top: 5px; font-size: 10.5px; opacity: 0.62; }
.stx-empty { padding: 26px 6px; text-align: center; font-size: 12.5px; opacity: 0.6; line-height: 1.7; }
.stx-note { margin: 14px 4px 0; font-size: 10.5px; line-height: 1.8; opacity: 0.55; }
`;

function appTone(iconId: string, customApps: InstalledCustomApp[]): string {
  const customId = customAppIdFromIconId(iconId);
  if (customId) return "var(--c-icon-active, #5b8fb9)";
  const meta = (ICONS as Record<string, IconMeta | undefined>)[iconId];
  return meta?.tone || "var(--c-icon-active, #5b8fb9)";
}

function AppUsageTile({ iconId, customApps }: { iconId: string; customApps: InstalledCustomApp[] }) {
  const customId = customAppIdFromIconId(iconId);
  const app = customId ? customApps.find(item => item.id === customId) : undefined;
  return (
    <span className="stx-tile" style={{ background: appTone(iconId, customApps) }}>
      {app?.iconDataUrl ? (
        <img className="stx-tile-img" src={app.iconDataUrl} alt="" />
      ) : customId ? (
        <CustomAppGlyph seed={customId} className="stx-glyph" />
      ) : (
        <IconGlyph id={iconId as IconId} className="stx-glyph" />
      )}
    </span>
  );
}

export function ScreenTimeApp({ onClose, customApps = [] }: ScreenTimeAppProps) {
  const [store, setStore] = useState<AppUsageStore>(() => loadAppUsageStore());
  const [todayKey, setTodayKey] = useState(() => localDayKey());
  const [selectedDay, setSelectedDay] = useState(() => localDayKey());
  const [now, setNow] = useState(() => Date.now());
  // 打开本页这一刻起，本 APP 自己也在被计时；未结算的这段时间直接算进展示值
  const mountedAtRef = useRef(Date.now());

  // 每秒走一格：既刷「今天」跨天，也让正在使用的时长实时跳动
  useEffect(() => {
    const timer = window.setInterval(() => {
      const stamp = Date.now();
      setNow(stamp);
      const nextToday = localDayKey(new Date(stamp));
      setTodayKey(prev => (prev === nextToday ? prev : nextToday));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  // 回到前台时重读一次，看到别处刚结算的记录
  useEffect(() => {
    const reload = () => setStore(loadAppUsageStore());
    const onVisibility = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", onVisibility);
    reload();
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const minDayKey = useMemo(() => recentDayKeys(APP_USAGE_RETENTION_DAYS, new Date(now))[0], [now]);
  const weekKeys = useMemo(() => recentDayKeys(7, new Date(now)), [now]);
  const weekTotals = useMemo(() => readDailyTotals(store, weekKeys), [store, weekKeys]);

  const liveMs = selectedDay === todayKey ? Math.max(0, now - mountedAtRef.current) : 0;

  const entries = useMemo(() => {
    const base = readAppUsageEntries(store, selectedDay);
    if (liveMs < 1000) return base;
    const hasSelf = base.some(entry => entry.id === SELF_ICON_ID);
    const merged = hasSelf
      ? base.map(entry => (entry.id === SELF_ICON_ID ? { ...entry, ms: entry.ms + liveMs } : entry))
      : [...base, { id: SELF_ICON_ID, name: ICONS.screentime.label, ms: liveMs, opens: 1 }];
    return merged.sort((a, b) => b.ms - a.ms);
  }, [store, selectedDay, liveMs]);

  const totalMs = entries.reduce((sum, entry) => sum + entry.ms, 0);
  const storedOpens = readAppUsageOpens(store, selectedDay);
  const opensTotal = storedOpens + (liveMs >= 1000 ? 1 : 0);
  const maxMs = entries.reduce((max, entry) => Math.max(max, entry.ms), 0);
  const weekMax = Math.max(...weekTotals.map(item => item.ms), liveMs, 1);
  const canPrev = shiftDayKey(selectedDay, -1) >= minDayKey;
  const canNext = selectedDay < todayKey;

  return (
    <PageShell title="屏幕时间" onBack={onClose}>
      <>
        <style>{STYLES}</style>
        <div className="stx-root">
          <div className="stx-datenav">
            <button
              type="button"
              className="stx-navbtn"
              onClick={() => setSelectedDay(shiftDayKey(selectedDay, -1))}
              disabled={!canPrev}
              aria-label="前一天"
            >
              <ChevronLeft size={18} strokeWidth={2} />
            </button>
            <div className="stx-datecur">
              <b>{dayDisplayLabel(selectedDay, todayKey)}</b>
              <span>
                {selectedDay} 周{weekdayLabel(selectedDay)}
                {selectedDay === todayKey ? " · 进行中" : ""}
              </span>
            </div>
            <button
              type="button"
              className="stx-navbtn"
              onClick={() => setSelectedDay(shiftDayKey(selectedDay, 1))}
              disabled={!canNext}
              aria-label="后一天"
            >
              <ChevronRight size={18} strokeWidth={2} />
            </button>
          </div>

          <section className="stx-card">
            <span className="stx-hero-label">总使用时长</span>
            <span className="stx-hero-value">{formatUsageDuration(totalMs)}</span>
            <span className="stx-hero-sub">
              {entries.length > 0 ? `${entries.length} 个 APP · ${opensTotal} 次打开` : "这一天还没有使用记录"}
            </span>

            <div className="stx-chart">
              {weekTotals.map(item => {
                const ms = item.dayKey === todayKey ? Math.max(item.ms, liveMs) : item.ms;
                const height = ms > 0 ? Math.max(4, Math.round((ms / weekMax) * 56)) : 3;
                return (
                  <button
                    key={item.dayKey}
                    type="button"
                    className="stx-chart-col"
                    title={`${dayDisplayLabel(item.dayKey, todayKey)} ${formatUsageDuration(ms)}`}
                    data-active={item.dayKey === selectedDay ? "1" : "0"}
                    data-today={item.dayKey === todayKey ? "1" : "0"}
                    data-empty={ms > 0 ? "0" : "1"}
                    onClick={() => setSelectedDay(item.dayKey)}
                  >
                    <span className="stx-chart-barwrap">
                      <span className="stx-chart-bar" style={{ height }} />
                    </span>
                    <span className="stx-chart-lab">{weekdayLabel(item.dayKey)}</span>
                  </button>
                );
              })}
            </div>
            <span className="stx-hero-sub" style={{ marginTop: 2, fontSize: 10.5 }}>
              近 7 天{weekTotals.length > 0 ? ` · 共 ${formatUsageDuration(weekTotals.reduce((sum, item) => sum + item.ms, 0))}` : ""}
            </span>
          </section>

          <div className="stx-section">
            <h3>各 APP 使用时长</h3>
            {entries.length > 0 ? <span>按时长排序</span> : null}
          </div>

          <div className="stx-list">
            {entries.length === 0 ? (
              <div className="stx-empty">
                还没有这一天的记录。
                <br />
                打开任意 APP 用一会儿，回到桌面再点进来就能看到统计。
              </div>
            ) : (
              entries.map(entry => {
                const barPct = maxMs > 0 ? Math.max(2, Math.round((entry.ms / maxMs) * 100)) : 0;
                const sharePct = totalMs > 0 ? Math.round((entry.ms / totalMs) * 100) : 0;
                return (
                  <div className="stx-row" key={entry.id}>
                    <AppUsageTile iconId={entry.id} customApps={customApps} />
                    <div className="stx-row-main">
                      <div className="stx-row-top">
                        <span className="stx-row-name">{entry.name}</span>
                        <span className="stx-row-dur">{formatUsageDuration(entry.ms)}</span>
                      </div>
                      <div className="stx-bar-track">
                        <div
                          className="stx-bar-fill"
                          style={{ width: `${barPct}%`, background: appTone(entry.id, customApps) }}
                        />
                      </div>
                      <div className="stx-row-meta">
                        {entry.opens} 次打开 · 占 {sharePct}% · {formatUsageDurationCompact(entry.ms)}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <p className="stx-note">
            统计只覆盖这部手机里打开的 APP：切到别的 APP、返回桌面、页面切后台时都会结算，后台挂着的时间不计。
            记录只保留最近 {APP_USAGE_RETENTION_DAYS} 天，存在本机浏览器里，不走云端。
          </p>
        </div>
      </>
    </PageShell>
  );
}
