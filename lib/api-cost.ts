"use client";

/**
 * 模型调用费用估算：把 token 用量换算成钱。
 *
 * 为什么要单独一层，而不是塞进 api-usage-stats：
 *   用量统计是「事实」（服务商回了多少 token），费用是「估算」（按你填的单价乘）。
 *   两者混在一起最容易出错——用户改一次单价，历史账单数字全变了。
 *   所以这里把「单价配置」和「计算」隔离出来，统计层只负责给你干净的 token 数。
 *
 * 三个必须写清楚的假设，否则用户会觉得算错了：
 *   ① 单价是用户自己填的，我们不知道服务商的真实价格，也不去猜。
 *   ② 缓存读取 token 单独计价：多数服务商对命中缓存的输入打折
 *      （OpenAI/DeepSeek 常见 1/10），不给单独价就等于按原价算，会偏高。
 *   ③ 服务商没回 usage 的调用，按量计费算不出钱（token 未知），
 *      按次计费照样算（次是确定的）。这个差异必须在界面上标出来。
 */

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import type { DebugInfo } from "./api-log-store";
import { estimateTokens } from "./token-counter";

const PRICING_KEY = "ai_phone_api_cost_pricing_v1";
registerKvMigration(PRICING_KEY);

/** 计费方式：按次（固定价）或按量（token 单价） */
export type CostMode = "perCall" | "perToken";

/**
 * 一套价格规则。
 *
 * matchModel 为空 = 默认规则，兜住所有没单独配置的模型。
 * 有值时按「包含」匹配（不分大小写），例如 "deepseek-chat" 能命中
 * "deepseek-chat" 和 "deepseek-chat-0324" 这类带后缀的版本名。
 */
export type CostRule = {
  id: string;
  /** 模型名关键词；空字符串表示这是默认规则 */
  matchModel: string;
  mode: CostMode;
  /** 按次计费：每次调用多少钱（元） */
  perCallPrice: number;
  /** 按量计费：输入单价（元 / 百万 token） */
  inputPrice: number;
  /** 按量计费：输出单价（元 / 百万 token） */
  outputPrice: number;
  /** 按量计费：缓存命中读取的输入单价（元 / 百万 token）；0 = 按原价计入输入 */
  cachedInputPrice: number;
};

export type CostPricingConfig = {
  currency: string;
  rules: CostRule[];
};

function newRuleId(): string {
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 默认价格：对齐常见国产模型档位，仅作起点，用户应改成自己的真实单价。 */
export const DEFAULT_PRICING: CostPricingConfig = {
  currency: "¥",
  rules: [
    {
      id: "rule-default",
      matchModel: "",
      mode: "perToken",
      perCallPrice: 0.01,
      inputPrice: 2,
      outputPrice: 8,
      cachedInputPrice: 0.5,
    },
  ],
};

/** 兜底：内存里缓存一份，避免每次渲染都读 localStorage + JSON.parse */
let cachedPricing: CostPricingConfig | null = null;

export function loadPricing(): CostPricingConfig {
  if (cachedPricing) return cachedPricing;
  try {
    const raw = typeof window !== "undefined" ? kvGet(PRICING_KEY) : null;
    if (!raw) {
      cachedPricing = clonePricing(DEFAULT_PRICING);
      return cachedPricing;
    }
    const parsed = JSON.parse(raw) as Partial<CostPricingConfig>;
    const rules = Array.isArray(parsed.rules) && parsed.rules.length > 0
      ? parsed.rules.map(normalizeRule)
      : clonePricing(DEFAULT_PRICING).rules;
    cachedPricing = {
      currency: typeof parsed.currency === "string" && parsed.currency.trim() ? parsed.currency : "¥",
      rules,
    };
    return cachedPricing;
  } catch {
    cachedPricing = clonePricing(DEFAULT_PRICING);
    return cachedPricing;
  }
}

export function savePricing(config: CostPricingConfig): void {
  cachedPricing = config;
  try {
    kvSet(PRICING_KEY, JSON.stringify(config));
  } catch {
    /* 存不下不影响本次会话的计算 */
  }
}

/** 让外部（如清空数据）能丢弃内存缓存。 */
export function resetPricingCache(): void {
  cachedPricing = null;
}

function clonePricing(config: CostPricingConfig): CostPricingConfig {
  return { currency: config.currency, rules: config.rules.map(rule => ({ ...rule })) };
}

/** 单价统一按非负数处理：用户手滑输入负数不能把账单算成负的。 */
function nonNegative(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function normalizeRule(raw: Partial<CostRule>): CostRule {
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : newRuleId(),
    matchModel: typeof raw.matchModel === "string" ? raw.matchModel.trim() : "",
    mode: raw.mode === "perCall" ? "perCall" : "perToken",
    perCallPrice: nonNegative(raw.perCallPrice),
    inputPrice: nonNegative(raw.inputPrice),
    outputPrice: nonNegative(raw.outputPrice),
    cachedInputPrice: nonNegative(raw.cachedInputPrice),
  };
}

export function createEmptyRule(): CostRule {
  return normalizeRule({ id: newRuleId() });
}

/**
 * 为某个模型挑规则。
 *
 * 命中顺序：最长的 matchModel 优先 → 默认规则兜底。
 * 用「最长」而不是「数组顺序」，是因为用户可能同时配了 "gpt" 和 "gpt-4o-mini"，
 * 后者更具体，应该赢。
 */
export function resolveRuleFor(model: string | undefined, config: CostPricingConfig): CostRule {
  const name = (model || "").trim().toLowerCase();
  let best: CostRule | null = null;
  let bestLen = -1;

  for (const rule of config.rules) {
    const key = rule.matchModel.trim().toLowerCase();
    if (!key) continue;
    if (name.includes(key) && key.length > bestLen) {
      best = rule;
      bestLen = key.length;
    }
  }
  if (best) return best;

  const fallback = config.rules.find(rule => !rule.matchModel.trim());
  return fallback ?? config.rules[0] ?? normalizeRule({});
}

export type TokenBreakdown = {
  prompt: number;
  completion: number;
  /** 命中缓存的输入部分（已含在 prompt 里，不重复计数） */
  cached: number;
  total: number;
  /** 服务商是否回了真实 usage */
  real: boolean;
};

function numField(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 没拿到 usage 时按日志里的消息文本估算。
 *
 * 为什么非要有这一步：工坊、以及所有走流式的调用，很多中转站不肯在流里
 * 回 usage 字段。一条都没 usage 的话，按量计费整页都是 0，用户只会觉得
 * 「这个功能是坏的」。估算值虽然不精确，但它能回答「哪个功能贵」这个问题——
 * 而估算结果会通过 estimated 标记在界面上标出来，不会被当成账单。
 */
function estimateLogTokens(log: DebugInfo): { prompt: number; completion: number } {
  const messages = Array.isArray(log.messages) ? log.messages : [];
  let prompt = 0;
  for (const message of messages) {
    prompt += estimateTokens(typeof message.content === "string" ? message.content : "") + 4;
  }
  const completion = log.rawResponse ? estimateTokens(String(log.rawResponse)) : 0;
  return { prompt, completion };
}

export function tokensOfLog(log: DebugInfo): TokenBreakdown {
  const usage = log.usage;
  const prompt = numField(usage?.prompt_tokens);
  const completion = numField(usage?.completion_tokens);
  const total = numField(usage?.total_tokens) || prompt + completion;
  // 缓存命中数不可能超过输入总数，超了说明服务商字段含义不同，按输入上限截断
  const cached = Math.min(numField(usage?.cached_tokens), prompt);
  if (total > 0) return { prompt, completion, cached, total, real: true };

  const est = estimateLogTokens(log);
  return {
    prompt: est.prompt,
    completion: est.completion,
    cached: 0,
    total: est.prompt + est.completion,
    real: false,
  };
}

/**
 * 单次调用的费用。
 *
 * 按量模式下缓存部分要拆出来单独计价：如果 cachedInputPrice 配成 0，
 * 说明用户认为缓存读取是免费的；不拆的话这部分会按 inputPrice 全额计费，
 * 白白高估一截。
 */
export function costOfLog(log: DebugInfo, config: CostPricingConfig): number {
  const rule = resolveRuleFor(log.model, config);
  if (rule.mode === "perCall") return rule.perCallPrice;

  const t = tokensOfLog(log);
  // 估算值也照样计费：没有 usage 不代表没花钱，只是我们算得不准。
  // 界面上会用 estimated 标记区分，这里的数字只用于排序和粗略对比。
  if (t.total <= 0) return 0;

  const cachedRate = rule.cachedInputPrice;
  // 缓存单价为 0 时按「免费」处理；否则按填的价算
  const cachedCost = (t.cached / 1_000_000) * cachedRate;
  const freshInput = Math.max(0, t.prompt - t.cached);
  const freshCost = (freshInput / 1_000_000) * rule.inputPrice;
  const outputCost = (t.completion / 1_000_000) * rule.outputPrice;
  return cachedCost + freshCost + outputCost;
}

/** 金额格式化：小额保留 6 位小数，大额保留 2 位，避免一串 0 或精度丢失。 */
export function formatMoney(value: number, currency: string): string {
  if (!Number.isFinite(value)) return `${currency}0`;
  if (value === 0) return `${currency}0`;
  if (value < 0.0001) return `${currency}${value.toExponential(2)}`;
  if (value < 1) return `${currency}${value.toFixed(6)}`;
  if (value < 100) return `${currency}${value.toFixed(4)}`;
  return `${currency}${value.toFixed(2)}`;
}

export type CostSummary = {
  total: number;
  /** 有真实 usage、金额可信的调用数 */
  pricedCalls: number;
  /** 没拿到 usage、金额是按日志文本估算的调用数 */
  estimatedCalls: number;
  /** 按次计费的调用数（金额确定，与 token 无关） */
  perCallCalls: number;
  byFeature: { feature: string; cost: number; estimatedCalls: number }[];
};

/**
 * 聚合费用。
 *
 * byFeature 的 key 复用统计层的功能名解析，保证和「按功能统计」那一块对得上，
 * 否则两个列表的功能名会不一致，用户没法对照。
 */
export function summarizeCost(
  logs: DebugInfo[],
  config: CostPricingConfig,
  resolveFeature: (log: DebugInfo) => string,
): CostSummary {
  let total = 0;
  let pricedCalls = 0;
  let estimatedCalls = 0;
  let perCallCalls = 0;
  const featureMap = new Map<string, { cost: number; estimatedCalls: number }>();

  for (const log of logs) {
    const rule = resolveRuleFor(log.model, config);
    const tokens = tokensOfLog(log);
    const cost = costOfLog(log, config);
    const feature = resolveFeature(log);

    total += cost;
    const isEstimated = rule.mode === "perToken" && !tokens.real;
    if (rule.mode === "perCall") perCallCalls += 1;
    else if (tokens.real) pricedCalls += 1;
    else estimatedCalls += 1;

    const prev = featureMap.get(feature) ?? { cost: 0, estimatedCalls: 0 };
    featureMap.set(feature, {
      cost: prev.cost + cost,
      estimatedCalls: prev.estimatedCalls + (isEstimated ? 1 : 0),
    });
  }

  return {
    total,
    pricedCalls,
    estimatedCalls,
    perCallCalls,
    byFeature: Array.from(featureMap.entries())
      .map(([feature, info]) => ({ feature, cost: info.cost, estimatedCalls: info.estimatedCalls }))
      .sort((a, b) => b.cost - a.cost),
  };
}
