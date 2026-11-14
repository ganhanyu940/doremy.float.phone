"use client";

// 新建意图：角色在对话里说「好，你去洗吧，我盯着」时调用；
// 用户自己也能在面板里手动加一条。
//
// 单独一个文件而不是塞进 engine：engine 只负责「判定要不要锁」，
// 这里是「怎么把用户那句话变成一个可执行的看守」。两件事的改动理由不同，
// 混在一起以后调参数会互相干扰。

import { loadIntentLockConfig, loadIntentRecords, saveIntentRecords, type IntentRecord } from "./storage";

/** 生成一个够用的 id（不需要全局唯一，只要本地不撞）。 */
function makeId(): string {
  return `intent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export type CreateIntentInput = {
  /** 用户原话说的那件事，如「去洗澡」。原样保留，不要改写成「洗澡任务」。 */
  title: string;
  /** 谁记的 */
  createdBy?: "character" | "user";
  characterId?: string;
  sessionId?: string;
  /** 用户明确说的时长（分钟）。不传就用配置里的默认值。 */
  minutes?: number;
  /**
   * 只记下不锁（「我提醒你一下」）。
   *
   * 留这个口子是因为用户要的是"管我"，但偶尔他也只想被提醒。
   * 实现上就是锁 0 分钟——判定照走，只是不动手锁。
   */
  remindOnly?: boolean;
  now?: number;
};

export type CreateIntentResult =
  | { ok: true; record: IntentRecord }
  | { ok: false; reason: string };

/**
 * 建一条意图。
 *
 * 三条来自用户的规则写在这里，别处不要重复实现：
 *   · 时长「尽量短」：用户没说就给默认 20 分钟；他自己说了就照办。
 *   · 新盖旧：人一次只能做一件事，留着旧意图只会误锁。
 *   · 有事耽搁就不锁：过了有效窗口自动作废（见 expireAt）。
 */
export function createIntent(input: CreateIntentInput): CreateIntentResult {
  const config = loadIntentLockConfig();
  if (!config.enabled) {
    return { ok: false, reason: "「说一句就记着」这个功能还没开（设置 → 说了就管我）" };
  }

  const title = String(input.title ?? "").trim().slice(0, 40);
  if (!title) return { ok: false, reason: "需要一句「你要去做什么」，不能空着" };

  const now = input.now ?? Date.now();
  const requested = Number(input.minutes);
  // 用户明确说了时长就照办（上限 120）；没说就用默认的短时长。
  const lockMinutes = Number.isFinite(requested) && requested > 0
    ? Math.min(120, Math.max(1, Math.round(requested)))
    : config.defaultMinutes;

  const records = loadIntentRecords();

  // 新盖旧：把还没结束的旧意图标成被替换，而不是删掉——
  // 保留痕迹才能事后说清"当时为什么会锁你"。
  const superseded = records.map(item => (
    item.status === "pending"
      ? { ...item, status: "cancelled" as const, note: "被新的意图取代", updatedAt: now }
      : item
  ));

  const record: IntentRecord = {
    id: makeId(),
    title,
    createdBy: input.createdBy ?? "user",
    characterId: input.characterId,
    sessionId: input.sessionId,
    createdAt: now,
    checkAt: now + config.graceMinutes * 60_000,
    expireAt: now + config.expireMinutes * 60_000,
    lockMinutes: input.remindOnly ? 0 : lockMinutes,
    status: "pending",
    updatedAt: now,
  };

  saveIntentRecords([record, ...superseded]);
  return { ok: true, record };
}

/** 给角色看的一句话现状（让它知道自己在盯什么）。 */
export function describeOpenIntentsForCharacter(now = Date.now()): string {
  const open = loadIntentRecords().filter(item => item.status === "pending" || item.status === "locked");
  if (!open.length) return "目前没有在盯你做什么。";
  const clock = (ms: number) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const lines = open.map(item => {
    if (item.status === "locked") {
      return `· 「${item.title}」：已经锁上了，锁到 ${item.lockUntil ? clock(item.lockUntil) : "未知"}。`;
    }
    const left = Math.max(0, Math.round((item.checkAt - now) / 60_000));
    return `· 「${item.title}」：${left > 0 ? `${left} 分钟后` : "马上"}看看你有没有去做。`;
  });
  return [
    "你正在盯这几件事：",
    ...lines,
    "注意：这是你替 TA 记下的、TA 自己说要去做的事。不要拿它当把柄反复念。",
  ].join("\n");
}
