"use client";

// 约定的判定与处置：唯一决策点。
//
// 分工：
//   storage.ts  存什么、怎么算锁多久（纯函数）
//   engine.ts   什么算「做到了」、什么时候动手、动手之前还要过哪些门控
//   原生        只管执行锁定
//
// 判定依据是**真实使用数据**（查手机的时间线），不是用户嘴上说的。
// 这正是这套东西的价值：说了不算，做了才算。
//
// 两条判定规则：
//   · 倒计时式：从 startAt 到 dueAt 之间，学习类应用的时长有没有到 requiredMinutes。
//   · 时刻式：  dueAt 之前有没有真正开始学（学习类应用出现过 ≥ 3 分钟）。
//     没填 requiredMinutes 的只看「有没有开始」；填了就同时看时长。

import {
  buildPhoneCheckReport,
  loadPhoneCheckConfig,
  type ClassifiedSegment,
} from "../phone-check";
import { loadPhoneLockConfig } from "../device-lock/storage";
import { runCharacterLock } from "../device-lock/engine";
import { appendPerceptionLog } from "../perception/storage";
import {
  loadContractConfig,
  loadContracts,
  lockMinutesForGap,
  saveContracts,
  type StudyContract,
} from "./storage";

/** 一个窗口里累计学了多少秒（与窗口求交，不是按开始时刻归属）。 */
function studiedSecondsIn(segments: ClassifiedSegment[], from: number, to: number): number {
  let total = 0;
  for (const segment of segments) {
    // 只算学习类（真实学习应用 + float 内部命中学习名单的）
    const isStudy = segment.kind === "study" || segment.kind === "float";
    if (!isStudy) continue;
    // 与窗口求交，而不是「开始时刻落在窗口内」——
    // 否则「8:00 开始学，7:58 就在学了」这种情况会被判成没学。
    const start = Math.max(segment.startAt, from);
    const end = Math.min(segment.endAt, to);
    if (end > start) total += (end - start) / 1000;
  }
  return total;
}

export type ContractEvaluation = {
  contract: StudyContract;
  /** 是否判定为完成 */
  passed: boolean;
  actualMinutes: number;
  requiredMinutes: number;
  /** 给用户/角色看的一句话 */
  verdict: string;
};

/**
 * 判一条约定。
 *
 * 只判「到点了」的约定（dueAt ≤ now）——没到点的不能提前判失败，
 * 否则用户一建立约定就被判违约，这功能立刻没法用。
 */
export function evaluateContract(
  contract: StudyContract,
  segments: ClassifiedSegment[],
  now = Date.now(),
): ContractEvaluation | null {
  if (contract.status !== "pending" && contract.status !== "active") return null;
  if (contract.dueAt > now) return null;

  const required = contract.kind === "countdown"
    ? Math.max(1, Math.round(contract.requiredMinutes ?? 0))
    : Math.max(0, Math.round(contract.requiredMinutes ?? 0));

  // 两种形式都取 [startAt, dueAt] 整段：用户提前开始也该认。
  const actualSeconds = studiedSecondsIn(segments, contract.startAt, contract.dueAt);
  const actualMinutes = Math.round(actualSeconds / 60);

  if (contract.kind === "atTime" && required === 0) {
    // 时刻式 + 没填时长：只问「有没有真的开始过」。
    // 门槛 3 分钟：点开就关不算开始，否则「打开应用截个图交差」就能通关。
    const started = actualMinutes >= 3;
    return {
      contract,
      passed: started,
      actualMinutes,
      requiredMinutes: 0,
      verdict: started
        ? `做到了：${contract.title}，实际学了 ${actualMinutes} 分钟。`
        : `没做到：${contract.title}，说好的时间到了但几乎没有学（${actualMinutes} 分钟）。`,
    };
  }

  const passed = actualMinutes >= required;
  return {
    contract,
    passed,
    actualMinutes,
    requiredMinutes: required,
    verdict: passed
      ? `做到了：${contract.title}，目标 ${required} 分钟，实际学了 ${actualMinutes} 分钟。`
      : `没做到：${contract.title}，目标 ${required} 分钟，实际只学了 ${actualMinutes} 分钟。`,
  };
}

export type ContractSettlement = {
  evaluation: ContractEvaluation;
  /** 是否真的动了锁机 */
  locked: boolean;
  /** 锁了多久（分钟） */
  lockMinutes?: number;
  /** 没锁的原因（如实说明，不静默） */
  lockSkippedReason?: string;
};

/**
 * 判定 + 处置一条到期约定。
 *
 * 处置的门控比判定多两层——判定只是「事实」，动锁机需要用户明确授权过：
 *   ① 用户开了「违约锁机」
 *   ② 完成度低于用户设的阈值（差一点点只提醒）
 *   ③ 锁机本身可用了（角色锁机授权 + 无障碍就绪）
 * 任一不过都不锁，但要留下原因，绝不静默跳过。
 */
export function settleContract(contract: StudyContract, now = Date.now()): ContractSettlement | null {
  const checkConfig = loadPhoneCheckConfig();
  const report = buildPhoneCheckReport(checkConfig);
  const evaluation = evaluateContract(contract, report.segments, now);
  if (!evaluation) return null;

  const contractConfig = loadContractConfig();
  const updated: StudyContract = {
    ...contract,
    status: evaluation.passed ? "done" : "failed",
    actualMinutes: evaluation.actualMinutes,
    verdict: evaluation.verdict,
    updatedAt: now,
  };

  let locked = false;
  let lockMinutes: number | undefined;
  let lockSkippedReason: string | undefined;

  if (!evaluation.passed && !contract.handled) {
    const required = evaluation.requiredMinutes;
    const percent = required > 0
      ? Math.round((evaluation.actualMinutes / required) * 100)
      : (evaluation.actualMinutes >= 3 ? 100 : 0);

    if (!contractConfig.lockOnFail) {
      lockSkippedReason = "用户没开「违约锁机」，只提醒不锁";
    } else if (percent >= contractConfig.lockThresholdPercent) {
      lockSkippedReason = `完成度 ${percent}%，高于阈值 ${contractConfig.lockThresholdPercent}%，只提醒不锁`;
    } else {
      const lockConfig = loadPhoneLockConfig();
      if (!lockConfig.allowCharacterLock) {
        lockSkippedReason = "角色锁机没被授权（设置 → 角色管我），只提醒不锁";
      } else {
        const minutes = required > 0
          ? lockMinutesForGap(required, evaluation.actualMinutes, contractConfig.maxLockMinutes)
          : 10;
        const reason = `${contract.title}：说好 ${required > 0 ? `${required} 分钟` : "要做到"}，只做了 ${evaluation.actualMinutes} 分钟`;
        const outcome = runCharacterLock(
          minutes,
          reason,
          contract.createdBy === "user" ? undefined : contract.createdBy,
        );
        if (outcome.ok) {
          locked = true;
          lockMinutes = minutes;
          updated.handled = true;
        } else {
          lockSkippedReason = outcome.reason ?? "锁机失败";
        }
      }
    }
    updated.handled = updated.handled || locked;
  }

  saveContracts(loadContracts().map(item => (item.id === contract.id ? updated : item)));

  try {
    appendPerceptionLog({
      id: `contract_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      at: new Date(now).toISOString(),
      capability: "deviceAction",
      type: evaluation.passed ? "约定完成" : "约定未完成",
      payload: `${contract.title}｜${evaluation.verdict}${locked ? `｜已锁 ${lockMinutes} 分钟` : ""}`.slice(0, 200),
      outcome: locked ? "已处置" : "仅记录",
    });
  } catch {
    // 记流水失败不影响判定结果
  }

  return { evaluation, locked, lockMinutes, lockSkippedReason };
}

/**
 * 扫一遍所有到期的约定并处置。
 *
 * 由聊天侧的定时器/消息轮询顺带调用（不新造一个常驻定时器：
 * 网页在后台会被系统节流，多一个定时器只是多一份耗电）。
 * 返回这一轮真正判定掉的约定，供调用方决定要不要让角色说一句。
 */
export function settleDueContracts(now = Date.now()): ContractSettlement[] {
  const due = loadContracts().filter(item =>
    (item.status === "pending" || item.status === "active") && item.dueAt <= now,
  );
  if (!due.length) return [];
  const results: ContractSettlement[] = [];
  for (const contract of due) {
    try {
      const settled = settleContract(contract, now);
      if (settled) results.push(settled);
    } catch {
      // 单条失败不该拖累其它约定
    }
  }
  return results;
}

/** 给角色看当前所有未完成的约定。 */
export function describeOpenContracts(): string {
  const open = loadContracts().filter(item => item.status === "pending" || item.status === "active");
  if (!open.length) return "现在没有还没完成的约定。";
  const clock = (ms: number) => {
    const date = new Date(ms);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  };
  return open.map(item => {
    const target = item.kind === "countdown"
      ? `倒计时 ${Math.max(1, Math.round(item.requiredMinutes ?? 0))} 分钟`
      : `${clock(item.startAt)} 开始`;
    return `- ${item.title}｜${target}｜${clock(item.startAt)}–${clock(item.dueAt)}`;
  }).join("\n");
}
