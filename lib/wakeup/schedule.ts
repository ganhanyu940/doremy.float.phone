"use client";

// 起床叫醒：安排一次叫醒（含提前合成音频）。
//
// ── 为什么音频必须提前合成 ──
//
// 用户要的是「像角色喊我起床」。但早上 6:30 那一刻 App 在后台被冻结：
//   · 网页发不出 Minimax 请求；
//   · 原生不能自己调 Minimax——那需要 API key，而 key 绝不能塞进 APK
//     （会被反编译提取，等于把用户的付费额度公开）。
//
// 所以唯一可行的做法是：**睡前（App 还活着）就把那句话合成好、存成本地音频**，
// 早上原生直接播这个文件。
//
// 代价要说清楚：这句话在睡前就定死了，早上不能临时改。
// 对用户来说其实正好——睡前那次对话里角色说一句「明早我叫你」很自然。
//
// 合成失败时**不阻止叫醒**：退回系统 TTS 念同一句话（用户已确认）。
// 宁可声音不像，也不能不叫人。

import { loadVoiceConfigs } from "../settings-storage";
import { resolveVoiceConfig, synthesizeSpeech } from "../tts-service";
import {
  loadWakeupConfig,
  loadWakeupPlans,
  saveWakeupPlans,
  type WakeupPlan,
} from "./storage";
import {
  scheduleWakeupNative,
  syncWakeupPlansNative,
  type NativeWakeupPlan,
} from "./native-bridge";

function makePlanId(): string {
  return `wake_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 用配置好的语音 API 把这句话合成成音频。
 *
 * 失败返回空串——调用方据此退回 TTS，并把这个状态写进计划里，
 * 让面板能显示「明早会用系统语音叫你」而不是等第二天才发现。
 */
async function synthesizeWakeupVoice(text: string, characterId?: string): Promise<string> {
  try {
    // 先按角色解析绑定的音色——用户要的就是「这个角色喊我」，
    // 用别的音色念等于换了个人。
    // 解析不到才退回任意一条可用配置（总比没有声音好）。
    let voice = characterId ? resolveVoiceConfig(characterId, "chat") : null;
    if (!voice) {
      const configs = loadVoiceConfigs();
      voice = configs.find(item => item.provider === "Minimax" || item.provider === "OpenAI") ?? null;
    }
    if (!voice) return "";

    const blob = await synthesizeSpeech(text, voice);
    if (!blob || blob.size <= 0) return "";

    // 原生播放要的是 data URL（它自己解码落盘再播）。
    // 只接受 audio/* 的结果；别的类型存下来也播不了。
    if (blob.type && !blob.type.startsWith("audio/")) return "";
    return await blobToDataUrl(blob);
  } catch {
    // 任何失败都不阻止叫醒：退回系统 TTS 念同一句话。
    return "";
  }
}

/** Blob → data URL（原生侧只认这个形式）。 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise(resolve => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = () => resolve("");
      reader.readAsDataURL(blob);
    } catch {
      resolve("");
    }
  });
}

export type ScheduleWakeupInput = {
  /** 起床时刻（毫秒）。由角色和用户商量决定。 */
  at: number;
  /** 角色要说的那句话（会念出来，也显示在遮罩上） */
  speech: string;
  characterId?: string;
  characterName?: string;
  sessionId?: string;
  createdBy?: "character" | "user";
};

export type ScheduleWakeupResult =
  | { ok: true; plan: WakeupPlan; hasAudio: boolean; message: string }
  | { ok: false; reason: string };

/**
 * 安排一次起床叫醒。
 *
 * 三步缺一不可：先把话合成成音频 → 写进计划 → 让原生排闹钟。
 * **任何一步失败都要如实返回**，尤其是"闹钟没排上"——
 * 那等于明早没人叫你，用户只会以为功能坏了。
 */
export async function scheduleWakeup(input: ScheduleWakeupInput): Promise<ScheduleWakeupResult> {
  const config = loadWakeupConfig();
  if (!config.enabled) {
    return { ok: false, reason: "起床叫醒还没开（设置 → 健康系统 → 起床叫醒）" };
  }
  const now = Date.now();
  if (!Number.isFinite(input.at) || input.at <= now) {
    return { ok: false, reason: "起床时间必须晚于现在" };
  }
  // 超过 24 小时的不收：这是"明早几点起"，不是长期日程。
  if (input.at - now > 26 * 3600 * 1000) {
    return { ok: false, reason: "只能安排 24 小时内的叫醒，太远的到时候再说吧" };
  }
  const speech = String(input.speech ?? "").trim().slice(0, 200);
  if (!speech) {
    return { ok: false, reason: "需要一句起床时要说的话" };
  }

  const audioDataUrl = await synthesizeWakeupVoice(speech, input.characterId);

  const plan: WakeupPlan = {
    id: makePlanId(),
    at: input.at,
    speech,
    characterId: input.characterId,
    characterName: input.characterName,
    sessionId: input.sessionId,
    audioDataUrl: audioDataUrl || undefined,
    createdBy: input.createdBy ?? "character",
    createdAt: now,
    round: 0,
    done: false,
  };

  // 同一时间只留最近的几条：这是"接下来几次"，不是档案。
  const plans = [plan, ...loadWakeupPlans().filter(item => !item.done && item.at > now)]
    .sort((a, b) => a.at - b.at)
    .slice(0, 10);
  saveWakeupPlans(plans);

  const scheduled = scheduleWakeupNative(plan.id, plan.at);
  if (!scheduled) {
    // 如实报失败：闹钟没排上，明早不会响。
    return {
      ok: false,
      reason: "计划已记下，但闹钟没排上（需要 1.0.38 以上的 App，且允许「闹钟和提醒」权限）",
    };
  }

  return {
    ok: true,
    plan,
    hasAudio: Boolean(audioDataUrl),
    message: audioDataUrl
      ? `定好了：${formatAt(plan.at)} 会用角色的声音叫你`
      : `定好了：${formatAt(plan.at)} 会叫你（真音色没合成成功，会用系统语音念这句话）`,
  };
}

/** 把网页侧所有未完成的计划整份推给原生（回到前台时对齐一次）。 */
export function syncWakeupPlansToNative(now = Date.now()): void {
  const config = loadWakeupConfig();
  const plans = loadWakeupPlans().filter(plan => !plan.done && plan.at > now);
  const payloads: NativeWakeupPlan[] = plans.map(plan => ({
    id: plan.id,
    at: plan.at,
    speech: plan.speech,
    characterName: plan.characterName ?? "",
    audioDataUrl: plan.audioDataUrl ?? "",
    volume: config.volume,
    rampSeconds: config.rampSeconds,
    vibrate: config.vibrate,
    playAlarmTone: config.playAlarmTone,
    repeatEveryMinutes: config.repeatEveryMinutes,
    maxRounds: config.maxRounds,
  }));
  syncWakeupPlansNative(payloads);
}

function formatAt(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const clock = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return `今天 ${clock}`;
  if (isTomorrow) return `明天 ${clock}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${clock}`;
}
