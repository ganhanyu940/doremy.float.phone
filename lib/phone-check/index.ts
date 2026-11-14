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
import { loadInstalledCustomApps, readCustomAppCollection } from "../custom-app-storage";

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

/**
 * 从某个自定义 APP 的某个数据集合里读出「章节级学时」。
 *
 * 用户的情况：学习资料在「考点工坊」里，他想知道的不只是「考点工坊用了 45 分钟」，
 * 而是「第一章看了 25 分钟、第三章还没碰」。这种粒度只有那个 APP 自己知道，
 * 因为它记的是「用户打开的是哪一份记录」。
 *
 * 所以这里做一层通用读取：给 APP 名 + 集合名，把带 studySeconds 的记录
 * 整理成「标题 + 累计时长」，按用户指定字段取标题。
 *
 * 边界：只读，不改。读不到就返回空数组，绝不编。
 */
/** 本地日期键 YYYY-MM-DD（按用户时区，不按 UTC——他按本地时间过日子）。 */
export function dayKeyOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 本周一 00:00（周一为一周开始，和考点工坊那边一致）。 */
function startOfWeek(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const offset = (d.getDay() + 6) % 7; // 周日=0 → 6
  d.setDate(d.getDate() - offset);
  return d.getTime();
}

/** 本月 1 日 00:00。 */
function startOfMonth(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d.getTime();
}

/**
 * 时段合计：给定按天的分桶，算出今天/本周/本月的秒数。
 *
 * 为什么必须有这个：用户明确说了要「每天每周每月」，不要一个越滚越大的累计数。
 * 累计数字对备考没有指导意义——上周学了 5 小时、这周躺平，累计照样很好看。
 */
export type StudyPeriods = {
  todayMinutes: number;
  weekMinutes: number;
  monthMinutes: number;
  /** 本月有几天真的学了（比总时长更能说明连续性） */
  monthDays: number;
  /** 从今天（或昨天）往前数，连续有学习的天数 */
  streakDays: number;
};

function periodsFromDaySeconds(daySeconds: Record<string, number>, now = Date.now()): StudyPeriods {
  const today = dayKeyOf(now);
  const weekStartKey = dayKeyOf(startOfWeek(now));
  const monthStartKey = dayKeyOf(startOfMonth(now));
  let todaySec = 0;
  let weekSec = 0;
  let monthSec = 0;
  const monthDaySet = new Set<string>();

  for (const [key, value] of Object.entries(daySeconds)) {
    const seconds = Number(value) || 0;
    if (seconds <= 0) continue;
    if (key === today) todaySec += seconds;
    if (key >= weekStartKey) weekSec += seconds;
    if (key >= monthStartKey) {
      monthSec += seconds;
      monthDaySet.add(key);
    }
  }

  // 连续天数：今天还没学不算断（一天没过完），从昨天开始往前数
  let streakDays = 0;
  const cursor = new Date(now);
  cursor.setHours(12, 0, 0, 0);
  if (!(daySeconds[dayKeyOf(cursor.getTime())] > 0)) {
    cursor.setDate(cursor.getDate() - 1);
  }
  for (let guard = 0; guard < 400; guard += 1) {
    if (!(daySeconds[dayKeyOf(cursor.getTime())] > 0)) break;
    streakDays += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  return {
    todayMinutes: Math.round(todaySec / 60),
    weekMinutes: Math.round(weekSec / 60),
    monthMinutes: Math.round(monthSec / 60),
    monthDays: monthDaySet.size,
    streakDays,
  };
}

export type ChapterStudyTime = {
  /** 记录标题（如「认知发展」） */
  title: string;
  /** 上层归属（单元/章），可能为空 */
  group?: string;
  /** 再上一层（课程），可能为空。两门课都有「第一章」时靠它区分 */
  course?: string;
  /** 累计分钟（保留：老数据只有这个数） */
  minutes: number;
  /** 今天 / 本周 / 本月的分钟数 */
  todayMinutes: number;
  weekMinutes: number;
  monthMinutes: number;
  lastStudiedAt?: string;
};

export function readChapterStudyTimes(
  appName: string,
  collection: string,
  options?: { titleField?: string; groupField?: string; courseField?: string },
): ChapterStudyTime[] {
  try {
    const apps = loadInstalledCustomApps().filter(app => app.name === appName);
    if (!apps.length) return [];
    const rows = readCustomAppCollection(apps[0].id, collection);
    if (!Array.isArray(rows)) return [];
    const titleField = options?.titleField ?? "chapter";
    const groupField = options?.groupField ?? "unit";
    const courseField = options?.courseField ?? "course";
    return rows
      .map(row => {
        const record = row as Record<string, unknown>;
        const totalSeconds = Number(record.studySeconds) || 0;
        // 按天分桶（v2.3 起考点工坊会写）。没有就是老记录，只能给累计数。
        const byDate = (record.studyByDate && typeof record.studyByDate === "object")
          ? record.studyByDate as Record<string, number>
          : {};
        const periods = periodsFromDaySeconds(byDate);
        if (totalSeconds < 60 && periods.monthMinutes <= 0) return null; // 不到一分钟的算噪声
        const title = String(record[titleField] ?? "").trim();
        if (!title) return null;
        const group = String(record[groupField] ?? "").trim();
        const course = String(record[courseField] ?? "").trim();
        return {
          title,
          group: group || undefined,
          course: course || undefined,
          minutes: Math.round(totalSeconds / 60),
          todayMinutes: periods.todayMinutes,
          weekMinutes: periods.weekMinutes,
          monthMinutes: periods.monthMinutes,
          lastStudiedAt: typeof record.lastStudiedAt === "string" ? record.lastStudiedAt : undefined,
        };
      })
      .filter((item): item is ChapterStudyTime => item !== null)
      .sort((a, b) => b.minutes - a.minutes);
  } catch {
    return [];
  }
}

/**
 * 当前读哪些 APP 的章节学时。
 *
 * 写成配置而不是硬编码「考点工坊」：用户装了别的学习类 APP 时，
 * 只要它按同样约定记 studySeconds 就能一起统计。
 * 默认给考点工坊一条，是因为用户明确说了他的资料在那儿。
 */
export const DEFAULT_CHAPTER_SOURCES = [
  { appName: "考点工坊", collection: "chapters", titleField: "chapter", groupField: "unit", courseField: "course" },
];

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

/**
 * 小手机内部单个应用的当日累计。
 *
 * 为什么要单独算：系统时间线只能给到「float 在前台」这一层，
 * 想知道「考点工坊用了 45 分钟、噼里啪啦用了 42 分钟」必须靠网页自己记的
 * 内部应用切换点来算。用户确实要这个——只看逐段明细看不出排行，
 * 而占比恰恰是「到底把时间花在哪」最直接的答案。
 */
export type InnerAppUsage = {
  app: string;
  minutes: number;
  /** 是否在学习名单里 */
  study: boolean;
};

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
  /** 小手机内部各应用的累计时长（按时长降序） */
  innerApps: InnerAppUsage[];
  /**
   * 章节级学时（如「考点工坊 · 第一章 / 认知发展 25 分钟」）。
   *
   * 这是比「考点工坊在前台 45 分钟」细一层的答案：用户真正想知道的是
   * 「我到底把哪一章看了多久」。数据来自 APP 自己记的 studySeconds。
   */
  chapters: ChapterStudyTime[];
  /**
   * 学习应用里的日/周/月合计（跨所有章节）。
   *
   * 和上面的 studyMinutes 不是一回事：studyMinutes 是系统时间线算出来的
   * 「学习类应用在前台多久」，这里是 APP 内部真的在某一章上停留的时间。
   * 两者可以互相印证——差太多就说明只是开着没在看。
   */
  chapterPeriods: StudyPeriods;
};

/**
 * 从小手机内部的切换点算出「每个应用待了多久」。
 *
 * 算法：把内部切换点按时间排序，每段时长 = 下一次切换的时刻 − 这一次的时刻。
 * 最后一段截止到「此刻」或「float 离开前台」——两者取早，否则用户已经
 * 切出去半小时了，还会继续给最后那个应用记账。
 *
 * 只在 float 处于前台的区间内记账：切出去看微信的那段时间不该算到
 * 小手机里的某个应用头上，否则排行会虚高。
 */
export function summarizeInnerApps(
  segments: ClassifiedSegment[],
  spans: InnerAppSpan[],
  studyInnerApps: string[],
  floatPackage = "app.floatphone.shell",
): InnerAppUsage[] {
  const floatSpans = segments.filter(segment => segment.package === floatPackage);
  if (!floatSpans.length || !spans.length) return [];

  const studySet = new Set(studyInnerApps);
  const totals = new Map<string, number>();
  const sorted = [...spans].sort((a, b) => a.at - b.at);

  for (let index = 0; index < sorted.length; index += 1) {
    const span = sorted[index];
    const next = sorted[index + 1];
    let end = next ? next.at : Date.now();

    // 截止到「包含这个时刻的 float 段」的结束——既处理「已经切出小手机」，
    // 也处理「最后一段本来就还没结束」。
    const host = floatSpans.find(segment => span.at >= segment.startAt && span.at <= segment.endAt);
    if (host && host.endAt < end) end = host.endAt;
    if (!host) continue;

    const seconds = Math.max(0, (end - span.at) / 1000);
    // 少于 3 秒的切换是误触或快速点进点出，不记账
    if (seconds < 3) continue;
    totals.set(span.app, (totals.get(span.app) ?? 0) + seconds);
  }

  return Array.from(totals.entries())
    .map(([app, seconds]) => ({
      app,
      minutes: Math.max(1, Math.round(seconds / 60)),
      study: studySet.has(app),
    }))
    .sort((a, b) => b.minutes - a.minutes);
}

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
    // 内部应用的累计总量另算（见 summarizeInnerApps）：这里只放时间线，
    // 由调用方带上 config 再补，避免这个函数被迫依赖配置。
    innerApps: [],
    // 章节学时同理，由 buildPhoneCheckReport 补
    chapters: [],
    chapterPeriods: { todayMinutes: 0, weekMinutes: 0, monthMinutes: 0, monthDays: 0, streakDays: 0 },
  };
}

/**
 * 给汇总补上「小手机内部各应用用了多久」。
 *
 * 单独一步而不是塞进 summarizeTimeline：算它需要外面的配置（学习名单）
 * 和原始切换点，让 summarizeTimeline 保持「只吃时间线」的纯函数更好测。
 */
export function withInnerApps(
  summary: PhoneCheckSummary,
  config: PhoneCheckConfig,
  spans: InnerAppSpan[] = loadInnerAppSpans(),
): PhoneCheckSummary {
  return { ...summary, innerApps: summarizeInnerApps(summary.segments, spans, config.studyInnerApps) };
}

/**
 * 一步到位：读时间线 + 归类 + 汇总（含内部应用排行 + 章节级学时）。
 * 面板与角色都走这个，避免两处算出不同的数。
 */
export function buildPhoneCheckReport(
  config: PhoneCheckConfig,
  chapterSources: typeof DEFAULT_CHAPTER_SOURCES = DEFAULT_CHAPTER_SOURCES,
): PhoneCheckSummary {
  const segments = classifyTimeline(config);
  const base = withInnerApps(summarizeTimeline(segments), config);
  // 章节级学时：把各来源 APP 的记录合并成一张榜（标题带上来源名，
  // 否则两个 APP 都有「第一章」时会混在一起分不清）
  const chapters = chapterSources.flatMap(source =>
    readChapterStudyTimes(source.appName, source.collection, {
      titleField: source.titleField,
      groupField: source.groupField,
      courseField: source.courseField,
    }).map(item => {
      // 标题拼成「APP · 课程 / 单元 / 章节」，缺哪层就跳哪层。
      // 不带上课程的话，「教育心理学·第一章」和「数据结构·第一章」
      // 在榜上会变成两条一模一样的「第一章」，谁也分不清。
      const trail = [item.course, item.group, item.title].filter(Boolean).join(" / ");
      return { ...item, title: `${source.appName} · ${trail}` };
    }),
  ).sort((a, b) => b.minutes - a.minutes);

  // 跨章节的日/周/月合计。注意不能把各章节的 todayMinutes 相加后直接当
  // 「今天学了多久」——同一段时间可能同时算在多个章节上（用户来回翻）。
  // 这里按每条记录的分数分别汇总，取「尽量不重复」的口径：
  // 直接用每天的最大值会低估，取和会高估；备考场景下宁少算不多算，
  // 所以这里用 sum，但在给角色的措辞里明确说这是「各章节相加」。
  const chapterPeriods: StudyPeriods = chapters.reduce(
    (acc, item) => ({
      todayMinutes: acc.todayMinutes + item.todayMinutes,
      weekMinutes: acc.weekMinutes + item.weekMinutes,
      monthMinutes: acc.monthMinutes + item.monthMinutes,
      monthDays: Math.max(acc.monthDays, 0),
      streakDays: Math.max(acc.streakDays, 0),
    }),
    { todayMinutes: 0, weekMinutes: 0, monthMinutes: 0, monthDays: 0, streakDays: 0 },
  );
  // 连续天数与「本月有几天在学」是跨章节的全局事实，单独从分桶算一次
  const merged: Record<string, number> = {};
  for (const source of chapterSources) {
    const apps = loadInstalledCustomApps().filter(app => app.name === source.appName);
    if (!apps.length) continue;
    const rows = readCustomAppCollection(apps[0].id, source.collection);
    for (const row of rows) {
      const record = row as Record<string, unknown>;
      const byDate = (record.studyByDate && typeof record.studyByDate === "object")
        ? record.studyByDate as Record<string, number>
        : {};
      for (const [key, value] of Object.entries(byDate)) {
        const seconds = Number(value) || 0;
        if (seconds > 0) merged[key] = (merged[key] ?? 0) + seconds;
      }
    }
  }
  const globalPeriods = periodsFromDaySeconds(merged);
  chapterPeriods.monthDays = globalPeriods.monthDays;
  chapterPeriods.streakDays = globalPeriods.streakDays;

  return { ...base, chapters, chapterPeriods };
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
    // 时间线读不到，但章节学时来自本地存储、往往仍然有效。
    // 不能因为系统权限没开就把「他明明看了三章」一起吞掉——
    // 这会让角色误以为用户今天什么都没学，冤枉人。
    const p0 = summary.chapterPeriods;
    const chapterLine = summary.chapters.length
      ? `\n另外，学习应用里有记录：今天 ${p0.todayMinutes} 分钟，本周 ${p0.weekMinutes} 分钟，本月 ${p0.monthMinutes} 分钟（${p0.monthDays} 天有学）${
        p0.streakDays > 0 ? `，已连续 ${p0.streakDays} 天` : ""
      }。学得最多的几章：${summary.chapters.slice(0, 5).map(item => `${item.title} 累计 ${item.minutes} 分钟`).join("、")}。`
      : "";
    return `读不到今天的应用时间线（可能没有授予「使用情况访问」权限，或今天还没怎么用手机）。不要编造内容。${chapterLine}`;
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
  // 内部应用排行：这是「到底把时间花在小手机的哪个应用上」最直接的答案。
  // 只列前 8 个，免得把重要的时间线挤没了。
  if (summary.innerApps.length) {
    const rows = summary.innerApps.slice(0, 8).map(item => `${item.app}${item.study ? "（学习）" : ""} ${item.minutes} 分钟`);
    head.push(`小手机内部各应用合计：${rows.join("、")}。`);
  }
  // 学习时长：用户明确要的是「每天每周每月」，不要一个越滚越大的累计数。
  // 所以这里先给日/周/月的总量和「有没有断」，再给章节明细。
  const p = summary.chapterPeriods;
  if (p.todayMinutes > 0 || p.weekMinutes > 0 || p.monthMinutes > 0) {
    const bits: string[] = [];
    bits.push(`今天 ${p.todayMinutes} 分钟`);
    bits.push(`本周 ${p.weekMinutes} 分钟`);
    bits.push(`本月 ${p.monthMinutes} 分钟（${p.monthDays} 天有学）`);
    if (p.streakDays > 0) bits.push(`已连续 ${p.streakDays} 天`);
    head.push(`学习应用里真实停留的时长（不是累计总数）：${bits.join("，")}。`);
  }
  // 章节明细优先给「今天/本周」，累计放后面——
  // 累计再多也回答不了「今天有没有动」，那才是他要被提醒的事。
  if (summary.chapters.length) {
    const byToday = [...summary.chapters].sort((a, b) => b.todayMinutes - a.todayMinutes);
    const rows = byToday.slice(0, 8).map(item => {
      const recent = item.todayMinutes > 0
        ? `今天 ${item.todayMinutes} 分钟`
        : item.weekMinutes > 0
          ? `本周 ${item.weekMinutes} 分钟`
          : "这周还没碰";
      return `${item.title}（${recent}，累计 ${item.minutes} 分钟）`;
    });
    head.push(`各章节：${rows.join("；")}。`);
    const untouched = summary.chapters.filter(item => item.weekMinutes <= 0).length;
    if (untouched > 0) {
      head.push(`其中 ${untouched} 章这周一次都没打开过——这是判断「有没有偷懒」最直接的依据，但别把它念成清单。`);
    }
  }
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
  if (!summary.segments.length) {
    // 同 describeTimelineForCharacter：宁可只报章节学时，也不要让用户
    // 以为「一整天什么都没记到」，那看起来像这功能坏了。
    const p = summary.chapterPeriods;
    if (p.todayMinutes > 0 || p.weekMinutes > 0 || p.monthMinutes > 0) {
      return `还没读到系统时间线（需授予「使用情况访问」）· 学习应用：今天 ${p.todayMinutes} 分钟 · 本周 ${p.weekMinutes} 分钟 · 本月 ${p.monthMinutes} 分钟`;
    }
    return "今天还没有可读的记录（需要授予「使用情况访问」，且今天有用过手机）。";
  }
  const fmt = (minutes: number) => (minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`);
  const parts = [`学习 ${fmt(summary.studyMinutes)}`, `玩 ${fmt(summary.playMinutes)}`];
  if (summary.longestPlayStreak && summary.longestPlayStreak.minutes >= 5) {
    parts.push(`最长连续玩 ${summary.longestPlayStreak.minutes} 分钟`);
  }
  if (summary.innerApps.length) {
    const top = summary.innerApps[0];
    parts.push(`小手机里最久是「${top.app}」${top.minutes} 分钟`);
  }
  // 学习应用里的日/周/月：这是用户真正想看的三个数（他说不要累计）。
  const p = summary.chapterPeriods;
  if (p.todayMinutes > 0 || p.weekMinutes > 0 || p.monthMinutes > 0) {
    parts.push(`学习应用：今天 ${p.todayMinutes} 分钟 · 本周 ${p.weekMinutes} 分钟 · 本月 ${p.monthMinutes} 分钟`);
    if (p.streakDays > 0) parts.push(`连续 ${p.streakDays} 天`);
  }
  return parts.join(" · ");
}

/** 角色名解析（沿用内部工具那套：先角色 id，再联系人）。 */
export function characterDisplayName(characterId?: string): string {
  if (!characterId) return "";
  return loadCharacters().find(item => item.id === characterId)?.name ?? "";
}
