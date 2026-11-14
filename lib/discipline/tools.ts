"use client";

// 「记下我要去做的事」与「叫我起床」这两个工具的执行入口。
//
// 为什么单独一个文件而不是塞进 lib/tool-executor.ts：
//   那个文件已经 5600 行，再加实现会继续膨胀；
//   而且这两件事的门控逻辑（用户开没开、壳支持不支持）是新的，
//   自成一块更容易核对。
//
// 两条共同的硬约束（从用户反复强调里来）：
//   · 不许替 TA 决定要去做什么。只能记 TA 自己说要做的。
//   · 不许把这两个动作当威胁或惩罚（「你再去玩我就记下了」）。
//   这些要求写在能力的 usageGuide 里（见 internal-capability-storage），
//   代码这里只保证"没开就不执行、失败如实回报"。

import {
  getInternalCapability,
  INTENT_LOCK_CAPABILITY_ID,
  WAKEUP_CALL_CAPABILITY_ID,
} from "../internal-capability-storage";
import {
  createIntent,
  loadIntentLockConfig,
  syncIntentsToNative,
} from "../intent-lock";
import { scheduleWakeup } from "../wakeup";

/** 与 tool-executor 的 ToolResult 结构一致（这里用宽松结构避免循环引用）。 */
type ToolOutcome = {
  name: string;
  success: boolean;
  data?: string;
  error?: string;
  continueConversation?: boolean;
  persistToHistory?: boolean;
  userNotice?: string;
};

/** tool-executor 里的 ToolCall 最小形状。 */
type MinimalToolCall = {
  name: string;
  args?: Record<string, unknown>;
};

type MinimalContext = {
  characterId?: string;
  sessionId?: string;
};

function cleanString(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function capabilityOff(toolName: string, label: string, where: string): ToolOutcome {
  return {
    name: toolName,
    success: false,
    error: `「${label}」能力未启用（${where}）`,
    continueConversation: false,
    persistToHistory: false,
    userNotice: `${label}能力未启用`,
  };
}

/**
 * 记下 TA 要去做的事。
 *
 * 建完立刻同步给原生：不同步就根本不会响——这是整条链路最容易漏的一步，
 * 漏了的表现是「面板上显示在盯着，实际到点什么都不发生」。
 */
export function executeIntentLockTool(call: MinimalToolCall, context?: MinimalContext): ToolOutcome {
  const capability = getInternalCapability(INTENT_LOCK_CAPABILITY_ID);
  if (!capability || !capability.enabled || capability.mode === "off") {
    return capabilityOff(call.name, "记下我要去做的事", "工具箱 → 内置能力");
  }

  const config = loadIntentLockConfig();
  if (!config.enabled) {
    return {
      name: call.name,
      success: false,
      error: "TA 还没有开启「说了就管我」（设置 → 健康系统）",
      continueConversation: true,
      persistToHistory: false,
      userNotice: "健康系统没开启",
    };
  }

  const title = cleanString(call.args?.title, 40);
  if (!title) {
    return { name: call.name, success: false, error: "需要 title 参数：TA 要去做什么" };
  }

  const rawMinutes = Number(call.args?.minutes);
  const result = createIntent({
    title,
    // TA 明确说了时长才用；没说就交给默认值（用户要求「尽量短」）
    minutes: Number.isFinite(rawMinutes) && rawMinutes > 0 ? rawMinutes : undefined,
    createdBy: "character",
    characterId: context?.characterId,
    sessionId: context?.sessionId,
  });

  if (!result.ok) {
    return { name: call.name, success: false, error: result.reason };
  }

  syncIntentsToNative();

  return {
    name: call.name,
    success: true,
    data: `记下了：「${result.record.title}」。${config.graceMinutes} 分钟后我会看 TA 的手机还动不动；`
      + `还在用就锁 ${result.record.lockMinutes} 分钟。TA 做完了可以说一声，也可以随时取消。`,
    continueConversation: true,
    persistToHistory: false,
    userNotice: `记下了你要去做「${title}」`,
  };
}

/**
 * 叫我起床。
 *
 * 时刻必须是用户自己说的：猜错时间比不叫更糟。
 * 合成音频可能要等几秒（要调语音接口），所以这里是 async。
 */
export async function executeWakeupCallTool(
  call: MinimalToolCall,
  context?: MinimalContext,
): Promise<ToolOutcome> {
  const capability = getInternalCapability(WAKEUP_CALL_CAPABILITY_ID);
  if (!capability || !capability.enabled || capability.mode === "off") {
    return capabilityOff(call.name, "叫我起床", "工具箱 → 内置能力");
  }

  const hour = Number(call.args?.hour);
  const minute = Number(call.args?.minute);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
    return { name: call.name, success: false, error: "需要 hour 参数（0-23 的整点）" };
  }
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) {
    return { name: call.name, success: false, error: "需要 minute 参数（0-59）" };
  }
  const speech = cleanString(call.args?.speech, 200);
  if (!speech) {
    return { name: call.name, success: false, error: "需要 speech 参数：叫醒时要念的那句话" };
  }

  // 算成「下一次出现的这个时刻」：如果今天这个点已经过了，就是明天。
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (target.getTime() <= now.getTime() + 60_000) {
    target.setDate(target.getDate() + 1);
  }

  const result = await scheduleWakeup({
    at: target.getTime(),
    speech,
    characterId: context?.characterId,
    sessionId: context?.sessionId,
    createdBy: "character",
  });

  if (!result.ok) {
    return { name: call.name, success: false, error: result.reason };
  }

  const clock = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return {
    name: call.name,
    success: true,
    data: result.hasAudio
      ? `定好了：${clock} 叫 TA 起床，会用你的声音念「${speech}」。没反应最多再响几轮。`
      : `定好了：${clock} 叫 TA 起床。真音色没合成成功，到时候会用系统语音念「${speech}」——照样会叫。`,
    continueConversation: true,
    persistToHistory: false,
    userNotice: `定好了 ${clock} 叫你起床`,
  };
}
