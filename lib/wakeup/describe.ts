"use client";

// 给角色看的现状描述。
//
// 为什么要单独写：角色需要在对话里自然地提起「明早几点叫你」，
// 但它拿不到正确的时刻就会瞎编一个——那比不提更糟，
// 用户会按一个根本没排上的时间作息。

import { loadWakeupConfig, nextWakeupPlan } from "./storage";
import { readWakeupOutcomeNative } from "./native-bridge";

/** 给角色看的一句话现状（没有安排时也要如实说没有）。 */
export function describeWakeupForCharacter(now = Date.now()): string {
  const config = loadWakeupConfig();
  if (!config.enabled) {
    return "起床叫醒功能没开，你现在不能让 TA 被叫醒。不要假装安排上了。";
  }
  const plan = nextWakeupPlan(now);
  if (!plan) {
    return "目前没有安排叫醒。如果你答应了要叫 TA 起床，现在还没有排上——要么现在安排，要么别把话说满。";
  }
  const clock = (ms: number) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const voice = plan.audioDataUrl ? "会用你的声音念" : "用的是系统语音念";
  return `已安排：${clock(plan.at)} 叫 TA 起床，${voice}「${plan.speech}」。最多响 ${config.maxRounds} 轮。`;
}

/** 读某次叫醒的真实结果（响了没、几轮、是不是自己起来的）。 */
export function describeWakeupOutcome(planId: string): string {
  const outcome = readWakeupOutcomeNative(planId);
  return outcome || "还没有结果（可能还没到时间）";
}
