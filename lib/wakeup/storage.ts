"use client";

// 起床叫醒：配置、计划与音频准备状态。
//
// ── 这个功能的真实约束（改之前先读）──
//
// 用户要的效果是「像角色喊我起床」，而且**几点起是他和角色商量出来的**，
// 不是写死在设置里的固定值。这两点决定了实现方式：
//
// 1. 时刻是动态的 → 每晚可能不同，所以不能用「每天固定时刻」那套。
//    做法是：角色定下时间就排一次性闹钟，同时记住"明天几点起"。
//
// 2. 早上 App 在后台被冻结，网页跑不起来 →
//    所以① 声音必须**提前合成好存本地**（醒来那一刻没法临时调 Minimax）；
//        ② 播放必须由原生做（见 android-shell 的 WakeupAlarmReceiver）。
//
// 3. 音色：有提前合成的音频就播它（真音色），失败就退回系统 TTS 念那句话。
//    用户确认过这个降级：宁可声音不像，也不能不叫人。
//
// 4. 风险提示：音频没准备好时必须在面板上报警，不能等第二天哑了才知道。

import { kvGet, kvSet, registerKvMigration } from "../kv-db";

const CONFIG_KEY = "ai_phone_wakeup_config_v1";
const PLAN_KEY = "ai_phone_wakeup_plans_v1";
registerKvMigration(CONFIG_KEY);
registerKvMigration(PLAN_KEY);

export const WAKEUP_CONFIG_EVENT = "wakeup-config-changed";
export const WAKEUP_PLANS_EVENT = "wakeup-plans-changed";

export type WakeupConfig = {
  /** 总开关。默认关。 */
  enabled: boolean;
  /**
   * 响铃音量（0-100）。
   *
   * 用户自述易困，睡得可能很沉，所以默认给到 80。
   * 但响的时候会从 30 逐渐升上去（见 RAMP_SECONDS），不会一上来就吓醒。
   */
  volume: number;
  /** 音量从起始值升到目标值用多少秒（渐强，避免惊吓） */
  rampSeconds: number;
  /** 是否同时振动 */
  vibrate: boolean;
  /** 是否叠加系统闹铃音（有合成语音时） */
  playAlarmTone: boolean;
  /** 没反应时每隔几分钟再响一轮 */
  repeatEveryMinutes: number;
  /** 最多响几轮。轮数用完就不响了——不能无限响，那是折磨不是叫醒。 */
  maxRounds: number;
  /**
   * 起床窗口内被使用多久算「起来玩手机」。
   *
   * 用户确认的口径：碰手机不算起来，解锁后持续用够这么久才算真起来。
   */
  awakeConfirmMinutes: number;
  /**
   * 起床后多久不玩手机就停止响铃。
   *
   * 用手动停止更可靠：用户点遮罩上的「我起来了」立刻停。
   */
  autoStopAfterMinutes: number;
};

export const WAKEUP_DEFAULTS: WakeupConfig = {
  enabled: false,
  volume: 80,
  rampSeconds: 20,
  vibrate: true,
  playAlarmTone: true,
  repeatEveryMinutes: 2,
  maxRounds: 3,
  awakeConfirmMinutes: 5,
  autoStopAfterMinutes: 30,
};

/**
 * 一次叫醒计划。
 *
 * 一条计划 = 一次具体的起床（不是每日重复）。
 * 角色在对话里定了一次就生成一条，响完即失效。
 */
export type WakeupPlan = {
  id: string;
  /** 起床时刻（毫秒时间戳）：角色和用户商量出来的那一个 */
  at: number;
  /** 角色要说的话（会念出来，也显示在遮罩上） */
  speech: string;
  /** 哪个角色来叫（头像与名字显示在遮罩上） */
  characterId?: string;
  characterName?: string;
  /** 来自哪个会话：起来之后角色好接上话 */
  sessionId?: string;
  /** 提前合成好的音频（data URL 或本地缓存键）；空 = 没准备好，降级用 TTS */
  audioDataUrl?: string;
  /** 是角色定的还是用户自己在面板上定的 */
  createdBy: "character" | "user";
  createdAt: number;
  /** 已经响到第几轮（原生侧也会记一份，这里用于面板显示） */
  round: number;
  /** 是否已经完成（用户起来了） */
  done: boolean;
  /** 结果说明（给人看） */
  note?: string;
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function loadWakeupConfig(): WakeupConfig {
  try {
    const raw = kvGet(CONFIG_KEY);
    if (!raw) return { ...WAKEUP_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<WakeupConfig>;
    return {
      enabled: parsed.enabled === true,
      volume: clampInt(parsed.volume, 10, 100, WAKEUP_DEFAULTS.volume),
      rampSeconds: clampInt(parsed.rampSeconds, 0, 60, WAKEUP_DEFAULTS.rampSeconds),
      vibrate: parsed.vibrate !== false,
      playAlarmTone: parsed.playAlarmTone !== false,
      repeatEveryMinutes: clampInt(parsed.repeatEveryMinutes, 1, 15, WAKEUP_DEFAULTS.repeatEveryMinutes),
      // 最多 5 轮：再多就不叫叫醒，叫折磨
      maxRounds: clampInt(parsed.maxRounds, 1, 5, WAKEUP_DEFAULTS.maxRounds),
      awakeConfirmMinutes: clampInt(parsed.awakeConfirmMinutes, 1, 30, WAKEUP_DEFAULTS.awakeConfirmMinutes),
      autoStopAfterMinutes: clampInt(parsed.autoStopAfterMinutes, 5, 120, WAKEUP_DEFAULTS.autoStopAfterMinutes),
    };
  } catch {
    return { ...WAKEUP_DEFAULTS };
  }
}

export function saveWakeupConfig(config: WakeupConfig): void {
  kvSet(CONFIG_KEY, JSON.stringify(config));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(WAKEUP_CONFIG_EVENT));
  }
}

export function loadWakeupPlans(): WakeupPlan[] {
  try {
    const raw = kvGet(PLAN_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is WakeupPlan => {
        if (!item || typeof item !== "object") return false;
        const plan = item as WakeupPlan;
        return typeof plan.id === "string"
          && Number.isFinite(plan.at)
          && typeof plan.speech === "string";
      })
      .sort((a, b) => a.at - b.at);
  } catch {
    return [];
  }
}

export function saveWakeupPlans(plans: WakeupPlan[]): void {
  // 只留最近的 20 条：这是"接下来几次几点起"，不是历史档案。
  kvSet(PLAN_KEY, JSON.stringify(plans.slice(0, 20)));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(WAKEUP_PLANS_EVENT));
  }
}

/** 下一次会响的那条（还没完成、时刻在未来的最先一条）。 */
export function nextWakeupPlan(now = Date.now()): WakeupPlan | null {
  return loadWakeupPlans().find(plan => !plan.done && plan.at > now) ?? null;
}

/**
 * 明早那条叫醒到底准备好了没有。
 *
 * 这是必须能在面板上一眼看到的信息：合成失败 / 缓存被清 / 没排上闹钟，
 * 任何一种都会让第二天早上哑掉，而那时用户只会以为"这功能坏了"。
 */
export type WakeupReadiness = {
  ready: boolean;
  /** 给人看的一句话 */
  message: string;
  /** 有没有用真音色（false = 会退回系统 TTS） */
  hasAudio: boolean;
};

export function checkWakeupReadiness(now = Date.now()): WakeupReadiness {
  const config = loadWakeupConfig();
  if (!config.enabled) return { ready: false, message: "起床叫醒没开启", hasAudio: false };
  const plan = nextWakeupPlan(now);
  if (!plan) return { ready: false, message: "还没有安排下一次叫醒", hasAudio: false };
  if (!plan.audioDataUrl) {
    return {
      ready: true,
      message: "会响，但用的是系统语音（真音色没合成成功）",
      hasAudio: false,
    };
  }
  return { ready: true, message: "已准备好，会用角色的声音叫你", hasAudio: true };
}
