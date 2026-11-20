"use client";

import { ICONS, type IconId } from "./desktop-config";
import { loadInstalledCustomApps } from "./custom-app-storage";
import { toCustomAppIconId } from "./custom-app-types";
import { kvGet, kvSet } from "./kv-db";
import { loadPhoneCheckConfig } from "./phone-check";

const RULE_KEY = "ai_phone_inner_focus_v1";
const BLOCK_KEY = "ai_phone_inner_focus_blocks_v1";
export const INNER_FOCUS_CHANGED = "inner-focus-changed";
export type InnerFocusRule = { ids: string[]; start: number; end: number; until: number };
const SAFE_IDS = new Set(["settings", "qa", "chat", "group_chat", "calendar", "resources", "characters", "realitybridge", "checkphone", "callstats"]);
const SAFE_LABELS = new Set(["锁机台", "设置", "电话", "通话统计", "工坊"]);

export function listInnerFocusApps() {
  const study = new Set(loadPhoneCheckConfig().studyInnerApps);
  return [
    ...Object.values(ICONS).filter(app => !app.path && !app.placeholder && !SAFE_IDS.has(app.id)).map(app => ({ id: app.id, label: app.label })),
    ...loadInstalledCustomApps().map(app => ({ id: toCustomAppIconId(app.id), label: app.name })),
  ].filter(app => !SAFE_LABELS.has(app.label.trim()) && !study.has(app.label.trim()));
}

export function readInnerFocusRule(): InnerFocusRule | null {
  try {
    const value = JSON.parse(kvGet(RULE_KEY) || "null");
    if (!value || !Array.isArray(value.ids) || ![value.start, value.end, value.until].every(Number.isFinite)) return null;
    return { start: value.start, end: value.end, until: value.until, ids: value.ids.filter((id: unknown): id is string => typeof id === "string") };
  } catch { return null; }
}

export function saveInnerFocusRule(rule: InnerFocusRule): void {
  const previous = readInnerFocusRule();
  if (JSON.stringify(previous) === JSON.stringify(rule)) return;
  kvSet(RULE_KEY, JSON.stringify(rule));
  if (rule.ids.length === 0) kvSet(BLOCK_KEY, "[]");
  window.dispatchEvent(new Event(INNER_FOCUS_CHANGED));
}

function readBlocks(now: number): Array<[string, number]> {
  try {
    const value: unknown = JSON.parse(kvGet(BLOCK_KEY) || "[]");
    return Array.isArray(value) ? value.filter((row): row is [string, number] =>
      Array.isArray(row) && typeof row[0] === "string" && Number.isFinite(row[1]) && row[1] > now) : [];
  } catch { return []; }
}

export function innerFocusWindow(id: string, label: string, rule: InnerFocusRule | null, now: number): boolean {
  if (!rule || rule.until <= now || rule.start === rule.end || !rule.ids.includes(id)) return false;
  if (!label || SAFE_IDS.has(id) || SAFE_LABELS.has(label.trim()) || loadPhoneCheckConfig().studyInnerApps.includes(label.trim())) return false;
  const meta = ICONS[id as IconId];
  if (meta && (meta.placeholder || meta.path)) return false;
  const clock = new Date(now);
  const minute = clock.getHours() * 60 + clock.getMinutes();
  return rule.start < rule.end ? minute >= rule.start && minute < rule.end : minute >= rule.start || minute < rule.end;
}

export function innerFocusBlockedUntil(id: string, now: number): number {
  return readBlocks(now).find(row => row[0] === id)?.[1] ?? 0;
}

export function blockInnerFocusApp(id: string, until: number, now: number): void {
  kvSet(BLOCK_KEY, JSON.stringify([...readBlocks(now).filter(row => row[0] !== id), [id, until]]));
}
