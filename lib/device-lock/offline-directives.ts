"use client";

// 线下模式（聊天内线下轮次 + 独立「剧情」APP）的单轮锁机与意图锁隐藏指令。
//
// 为什么线下不用多轮工具调用：
//   线下模式每轮生成数百至上千字小说体正文（<content> + <summary>），
//   走多轮工具会让耗时与 Token 翻倍，还会打断长文标签结构。
//   因此在「权限 + 内置能力 + 原生锁机通道」全部就绪时，直接把当前锁机状态
//   与单行隐藏指令注入提示词；模型在写出“收走你手机 / 记下你要去做的事”剧情时，
//   在末尾附一行隐藏标记即可当场触发，解析层自动剥离标记，不污染正文与摘要。

import {
  DEVICE_LOCK_CAPABILITY_ID,
  INTENT_LOCK_CAPABILITY_ID,
  getInternalCapability,
} from "../internal-capability-storage";
import { loadCharacters } from "../character-storage";
import { executeIntentLockTool } from "../discipline/tools";
import { loadIntentLockConfig } from "../intent-lock";
import { getPhoneLockStatus } from "../phone-lock";
import {
  checkCharacterLockAvailability,
  describePhoneLockStatus,
  humanizeLockMinutes,
  runCharacterLock,
  runCharacterUnlock,
} from "./engine";
import { loadPhoneLockConfig } from "./storage";

export type OfflineLockDirectiveContext = {
  characterId?: string;
  characterName?: string;
  sessionId?: string;
};

function isDirectLockReady(): boolean {
  const cap = getInternalCapability(DEVICE_LOCK_CAPABILITY_ID);
  if (!cap || !cap.enabled || cap.mode === "off") return false;
  return checkCharacterLockAvailability().available;
}

function isIntentLockReady(): boolean {
  const cap = getInternalCapability(INTENT_LOCK_CAPABILITY_ID);
  if (!cap || !cap.enabled || cap.mode === "off") return false;
  if (!loadIntentLockConfig().enabled) return false;
  return getPhoneLockStatus().available;
}

/**
 * 生成注入到聊天「线下模式」与「剧情」APP 系统提示词里的锁机/待办规则。
 * 未授权或无障碍未开启时返回空串——绝不教角色输出必然失败的锁机标记。
 */
export function buildOfflineLockPromptHint(): string {
  const canLock = isDirectLockReady();
  const canIntent = isIntentLockReady();
  if (!canLock && !canIntent) return "";

  const lines: string[] = [
    "# 现实手机管束能力（隐藏控制指令）",
    "当前虽处于线下见面/剧情叙事模式，你依然可以直接联动对方现实中的真实手机。控制指令写在回复最末尾（如有 <content> 则写在 </content> 之前或全文最末尾均可），系统执行后会自动隐藏，不会展示在正文或摘要中；不要在正文里解释指令格式：",
  ];

  if (canLock) {
    const cfg = loadPhoneLockConfig();
    lines.push(
      `- 当前手机状态：${describePhoneLockStatus()}（单次锁定上限 ${humanizeLockMinutes(cfg.maxMinutes)}）`,
      "- 【直接锁住手机】：当剧情中你决定没收/扣下对方手机、督促对方专注学习或去休息时，另起一行输出：[锁机:分钟数|锁屏画面上对TA说的一句话理由]（例如：[锁机:45|去把这套卷子写完，不许摸鱼]）。分钟数为正整数。",
      "- 【提前解锁手机】：仅当手机正处于锁定中、且对方确实完成了任务或有合理理由需要提前解开时，另起一行输出：[解锁:提前放开的一句话理由]（例如：[解锁:题做完了，准你玩会儿]）。",
    );
  }

  if (canIntent) {
    const intentCfg = loadIntentLockConfig();
    lines.push(
      `- 【记下对方要去做的事（说了就管我）】：仅当对方自己明确表示现在要去做某件事（如洗澡、背书、写作业、吃饭、睡觉）时，另起一行输出：[记下待办:事项名称] 或 [记下待办:事项名称|锁机分钟数]（例如：[记下待办:洗澡|20]）。系统会在 ${intentCfg.graceMinutes} 分钟后检查TA是否放下了手机，还在玩就自动锁上。严禁替对方编造待办，也严禁把记待办当成威胁或惩罚。`,
    );
  }

  return lines.join("\n");
}

const LOCK_PATTERN = /\[锁机\s*[:：]\s*(\d+)\s*[|｜,，]\s*([^\]\n]+)\]/g;
const UNLOCK_PATTERN = /\[解锁\s*[:：]\s*([^\]\n]+)\]/g;
const INTENT_PATTERN = /\[记下待办\s*[:：]\s*([^\]|\n｜]+)(?:\s*[|｜,，]\s*(\d+))?\s*\]/g;
const LEFTOVER_DIRECTIVE_PATTERN = /\[(?:锁机|解锁|记下待办)\s*[:：][^\]]*\]/g;

function resolveActorName(context?: OfflineLockDirectiveContext): string {
  if (context?.characterName?.trim()) return context.characterName.trim();
  if (context?.characterId) {
    const found = loadCharacters().find(c => c.id === context.characterId);
    if (found?.name) return found.name;
  }
  return "";
}

/**
 * 只剥离控制标记、不触发动作（用于流式预览或历史重渲染）。
 */
export function stripOfflineLockDirectives(text: string): string {
  if (!text) return text;
  return text
    .replace(LOCK_PATTERN, "")
    .replace(UNLOCK_PATTERN, "")
    .replace(INTENT_PATTERN, "")
    .replace(LEFTOVER_DIRECTIVE_PATTERN, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 从线下模式 / 剧情模式生成的原始输出中提取并执行锁机与意图锁指令，返回剥离标记后的干净文本。
 */
export function consumeOfflineLockDirectives(
  rawText: string,
  context?: OfflineLockDirectiveContext,
): { cleanText: string; notices: string[] } {
  if (!rawText) return { cleanText: rawText, notices: [] };

  const actorName = resolveActorName(context);
  const notices: string[] = [];

  for (const match of rawText.matchAll(LOCK_PATTERN)) {
    const minutes = Number(match[1]);
    const reason = (match[2] ?? "").trim();
    const outcome = runCharacterLock(minutes, reason, actorName);
    notices.push(outcome.ok ? (outcome.message || "已锁定手机") : `锁机未生效：${outcome.reason || "未知原因"}`);
  }

  for (const match of rawText.matchAll(UNLOCK_PATTERN)) {
    const reason = (match[1] ?? "").trim();
    const outcome = runCharacterUnlock(reason, actorName);
    notices.push(outcome.ok ? (outcome.message || "已解锁手机") : `解锁未生效：${outcome.reason || "未知原因"}`);
  }

  for (const match of rawText.matchAll(INTENT_PATTERN)) {
    const title = (match[1] ?? "").trim();
    const minutesRaw = match[2] ? Number(match[2]) : undefined;
    const outcome = executeIntentLockTool(
      {
        name: "记下我要去做的事",
        args: {
          title,
          ...(Number.isFinite(minutesRaw) && (minutesRaw ?? 0) > 0 ? { minutes: minutesRaw } : {}),
        },
      },
      {
        characterId: context?.characterId,
        sessionId: context?.sessionId,
      },
    );
    notices.push(
      outcome.success
        ? (outcome.userNotice || outcome.data || `已记下待办：${title}`)
        : `记下待办未生效：${outcome.error || "未知原因"}`,
    );
  }

  return {
    cleanText: stripOfflineLockDirectives(rawText),
    notices,
  };
}
