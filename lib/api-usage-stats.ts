"use client";

/**
 * token 用量统计：把底层调用日志聚合成「谁、哪个功能、烧了多少 token」。
 *
 * 为什么需要这一层：
 *   原始日志是一条条完整请求（含整段 prompt，单条可达几十 KB），
 *   人没法靠翻它回答「我今天 token 都花哪了」。这里只做聚合，
 *   不复制正文，输出体积很小，可以放心在设置页实时算。
 *
 * 一个必须说清的事实：
 *   本应用**不代理**你的模型调用。请求从浏览器/壳直连你配的 API 服务商，
 *   所以这里统计的是「本应用自己记录的调用」，不是你服务商账单的全部。
 *   同一把 key 若还配给了别的软件，那部分不在这里——只能去服务商控制台看。
 *   这一点在界面里必须写明，否则用户会以为数字对不上是统计出错。
 */

import type { DebugInfo } from "./api-log-store";

/** 一条日志归到的功能名。老记录没有 feature 字段时按旧规则兜底。 */
export function resolveLogFeature(log: DebugInfo): string {
  if (log.feature && log.feature.trim()) return log.feature.trim();
  if (log.source === "qa") return "工坊答疑";
  if (log.source === "background") {
    // 老记录把功能名塞在 characterName 里
    return log.characterName?.trim() || "后台功能（未标注）";
  }
  return log.characterName ? `聊天 · ${log.characterName}` : "聊天";
}

export type FeatureUsage = {
  feature: string;
  /** 调用次数 */
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 没拿到 usage 的调用（服务商没回 usage 字段时） */
  missingUsageCalls: number;
  lastAt: string;
};

export type UsageSummary = {
  totalCalls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  missingUsageCalls: number;
  /** 按 token 从多到少 */
  byFeature: FeatureUsage[];
  /** 时间范围（取日志里最早与最晚） */
  earliest: string;
  latest: string;
  /** 日志里出现过的不同模型 */
  models: { model: string; calls: number; totalTokens: number }[];
};

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 一次调用的 token 数：优先用服务商回的真实 usage，缺了就退回估算。 */
function tokensOf(log: DebugInfo): { prompt: number; completion: number; total: number; real: boolean } {
  const usage = log.usage;
  const prompt = num(usage?.prompt_tokens);
  const completion = num(usage?.completion_tokens);
  const total = num(usage?.total_tokens) || prompt + completion;
  if (total > 0) return { prompt, completion, total, real: true };
  return { prompt: 0, completion: 0, total: 0, real: false };
}

export function summarizeUsage(logs: DebugInfo[]): UsageSummary {
  const byFeature = new Map<string, FeatureUsage>();
  const byModel = new Map<string, { model: string; calls: number; totalTokens: number }>();

  let totalCalls = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;
  let missingUsageCalls = 0;

  for (const log of logs) {
    const feature = resolveLogFeature(log);
    const tokens = tokensOf(log);
    totalCalls += 1;
    totalPromptTokens += tokens.prompt;
    totalCompletionTokens += tokens.completion;
    totalTokens += tokens.total;
    if (!tokens.real) missingUsageCalls += 1;

    const entry = byFeature.get(feature) ?? {
      feature,
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      missingUsageCalls: 0,
      lastAt: log.timestamp,
    };
    entry.calls += 1;
    entry.promptTokens += tokens.prompt;
    entry.completionTokens += tokens.completion;
    entry.totalTokens += tokens.total;
    if (!tokens.real) entry.missingUsageCalls += 1;
    if (log.timestamp > entry.lastAt) entry.lastAt = log.timestamp;
    byFeature.set(feature, entry);

    const modelName = log.model?.trim() || "未知模型";
    const modelEntry = byModel.get(modelName) ?? { model: modelName, calls: 0, totalTokens: 0 };
    modelEntry.calls += 1;
    modelEntry.totalTokens += tokens.total;
    byModel.set(modelName, modelEntry);
  }

  const timestamps = logs.map(log => log.timestamp).filter(Boolean).sort();

  return {
    totalCalls,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    missingUsageCalls,
    byFeature: Array.from(byFeature.values()).sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls),
    earliest: timestamps[0] ?? "",
    latest: timestamps[timestamps.length - 1] ?? "",
    models: Array.from(byModel.values()).sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls),
  };
}

/** 只要某个时间点之后的日志（用于「今天 / 最近一小时」这类过滤）。 */
export function filterLogsSince(logs: DebugInfo[], sinceMs: number): DebugInfo[] {
  return logs.filter(log => {
    const t = new Date(log.timestamp).getTime();
    return Number.isFinite(t) && t >= sinceMs;
  });
}

/** 常用时间窗口。 */
export const USAGE_WINDOWS = [
  { id: "1h", label: "最近 1 小时", ms: 60 * 60 * 1000 },
  { id: "24h", label: "最近 24 小时", ms: 24 * 60 * 60 * 1000 },
  { id: "7d", label: "最近 7 天", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "all", label: "全部记录", ms: 0 },
] as const;

export type UsageWindowId = (typeof USAGE_WINDOWS)[number]["id"];

/** 千分位，读起来不费劲。 */
export function formatTokens(value: number): string {
  return value.toLocaleString("zh-CN");
}
