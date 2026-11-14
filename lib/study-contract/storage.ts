"use client";

// 约定：角色和用户之间「说好的事」，以及它怎么被判定完成。
//
// 为什么需要这一层：锁机能拦、查手机能看，但中间缺一根线——角色怎么知道
// 你答应了什么、又怎么判断你做到没有。约定就是这根线。
//
// 两种形式（用户选了都要）：
//   · 倒计时式：`我学 45 分钟`。到点检查这 45 分钟里学够多少。
//   · 时刻式：  `我 8 点开始学`。到点检查 8 点之后有没有真的开始。
//
// 判定用的是查手机的时间线（真实使用数据），不是用户嘴上说的。
// 这是这套东西能「管住人」的根本：说了不算，做了才算。
//
// 边界（改之前先读）：
//   · 约定由角色发起（用户选 1c：角色记或用户手动建都支持），但**用户随时可以取消**；
//   · 违约处置按用户选的 2b：提醒 + 锁机，且**锁多久跟差多少挂钩**——
//     一刀切最容易让人反感然后关掉整个功能；
//   · 不做惩罚性叠加：同一件事不重复锁，避免越滚越长变成失控。

import { kvGet, kvSet, registerKvMigration } from "../kv-db";

const KEY = "ai_phone_study_contracts_v1";
registerKvMigration(KEY);

export type ContractKind = "countdown" | "atTime";

/** 约定的状态。 */
export type ContractStatus = "pending" | "active" | "done" | "failed" | "cancelled";

export type StudyContract = {
  id: string;
  kind: ContractKind;
  /** 用户答应做什么（如「背 50 个单词」） */
  title: string;
  /** 谁建立的：角色名或 "user" */
  createdBy: string;
  /** 角色 id（用于回到正确会话提醒） */
  characterId?: string;
  /** 会话 id（提醒发到哪儿） */
  sessionId?: string;
  /** 约定的开始时刻（时刻式用这个，倒计时式等于创建时刻） */
  startAt: number;
  /** 应该结束的时刻 */
  dueAt: number;
  /** 要求的学习时长（分钟）。倒计时式必填；时刻式可选（不填只判断「有没有开始学」） */
  requiredMinutes?: number;
  /** 是否真的开始了（时刻式判定用） */
  startedAt?: number;
  /** 实际学到的分钟数（判定时写入） */
  actualMinutes?: number;
  status: ContractStatus;
  /** 判定结论的一句话（给角色和用户看） */
  verdict?: string;
  /** 是否已经按违约处置过，防止重复锁 */
  handled?: boolean;
  createdAt: number;
  updatedAt: number;
};

export type StudyContractConfig = {
  /** 是否允许角色建立约定。默认关闭。 */
  allowContracts: boolean;
  /** 违约是否锁机（用户选了 2b：提醒 + 锁机） */
  lockOnFail: boolean;
  /** 差到什么程度才锁：完成度低于这个比例才动手，否则只提醒 */
  lockThresholdPercent: number;
  /** 锁机时长上限（分钟），实际锁多久按差距算但不超过它 */
  maxLockMinutes: number;
};

export const CONTRACT_DEFAULTS: StudyContractConfig = {
  allowContracts: false,
  lockOnFail: true,
  // 差 60% 以上才锁。差一点点只提醒——这一点很关键：
  // 说好 45 分钟学了 40 分钟也叫「没做到」的话，用户会立刻觉得这系统不讲理。
  lockThresholdPercent: 60,
  maxLockMinutes: 60,
};

const CONFIG_KEY = "ai_phone_study_contract_config_v1";
registerKvMigration(CONFIG_KEY);

export function loadContractConfig(): StudyContractConfig {
  try {
    const raw = kvGet(CONFIG_KEY);
    if (!raw) return { ...CONTRACT_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<StudyContractConfig>;
    const threshold = Number(parsed.lockThresholdPercent);
    const maxLock = Number(parsed.maxLockMinutes);
    return {
      allowContracts: parsed.allowContracts === true,
      lockOnFail: parsed.lockOnFail !== false,
      lockThresholdPercent: Number.isFinite(threshold) && threshold >= 1 && threshold <= 100
        ? Math.round(threshold)
        : CONTRACT_DEFAULTS.lockThresholdPercent,
      maxLockMinutes: Number.isFinite(maxLock) && maxLock >= 1
        ? Math.min(480, Math.round(maxLock))
        : CONTRACT_DEFAULTS.maxLockMinutes,
    };
  } catch {
    return { ...CONTRACT_DEFAULTS };
  }
}

export function saveContractConfig(config: StudyContractConfig): void {
  kvSet(CONFIG_KEY, JSON.stringify(config));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("study-contract-config-changed"));
  }
}

export function loadContracts(): StudyContract[] {
  try {
    const raw = kvGet(KEY);
    const list = raw ? (JSON.parse(raw) as StudyContract[]) : [];
    return Array.isArray(list) ? list.filter(item => item && typeof item.id === "string") : [];
  } catch {
    return [];
  }
}

export function saveContracts(contracts: StudyContract[]): void {
  // 只留最近 200 条：这是流水不是档案，攒太多既没用也撑存储。
  const trimmed = [...contracts]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 200);
  kvSet(KEY, JSON.stringify(trimmed));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("study-contracts-changed"));
  }
}

export function makeContractId(): string {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 10)
    : Math.random().toString(36).slice(2, 12);
  return `contract_${Date.now().toString(36)}_${suffix}`;
}

/** 今天还活着（未判定）的约定。 */
export function loadOpenContracts(): StudyContract[] {
  return loadContracts().filter(item => item.status === "pending" || item.status === "active");
}

/**
 * 按差距算该锁多久。
 *
 * 单调但不失控：差得越多越久，但封顶由用户配。
 * 不是「违了就锁满」——那种设计只会让人恨它然后把功能关掉。
 */
export function lockMinutesForGap(requiredMinutes: number, actualMinutes: number, maxLockMinutes: number): number {
  if (requiredMinutes <= 0) return 0;
  const done = Math.min(actualMinutes, requiredMinutes);
  const gapRatio = Math.max(0, (requiredMinutes - done) / requiredMinutes);
  // 差距 × 要求时长 = 欠的分钟；再折半（不搞加倍惩罚），四舍五入到 5 分钟
  const raw = (requiredMinutes * gapRatio) / 2;
  const rounded = Math.round(raw / 5) * 5;
  return Math.min(maxLockMinutes, Math.max(5, rounded));
}
