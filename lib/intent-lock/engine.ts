"use client";

// 临时意图锁的判定与执行（唯一决策点）。
//
// 一句话概括这件事：
//   「你说要去做一件事 → 记下来 → 过一会儿看看手机还动不动 →
//     还在动就锁，让你去做」
//
// 用户举的两个例子（睡觉前的闹钟、带手机进浴室玩 20 分钟）本质是同一件事，
// 所以这里**不做任何场景特化**：洗澡、睡觉、吃饭、写作业、等人，走同一条路。
//
// ── 判定口径（用户已经拍板，不要自作聪明加"智能"判断）──
//
// 1. 一刀切。用户原话：「最好的办法是一刀切，完全专注」。
//    不说"你在用学习应用所以不算玩"——说了去做事，那段时间除了他自己填的
//    放行清单，一律算玩。默认清单为空，等于除电话/桌面/系统设置全锁。
//
// 2. 中途干什么都锁。用户明确否掉了"发现是学习应用就软处理"。
//    理由很实在：用学习当借口拖延，恰恰是他要防的那种。
//
// 3. 判定依据是「自他说了之后，手机有没有被真实使用过」，
//    而不是「此刻屏幕亮不亮」。前者能回答"他到底放下手机没有"，
//    后者只要手机在口袋里就算亮着，没有意义。
//
// 4. 有事耽搁了就不锁。过了 expireMinutes 还没结算就作废，
//    绝不攒着旧意图秋后算账——那是让人莫名其妙被锁的主要原因。
//
// ── 已知盲区（必须对用户说清楚，不能假装能读心）──
//   · 手机放客厅、人在刷平板 → 检测不到使用，不锁（漏）；
//   · 手机带进浴室只是放着没碰 → 没有使用记录，不锁（正好符合预期）；
//   · 一直在同一个页面不动 → 时间线不刷新，可能被判成"已放下"。

import { appendPerceptionLog } from "../perception/storage";
import { unlockPhone, getPhoneLockStatus, lockPhoneFor } from "../phone-lock";
import { loadAppUsageTimeline, supportsUsageTimeline } from "../perception/bridge";
import { loadInnerAppSpans } from "../phone-check";
import {
  cancelIntentCheckNative,
  readIntentOutcomeNative,
} from "./native-bridge";
import {
  loadIntentLockConfig,
  loadIntentRecords,
  saveIntentRecords,
  type IntentLockConfig,
  type IntentRecord,
} from "./storage";

/** float 自己的包名。它在前台时要进一步看内部打开的是哪个应用。 */
const FLOAT_PACKAGE = "app.floatphone.shell";

export type IntentCheckResult = {
  /** 自他说了之后，手机有没有被"算作玩"的使用 */
  active: boolean | null;
  /** 给用户/角色看的一句话（active 为 null 时说明为什么判断不了） */
  detail: string;
  /** 命中放行清单而被忽略的段数（面板上用来验证清单配对了没有） */
  allowedCount: number;
};

/**
 * 自这个意图建立之后，手机有没有被真实使用过。
 *
 * 只看 [record.createdAt, now] 这段窗口——这不是"最近 N 分钟"，
 * 而是"你说完之后这几分钟"。差别很关键：后者会把你说之前的使用算进来，
 * 于是你刚说完就被判还在玩。
 */
export function checkIntentActivity(
  config: IntentLockConfig,
  record: IntentRecord,
  now = Date.now(),
): IntentCheckResult {
  if (!supportsUsageTimeline()) {
    return { active: null, detail: "读不到使用情况（需要 1.0.36 以上的壳）", allowedCount: 0 };
  }
  const segments = loadAppUsageTimeline(300);
  if (!segments.length) {
    return { active: null, detail: "读不到使用记录（可能没授予「使用情况访问」）", allowedCount: 0 };
  }

  const allowPackages = new Set(config.allowPackages);
  const allowInner = new Set(config.allowInnerApps);
  // 内部应用切换点只读一次：循环里逐段读会反复扫同一份存储。
  const innerSpans = loadInnerAppSpans();
  const from = record.createdAt;
  // 只检查宽限期窗口 [createdAt, checkAt] 内有没有放下手机，
  // 避免用户真去做完事、半小时后回来拿起手机时被回前台兜底误判成"一直在玩"。
  const to = record.checkAt > record.createdAt
    ? Math.min(now, record.checkAt + 60_000)
    : now;

  let usedSeconds = 0;
  let allowedCount = 0;
  let lastLabel = "";

  for (const segment of segments) {
    // 与窗口求交，而不是"开始时刻落在窗口内"：
    // 你说话那一刻正在用的应用，也是你说完之后还在用的。
    const start = Math.max(segment.startAt, from);
    const end = Math.min(segment.endAt, to);
    if (end <= start) continue;
    const seconds = (end - start) / 1000;

    if (allowPackages.has(segment.package)) {
      allowedCount += 1;
      continue;
    }

    let innerApp: string | undefined;
    if (segment.package === FLOAT_PACKAGE) {
      innerApp = innerSpans.find(
        span => span.at >= segment.startAt && span.at <= segment.endAt,
      )?.app;
    }
    // float 内部：命中放行清单才放过，其它一律算玩。
    // 没记到内部应用时**算玩**——这里和「查手机」的口径相反：
    // 那边宁可不冤枉人，这边宁可不放过。用户的目的是管住自己。
    if (innerApp && allowInner.has(innerApp)) {
      allowedCount += 1;
      continue;
    }

    usedSeconds += seconds;
    lastLabel = innerApp ? `${segment.label} / ${innerApp}` : segment.label;
  }

  // 少于 20 秒的触碰不算"在玩"：点亮屏幕看一眼时间不该被判违规。
  if (usedSeconds < 20) {
    return {
      active: false,
      detail: allowedCount > 0
        ? `你放下手机了（有 ${allowedCount} 段在放行清单里，不算玩）`
        : "你放下手机了",
      allowedCount,
    };
  }

  const minutes = Math.max(1, Math.round(usedSeconds / 60));
  return {
    active: true,
    detail: `说完之后手机还用了约 ${minutes} 分钟（最后停在${lastLabel || "某个应用"}）`,
    allowedCount,
  };
}

/** 把一条记录写回存储（按 id 覆盖）。 */
function updateRecord(id: string, patch: Partial<IntentRecord>): IntentRecord | null {
  const records = loadIntentRecords();
  const index = records.findIndex(item => item.id === id);
  if (index < 0) return null;
  const next: IntentRecord = { ...records[index], ...patch, updatedAt: Date.now() };
  records[index] = next;
  saveIntentRecords(records);
  return next;
}

export type SettleOutcome = {
  record: IntentRecord;
  /** 这次结算真的动手锁了吗 */
  locked: boolean;
  /** 给人看的一句话 */
  message: string;
};

/**
 * 结算一条到期意图。
 *
 * 幂等：状态一旦离开 pending 就不会再处理，所以 60 秒轮询是安全的。
 */
export function settleIntent(record: IntentRecord, now = Date.now()): SettleOutcome | null {
  if (record.status !== "pending") return null;
  if (record.checkAt > now) return null;

  // 若原生闹钟在后台已经结算过这条意图，直接采纳原生结论，不再用当前时间重复判定
  const nativeOutcome = readIntentOutcomeNative(record.id).trim();
  if (nativeOutcome) {
    const nativeLocked = nativeOutcome.includes("已锁") || nativeOutcome.includes("照样锁");
    const nativeSkipped = nativeOutcome.includes("不锁");
    const nextStatus: IntentRecord["status"] = nativeLocked
      ? "locked"
      : nativeSkipped
        ? "skipped"
        : "failed";
    const updated = updateRecord(record.id, {
      status: nextStatus,
      note: nativeOutcome,
    });
    return updated
      ? { record: updated, locked: nativeLocked, message: `「${record.title}」——${nativeOutcome}` }
      : null;
  }

  const config = loadIntentLockConfig();

  // 过期：说了之后拖太久还没结算，直接作废。
  // 用户的原话是「中途有事耽搁了就不锁了，等下一次开始再触发」。
  if (record.expireAt <= now) {
    const updated = updateRecord(record.id, {
      status: "expired",
      note: "过了有效时间，这次不锁了",
    });
    return updated
      ? { record: updated, locked: false, message: `「${record.title}」已经过了有效时间，这次不锁了` }
      : null;
  }

  const activity = checkIntentActivity(config, record, now);
  if (activity.active === false) {
    const updated = updateRecord(record.id, {
      status: "skipped",
      note: activity.detail,
    });
    return updated
      ? { record: updated, locked: false, message: `「${record.title}」——${activity.detail}，不锁` }
      : null;
  }

  // active === null（读不到记录）：**照样锁**。
  // 理由：没给使用情况权限的人正是最需要被拦的那批，读不到就放过等于
  // 功能在最该生效的场合静默失效。这与睡前锁的取舍保持一致。
  const unknown = activity.active === null;

  const status = getPhoneLockStatus();
  if (!status.available) {
    const updated = updateRecord(record.id, {
      status: "failed",
      note: "锁机通道不可用（无障碍没开启）",
    });
    return updated
      ? { record: updated, locked: false, message: `「${record.title}」想锁但锁不上：无障碍服务没开启` }
      : null;
  }

  // 刻意**没有**每日上限：用户明确要求过「我就是需要它管我所以我才要他锁」。
  // 加个"今天锁够 6 次就不锁了"等于替他打了折扣，那不是他要的东西。
  const reason = `说好的「${record.title}」，先把手机放下`;
  const result = lockPhoneFor(record.lockMinutes, reason, "intent");
  if (!result.ok) {
    const updated = updateRecord(record.id, {
      status: "failed",
      note: result.message || "锁机失败",
    });
    return updated
      ? { record: updated, locked: false, message: `「${record.title}」锁机失败：${result.message || "未知原因"}` }
      : null;
  }

  const updated = updateRecord(record.id, {
    status: "locked",
    lockUntil: result.until,
    note: unknown ? "读不到使用记录，按设置照样锁" : activity.detail,
  });
  logIntent(`意图锁机：「${record.title}」锁 ${record.lockMinutes} 分钟（${activity.detail}）`);
  return updated
    ? { record: updated, locked: true, message: `「${record.title}」——${activity.detail}，已锁 ${record.lockMinutes} 分钟` }
    : null;
}

/** 扫一遍所有到期意图并结算。轮询与「回到前台」都调它。 */
export function settleDueIntents(now = Date.now()): SettleOutcome[] {
  const config = loadIntentLockConfig();
  if (!config.enabled) return [];
  const due = loadIntentRecords().filter(
    item => item.status === "pending" && item.checkAt <= now,
  );
  const outcomes: SettleOutcome[] = [];
  for (const record of due) {
    const outcome = settleIntent(record, now);
    if (outcome) outcomes.push(outcome);
  }
  return outcomes;
}

/**
 * 用户主动打卡「我做完了」。
 *
 * 立刻解锁 + 标记 done。这一步不只是解除锁定，
 * 它还是给角色的一条**正面信号**：他自己做到了，不是被逼着做完的。
 * 角色对这两件事的反应本来就该不一样。
 */
export function markIntentDone(id: string, now = Date.now()): { ok: boolean; message: string } {
  const records = loadIntentRecords();
  const record = records.find(item => item.id === id);
  if (!record) return { ok: false, message: "找不到这条记录" };

  let unlocked = false;
  if (record.status === "locked") {
    const result = unlockPhone("manual");
    unlocked = result.ok;
    if (!result.ok) {
      return { ok: false, message: `打卡记下了，但解锁失败：${result.message || "未知原因"}` };
    }
  }

  cancelIntentCheckNative(id);
  updateRecord(id, {
    status: "done",
    doneAt: now,
    note: record.status === "locked" ? "被锁着的时候做完了，自己打卡" : "主动打卡完成",
  });
  logIntent(`意图完成：「${record.title}」${unlocked ? "（已解锁）" : ""}`);
  return {
    ok: true,
    message: unlocked
      ? `记下了：「${record.title}」做完了，已解锁`
      : `记下了：「${record.title}」做完了`,
  };
}

/** 用户主动取消（计划有变）。不锁、不追问、不记过。 */
export function cancelIntent(id: string, now = Date.now()): { ok: boolean; message: string } {
  const records = loadIntentRecords();
  const record = records.find(item => item.id === id);
  if (!record) return { ok: false, message: "找不到这条记录" };
  if (record.status === "locked") {
    // 已经被锁着了再取消：解开，但如实记成「取消」而不是「完成」。
    unlockPhone("manual");
  }
  cancelIntentCheckNative(id);
  updateRecord(id, {
    status: "cancelled",
    note: "计划有变，取消了",
    doneAt: now,
  });
  logIntent(`意图取消：「${record.title}」`);
  return { ok: true, message: `已取消「${record.title}」，不会锁你` };
}

/** 续锁：锁着的时候他想再要一点时间（比如还没洗完）。 */
export function extendIntent(id: string, extraMinutes: number): { ok: boolean; message: string } {
  const minutes = Math.max(1, Math.min(120, Math.round(extraMinutes)));
  const result = lockPhoneFor(minutes, "再说一会儿，还没做完", "intent");
  if (!result.ok) return { ok: false, message: result.message || "续时失败" };
  updateRecord(id, {
    lockUntil: result.until,
    lockMinutes: minutes,
    note: `续了 ${minutes} 分钟`,
  });
  return { ok: true, message: `又锁了 ${minutes} 分钟` };
}

function logIntent(payload: string): void {
  try {
    appendPerceptionLog({
      id: `intent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      at: new Date().toISOString(),
      capability: "deviceAction",
      type: "意图锁",
      payload: payload.slice(0, 200),
      outcome: "已执行",
    });
  } catch {
    /* 记流水失败不影响锁机本身 */
  }
}
