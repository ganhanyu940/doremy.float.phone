"use client";

// 健康系统：所有「什么时候管你」的规则，统一在这里声明。
//
// ── 为什么要有这一层（这是重构的直接原因）──
//
// 最初我把睡前锁和意图锁做成了两套各自为政的东西：
//   睡前锁  BedtimeScheduler + BedtimeAlarmReceiver + bedtime-lock/*
//   意图锁  IntentScheduler  + IntentAlarmReceiver  + intent-lock/*
// 用户一句话点破了问题：「她们都是锁机的一种，只是触发方式不同」。
//
// 三套并列的后果是实打实的：
//   · 放行清单会有三份，用户在哪儿配的都记不清；
//   · 判定口径会有三种，同一个"算不算在玩"在不同功能里答案不一样；
//   · 加第四种规则（连续学太久、早起赖床）就要写第四套调度。
//
// 所以正确的结构是：**一个执行器 + 多个触发源 + 一套规则**。
//   · 执行器：LockGuard（只负责"锁"这个动作，它已经稳定了，不动）
//   · 触发源：固定时刻 / 声明意图 / 时长累计 / 起床窗口 —— 本文件声明
//   · 规则：每条触发源带自己的放行清单、动作类型、文案
//
// ── 与用户确认过的硬要求（改之前先读）──
//   · **不设每日上限**。用户原话「我就是需要它管我所以我才要他锁」。
//   · 动作不只是锁：还有「提醒」和「叫醒」。
//   · 一刀切：说了去做事，那段时间除了规则自己的放行清单，一律算玩。
//   · 连续学太久也要锁（不是只提醒）。

/** 规则触发后要做什么。 */
export type DisciplineAction =
  /** 锁机（带时长与理由） */
  | { type: "lock"; minutes: number; reason: string }
  /** 只提醒，不锁（给"该起来走走"这种用） */
  | { type: "remind"; message: string }
  /** 叫醒：响铃 + 振动 + 念一句角色的话 + 盖遮罩 */
  | { type: "wake"; reason: string };

/** 规则的触发方式。这是「三套变一套」的关键抽象。 */
export type DisciplineTrigger =
  /** 每天固定时刻（睡前锁） */
  | { kind: "dailyAt"; hour: number; minute: number; endHour: number; endMinute: number }
  /** 用户声明意图后过 N 分钟检查一次（洗澡、学习） */
  | { kind: "afterIntent"; graceMinutes: number; lockMinutes: number }
  /** 连续做某事超过 N 分钟后触发（连续学习太久） */
  | { kind: "continuous"; minutes: number }
  /** 起床窗口内被使用（早起赖床） */
  | { kind: "wakeWindow"; hour: number; minute: number; windowMinutes: number };

export type DisciplineRuleKind =
  /** 睡前不睡 */
  | "bedtime"
  /** 声明意图（洗澡、学习等通用） */
  | "intent"
  /** 连续学太久 */
  | "longStudy"
  /** 早起 */
  | "wakeup";

export type DisciplineRule = {
  id: string;
  kind: DisciplineRuleKind;
  /** 面板上显示的名字 */
  label: string;
  /** 一句话说明它的判定口径（面板直接显示，让用户知道它凭什么管我） */
  usage: string;
  /** 放行清单：这些应用在此期间不算"在玩" */
  allowInnerApps: string[];
  allowPackages: string[];
  /** 触发后的动作 */
  action: DisciplineAction;
};

/**
 * 规则的默认值。
 *
 * 注意 bedtime 的放行清单**默认是空的**：用户说过「洗澡就洗澡，出来再听歌不行吗」，
 * 睡前同理——熬夜刷题也是熬夜，不算学习。想放行什么自己加。
 */
export const DISCIPLINE_RULES: DisciplineRule[] = [
  {
    id: "bedtime",
    kind: "bedtime",
    label: "睡前不睡",
    usage: "到了你设的时间，如果手机还在被用，就锁到起床时间。真睡了不锁。",
    allowInnerApps: [],
    allowPackages: [],
    action: { type: "lock", minutes: 0, reason: "这个点该睡了，先把手机放下" },
  },
  {
    id: "intent",
    kind: "intent",
    label: "说了就管我",
    usage: "你说要去做一件事，过几分钟看看手机还动不动；还在动就锁。",
    allowInnerApps: [],
    allowPackages: [],
    action: { type: "lock", minutes: 0, reason: "说好的事，先把手机放下" },
  },
  {
    id: "longStudy",
    kind: "longStudy",
    label: "连续学太久",
    usage: "连着学超过设定时长，就锁一会儿让你起来动动——坐太久比玩手机更伤。",
    allowInnerApps: [],
    allowPackages: [],
    action: { type: "lock", minutes: 10, reason: "起来走两步，坐太久了" },
  },
  {
    id: "wakeup",
    kind: "wakeup",
    label: "起床叫醒",
    usage: "到点响铃、振动、念一句角色的话。你一直不起来就一直响。",
    allowInnerApps: [],
    allowPackages: [],
    action: { type: "wake", reason: "该起了" },
  },
];

/** 按 id 取规则（找不到给一个安全默认，避免调用方到处判空）。 */
export function findDisciplineRule(id: string): DisciplineRule | undefined {
  return DISCIPLINE_RULES.find(rule => rule.id === id);
}
