"use client";

// 查手机：把「今天什么时候在用什么应用」变成人能看懂、角色能用的事实。
//
// 分工（与 lib/perception 一致的分工原则）：
//   · 原生（PerceptionBridge.usageTimelineJson）只负责把系统的
//     UsageEvents 读成一段一段的 {package,label,startAt,endAt,seconds}；
//   · 「什么算学习」「怎么措辞」「给角色看多细」全在这里决定——
//     这样分类规则和文案随网页部署即时生效，调一个名单不必重编 APK。
//
// 数据边界（用户已明确同意放宽到「角色可以知道得很细」）：
//   · 只读应用切换，不读界面内容、不读输入、不截屏；
//   · 只查当天，不跨天回溯；
//   · 全部留在本机 IndexedDB，不上传任何服务器。
//     这一点是硬的：用户同意的是「角色知道」，不是「数据出境」。
//
// 为什么时间点这么重要：只用「各应用累计时长」根本回答不了用户的真问题。
// 「微信用了 43 分钟」既可能是和家人视频，也可能是刷了半小时朋友圈；
// 「19:04 从 float 切到微信，19:31 才回来」才说得清他到底有没有学。

import { loadAppUsageTimeline, type UsageTimelineSegment } from "../perception/bridge";
import { kvGet, kvSet, registerKvMigration } from "../kv-db";
import { loadCharacters } from "../character-storage";

const CONFIG_KEY = "ai_phone_phone_check_config_v1";
registerKvMigration(CONFIG_KEY);

/** 一条已被归类的活动段。 */
export type ClassifiedSegment = UsageTimelineSegment & {
  /** 学习 / 娱乐 / 中性 / 小手机内部 */
  kind: "study" | "play" | "neutral" | "float";
  /** float 内部时的具体应用名（如「考点工坊」），其它为空 */
  innerApp?: string;
};

export type PhoneCheckConfig = {
  /** 算学习的真实应用包名。不在名单里的一律算「玩」（宁可误判成玩）。 */
  studyPackages: string[];
  /**
   * float 内部算学习的 APP 名（如 考点工坊 / 刷题本）。
   * 空的其余内部应用算「玩」。
   */
  studyInnerApps: string[];
  /**
   * 时间线保留多少小时。用户选的是 24 小时（滚动覆盖）。
   * 不攒长期历史：他要的是「今天到底学没学」，不是行为审计。
   */
  keepHours: number;
  /** 是否允许角色读取这些数据。默认关闭，要用户亲自开。 */
  allowCharacterRead: boolean;
};

export const PHONE_CHECK_DEFAULTS: PhoneCheckConfig = {
  // 用户手机上这几个是明显的学习类，预勾上，回头他自己增删。
  studyPackages: [],
  studyInnerApps: ["考点工坊", "刷题本", "词声", "木光自习室", "记忆面包坊"],
  keepHours: 24,
  allowCharacterRead: false,
};

export function loadPhoneCheckConfig(): PhoneCheckConfig {
  try {
    const raw = kvGet(CONFIG_KEY);
    if (!raw) return { ...PHONE_CHECK_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<PhoneCheckConfig>;
    return {
      studyPackages: Array.isArray(parsed.studyPackages) ? parsed.studyPackages.map(String).filter(Boolean) : [],
      studyInnerApps: Array.isArray(parsed.studyInnerApps) ? parsed.studyInnerApps.map(String).filter(Boolean) : [],
      keepHours: Number(parsed.keepHours) > 0 ? Math.min(72, Math.round(Number(parsed.keepHours))) : 24,
      allowCharacterRead: parsed.allowCharacterRead === true,
    };
  } catch {
    return { ...PHONE_CHECK_DEFAULTS };
  }
}

export function savePhoneCheckConfig(config: PhoneCheckConfig): void {
  kvSet(CONFIG_KEY, JSON.stringify(config));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("phone-check-config-changed"));
  }
}

/**
 * float 内部当前打开了哪个 APP。
 *
 * 为什么要单独记：系统只知道「float 在前台」，看不到你在用里面的哪个应用
 * ——它是个 WebView。这层信息只有网页自己知道，所以由网页在上报侧
 * 补一段「float 内部应用」的记录，读时间线时按时间拼进对应的 float 段。
 */
const INNER_KEY = "ai_phone_phone_check_inner_v1";

export type InnerAppSpan = { app: string; at: number };

export function recordInnerAppOpen(app: string): void {
  if (typeof window === "undefined") return;
  const name = app.trim().slice(0, 40);
  if (!name) return;
  try {
    const raw = kvGet(INNER_KEY);
    const list: InnerAppSpan[] = raw ? JSON.parse(raw) : [];
    const next = [...list, { app: name, at: Date.now() }]
      // 只留最近 24 小时，和主时间线的保留期对齐
      .filter(item => Date.now() - item.at < 24 * 60 * 60 * 1000)
      .slice(-300);
    kvSet(INNER_KEY, JSON.stringify(next));
  } catch {
    // 记不上不影响主功能
  }
}

export function loadInnerAppSpans(): InnerAppSpan[] {
  try {
    const raw = kvGet(INNER_KEY);
    const list = raw ? (JSON.parse(raw) as InnerAppSpan[]) : [];
    return Array.isArray(list) ? list.filter(item => item?.app && Number.isFinite(item?.at)) : [];
  } catch {
    return [];
  }
}

/** 给 float 段配上「那段时间里最后打开的内部应用」。 */
function attachInnerApp(segment: UsageTimelineSegment, spans: InnerAppSpan[]): string | undefined {
  let found: string | undefined;
  for (const span of spans) {
    if (span.at >= segment.startAt && span.at <= segment.endAt) found = span.app;
  }
  return found;
}

/**
 * 读今天的时间线并归类。
 *
 * @param floatPackage float 自己的包名；它内部的归类走 studyInnerApps。
 */
export function classifyTimeline(config: PhoneCheckConfig, floatPackage = "app.floatphone.shell"): ClassifiedSegment[] {
  const studySet = new Set(config.studyPackages);
  const innerStudy = new Set(config.studyInnerApps);
  const spans = loadInnerAppSpans();
  const since = Date.now() - config.keepHours * 60 * 60 * 1000;

  return loadAppUsageTimeline(400)
    .filter(segment => segment.endAt >= since)
    .map(segment => {
      if (segment.package === floatPackage) {
        const innerApp = attachInnerApp(segment, spans);
        // float 内部：命中学习名单才算学习，否则算玩。
        // 没记到内部应用时算「中性」——不能因为没记上就判他玩，
        // 那会让用户觉得这个统计在冤枉他。
        const kind: ClassifiedSegment["kind"] = !innerApp
          ? "neutral"
          : innerStudy.has(innerApp)
            ? "float"
            : "play";
        return { ...segment, kind, innerApp };
      }
      const kind: ClassifiedSegment["kind"] = studySet.has(segment.package) ? "study" : "play";
      return { ...segment, kind };
    });
}

export type PhoneCheckSummary = {
  /** 学习总分钟数（含 float 内部学习应用） */
  studyMinutes: number;
  playMinutes: number;
  /** 最长的连续娱乐段（用来抓「一刷就停不下来」） */
  longestPlayStreak: { label: string; minutes: number; startAt: number } | null;
  /** 段数，给「切来切去」的判断用 */
  switchCount: number;
  /** 时间线本身（用户选了「精确版」，角色也可以拿到） */
  segments: ClassifiedSegment[];
};

function isStudy(kind: ClassifiedSegment["kind"]): boolean {
  return kind === "study" || kind === "float";
}

/** 汇总。给面板和角色共用，避免两处算出不同的数。 */
export function summarizeTimeline(segments: ClassifiedSegment[]): PhoneCheckSummary {
  let study = 0;
  let play = 0;
  let longest: PhoneCheckSummary["longestPlayStreak"] = null;
  let streakStart: number | null = null;
  let streakSeconds = 0;
  let streakLabel = "";

  for (const segment of segments) {
    if (isStudy(segment.kind)) {
      study += segment.seconds;
    } else if (segment.kind === "play") {
      play += segment.seconds;
      // 连续娱乐：中间隔着的「中性」段（比如系统桌面）不算打断，
      // 否则「切回桌面再点开下一个」会被当成两次，最长的刷手机段就抓不出来。
      if (streakStart === null) streakStart = segment.startAt;
      streakSeconds += segment.seconds;
      if (!streakLabel) streakLabel = segment.innerApp || segment.label;
    } else {
      // 中性段：不清零，但也不累加时长
      continue;
    }
    // 学习段才真正打断「连续玩」
    if (isStudy(segment.kind) && streakStart !== null) {
      const minutes = Math.round(streakSeconds / 60);
      if (!longest || minutes > longest.minutes) {
        longest = { label: streakLabel, minutes, startAt: streakStart };
      }
      streakStart = null;
      streakSeconds = 0;
      streakLabel = "";
    }
  }
  if (streakStart !== null) {
    const minutes = Math.round(streakSeconds / 60);
    if (!longest || minutes > longest.minutes) {
      longest = { label: streakLabel, minutes, startAt: streakStart };
    }
  }

  const fmt = (seconds: number) => Math.round(seconds / 60);
  return {
    studyMinutes: fmt(study),
    playMinutes: fmt(play),
    longestPlayStreak: longest,
    switchCount: segments.length,
    segments,
  };
}

/**
 * 生成给角色看的文本（用户选的是「精确版」）。
 *
 * 精确版意味着**可以报时间点**——这是用户明确要的（「这样才能更精准地知道
 * 我到底有没有在学习」）。但仍然要克制：
 *  - 按时间正序列出，让它自己看顺序，而不是替它下结论；
 *  - 明确告诉它「这是给你判断用的证据，不是让你逐条念给用户听」；
 *  - 时间用 24 小时制 HH:MM，别写「晚上七点零四分」这种啰嗦说法。
 */
export function describeTimelineForCharacter(summary: PhoneCheckSummary): string {
  if (!summary.segments.length) {
    return "读不到今天的应用时间线（可能没有授予「使用情况访问」权限，或今天还没怎么用手机）。不要编造内容。";
  }
  const clock = (ms: number) => {
    const date = new Date(ms);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  };
  const lines = summary.segments.slice(-60).map(segment => {
    const tag = isStudy(segment.kind) ? "学习" : segment.kind === "play" ? "玩" : "其它";
    const name = segment.innerApp ? `${segment.label} / ${segment.innerApp}` : segment.label;
    const minutes = Math.max(1, Math.round(segment.seconds / 60));
    return `- ${clock(segment.startAt)}-${clock(segment.endAt)} ${name}（${tag}，${minutes} 分钟）`;
  });
  const head = [
    `今天累计：学习约 ${summary.studyMinutes} 分钟，玩手机约 ${summary.playMinutes} 分钟，切换 ${summary.switchCount} 次。`,
  ];
  if (summary.longestPlayStreak && summary.longestPlayStreak.minutes >= 5) {
    head.push(`最长一段连续玩：${clock(summary.longestPlayStreak.startAt)} 起，「${summary.longestPlayStreak.label}」约 ${summary.longestPlayStreak.minutes} 分钟。`);
  }
  return [
    ...head,
    "时间线（越靠后越近）：",
    ...lines,
    "",
    "这是让你判断 TA 到底有没有在学的证据，不是让你逐条念出来的报告。用的时候自然地提一两句，或者说清楚你担心的点；不要像监控回放一样列出每一行。",
  ].join("\n");
}

/** 给设置页的简短摘要（不含逐段明细）。 */
export function describeTimelineForUser(summary: PhoneCheckSummary): string {
  if (!summary.segments.length) return "今天还没有可读的记录（需要授予「使用情况访问」，且今天有用过手机）。";
  const fmt = (minutes: number) => (minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`);
  const parts = [`学习 ${fmt(summary.studyMinutes)}`, `玩 ${fmt(summary.playMinutes)}`];
  if (summary.longestPlayStreak && summary.longestPlayStreak.minutes >= 5) {
    parts.push(`最长连续玩 ${summary.longestPlayStreak.minutes} 分钟`);
  }
  return parts.join(" · ");
}

/** 角色名解析（沿用内部工具那套：先角色 id，再联系人）。 */
export function characterDisplayName(characterId?: string): string {
  if (!characterId) return "";
  return loadCharacters().find(item => item.id === characterId)?.name ?? "";
}
