import { loadChatOfflineTurns } from "../chat-offline-storage";
import { loadChatMessages, loadChatSessions, resolveSessionCharacterId, type ChatSession } from "../chat-storage";
import { describeFocusEvent } from "../phone-lock";
import { loadStoryMessages, loadStorySessionsForOwner, resolveStoryMemorySettings, type StoryMessage } from "../story-storage";
import { isCapabilityEnabled, loadPerceptionConfig } from "./storage";

function latest(times: Iterable<string>, now: number): number {
  let result = 0;
  for (const value of times) {
    const at = Date.parse(value);
    if (at <= now && at > result) result = at;
  }
  return result;
}

function elapsed(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "不到 1 分钟";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes / 60) % 24;
  return [days && `${days} 天`, hours && `${hours} 小时`, minutes % 60 && `${minutes % 60} 分钟`].filter(Boolean).join(" ");
}

export const LOCAL_INTERACTION_PREFIX = "【本机互动与陪管】";

export function buildInteractionContext(input: {
  chatSession?: ChatSession;
  characterId?: string;
  storyHistory?: StoryMessage[];
  allowOtherApps?: boolean;
}): string {
  const config = loadPerceptionConfig();
  if (!config.enabled || !config.injectStatus) return "";

  const now = Date.now();
  const session = input.chatSession ?? (input.allowOtherApps && input.characterId
    ? loadChatSessions().find(item => !item.isGroup && resolveSessionCharacterId(item) === input.characterId)
    : undefined);
  const online = session ? latest(loadChatMessages(session.id).filter(message =>
    message.role === "assistant" && !message.isRetracted && (message.status === "sent" || message.status === "read")
    && (!message.channel || message.channel === "chat" || message.channel === "group_chat")
    && (!message.origin || message.origin === "chat" || message.origin === "story_floating_phone")
    && message.mediaType !== "tool_call" && message.mediaType !== "tool_result" && message.mediaType !== "tool_notice"
    && message.mediaType !== "system_instruction" && message.mediaType !== "group_admin_notice"
  ).map(message => message.createdAt), now) : 0;
  const offline = session ? latest(loadChatOfflineTurns(session.id).filter(turn => turn.assistantContent.trim())
    .map(turn => turn.createdAt), now) : 0;

  // 剧情内只看当前分线；从私聊回看独立剧情时只认获准共享的同角色主线，不混群或分线。
  const main = input.chatSession && !input.chatSession.isGroup && input.characterId
    ? loadStorySessionsForOwner("single", input.characterId).find(item => (item.branchId || "main") === "main"
      && resolveStoryMemorySettings(item).writePublicShortTermMemory)
    : undefined;
  const storyHistory = input.storyHistory ?? (main ? loadStoryMessages(main.id) : []);
  const story = latest(storyHistory.filter(message => message.role === "assistant").map(message => message.createdAt), now);
  const lines = [
    online && `距本会话上次线上回复：${elapsed(online, now)}`,
    offline && `距本会话上次聊天内线下轮次完成：${elapsed(offline, now)}`,
    story && `距${input.storyHistory ? "当前剧情分线" : "该角色剧情主线"}上次回复：${elapsed(story, now)}`,
  ].filter(Boolean);
  const focus = isCapabilityEnabled(config, "foregroundApp") ? describeFocusEvent(now) : "";
  const text = [lines.length ? `现实经过时间（按已保存的回复计，不是剧情内时间，也不含正在生成的这一轮）：${lines.join("；")}。没有记录的场景不要推测。` : "", focus].filter(Boolean).join("\n");
  return text ? `${LOCAL_INTERACTION_PREFIX}\n${text}` : "";
}
