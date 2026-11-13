// lib/system-tts.ts — 用**手机自带语音包**朗读（免费、离线、不消耗任何 API 额度）
//
// 为什么需要这个模块：
//   市场里做朗读的 APP（背单词、点读、听力）大多直接调 window.speechSynthesis。
//   同一份代码在手机 Chrome 里是有声的，在小手机安卓壳里却是哑的——原因是
//   Android System WebView 不带 Chromium 的语音合成组件扩展：speechSynthesis
//   对象存在、getVoices() 也可能返回内容，但 speak() 静默失败。
//
//   能真正发声的只有两条路：
//   a) 原生：壳侧的 SystemTtsBridge（AndroidShell.speakText / stopSpeaking /
//      getSystemVoices / isSpeakingText），驱动系统 TextToSpeech 引擎；
//   b) 宿主页自己的 Web Speech：宿主页面跑在真实浏览器/PWA 里，不是沙盒
//      iframe，iOS Safari 与桌面浏览器都原生支持。
//
//   两条路都不花钱；第三方 API（voice.tts：Minimax / OpenAI）是付费备选，
//   需要用户自备 key，只在用户明确想要特定音色时才用。
//
// 安全边界：只朗读调用方给出的文本。不读页面内容、不落盘、不上传。

export type SystemSpeechResult = {
  /** 是否已被引擎受理（不代表读完） */
  ok: boolean;
  /** 走的是哪条通道 */
  channel: "native" | "web" | "none";
  /** 原生通道返回的朗读 id，可用来匹配 shell-tts 事件 */
  utteranceId?: string;
  /** 失败原因（人类可读） */
  reason?: string;
};

type NativeShellBridge = {
  speakText?: (text: string, lang: string, rate: number) => string;
  stopSpeaking?: () => void;
  isSpeakingText?: () => boolean;
  getSystemVoices?: () => string;
  getSystemTtsState?: () => string;
  hasMicrophonePermission?: () => boolean;
  requestMicrophonePermission?: () => boolean;
  openAppPermissionSettings?: () => boolean;
  isSpeechRecognitionAvailable?: () => boolean;
  startSpeechRecognition?: (lang: string) => string;
  stopSpeechRecognition?: () => void;
  cancelSpeechRecognition?: () => void;
};

function nativeBridge(): NativeShellBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { AndroidShell?: NativeShellBridge }).AndroidShell;
  if (candidate && typeof candidate.speakText === "function") return candidate;
  return null;
}

/** 壳是否提供了系统 TTS 桥（老 APK 没有，网页据此降级）。 */
export function hasNativeSystemTts(): boolean {
  return nativeBridge() !== null;
}

/** 宿主页自己是否有可用的 Web Speech（iOS Safari / 桌面浏览器有，安卓 WebView 通常没有）。 */
export function hasWebSpeech(): boolean {
  if (typeof window === "undefined") return false;
  const synth = (window as unknown as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  if (!synth || typeof window.SpeechSynthesisUtterance !== "function") return false;
  try {
    const voices = synth.getVoices?.() ?? [];
    return voices.length > 0;
  } catch {
    return false;
  }
}

/** 有没有任何免费通道可用（不含付费的 voice.tts）。 */
export function hasSystemTts(): boolean {
  return hasNativeSystemTts() || hasWebSpeech();
}

export type SystemVoice = {
  name: string;
  locale: string;
  quality?: number;
  latency?: number;
  needsNetwork?: boolean;
};

/** 列出手机里真实安装的系统语音包。壳内来自原生引擎；浏览器里来自 getVoices。 */
export function listSystemVoices(): SystemVoice[] {
  const native = nativeBridge();
  if (native?.getSystemVoices) {
    try {
      const raw = native.getSystemVoices();
      const parsed = JSON.parse(raw || "[]") as SystemVoice[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map(item => ({
          name: String(item?.name ?? ""),
          locale: String(item?.locale ?? ""),
          quality: item?.quality,
          latency: item?.latency,
          needsNetwork: item?.needsNetwork === true,
        }));
      }
    } catch {
      /* 落到 Web Speech 分支 */
    }
  }
  if (typeof window === "undefined") return [];
  const synth = (window as unknown as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  if (!synth?.getVoices) return [];
  try {
    return synth.getVoices().map(voice => ({
      name: voice.name,
      locale: voice.lang,
      // 浏览器不给 quality/latency，用 localService 反推「离线可用」
      needsNetwork: voice.localService === false,
    }));
  } catch {
    return [];
  }
}

/** 系统 TTS 状态摘要（诊断面板用；浏览器环境下只有 web 通道信息）。 */
export function getSystemTtsState(): { channel: "native" | "web" | "none"; voices: number; detail?: unknown } {
  const native = nativeBridge();
  if (native?.getSystemTtsState) {
    try {
      const parsed = JSON.parse(native.getSystemTtsState() || "{}");
      return { channel: "native", voices: listSystemVoices().length, detail: parsed };
    } catch {
      return { channel: "native", voices: 0 };
    }
  }
  const voices = listSystemVoices().length;
  return { channel: voices > 0 ? "web" : "none", voices };
}

/**
 * 朗读一段文本。
 *
 * 优先走壳的原生 TextToSpeech（安卓壳内唯一能出声的通道），
 * 其次走宿主页自己的 Web Speech（iOS / 桌面浏览器）。
 * 两条都不可用时返回 ok:false，调用方据此提示用户装语音包或改用付费 voice.tts。
 *
 * 注意：ok 只代表「引擎受理了」，不代表已经读完。需要知道朗读结束时，
 * 监听 window 的 `shell-tts` 事件（原生通道，detail.type = start/end/stop/error），
 * 或给 Web Speech 的 utterance 挂 onend（本函数内部已在 web 通道自动处理超时兜底）。
 */
export function speakWithSystemVoice(
  text: string,
  options?: { lang?: string; rate?: number },
): SystemSpeechResult {
  const content = String(text ?? "");
  if (!content.trim()) return { ok: false, channel: "none", reason: "没有可朗读的内容" };
  const lang = (options?.lang || "en-US").trim() || "en-US";
  const rate = typeof options?.rate === "number" && Number.isFinite(options.rate) && options.rate > 0
    ? options.rate
    : 1;

  const native = nativeBridge();
  if (native?.speakText) {
    try {
      const raw = native.speakText(content, lang, rate);
      let parsed: { ok?: boolean; utteranceId?: string; message?: string; reason?: string } = {};
      try {
        parsed = JSON.parse(raw || "{}");
      } catch {
        // 老壳若直接返回布尔字符串，按成功处理（无法拿到 utteranceId）
        return { ok: raw !== "false", channel: "native" };
      }
      if (parsed.ok === false) {
        return {
          ok: false,
          channel: "native",
          reason: parsed.message || parsed.reason || "系统语音拒绝了这次朗读",
        };
      }
      return { ok: true, channel: "native", utteranceId: parsed.utteranceId };
    } catch (error) {
      // 桥调用抛异常不阻断：继续试 Web Speech
      const message = error instanceof Error ? error.message : String(error);
      const web = speakViaWeb(content, lang, rate);
      return web.ok ? web : { ok: false, channel: "none", reason: message };
    }
  }

  return speakViaWeb(content, lang, rate);
}

function speakViaWeb(text: string, lang: string, rate: number): SystemSpeechResult {
  if (typeof window === "undefined") return { ok: false, channel: "none", reason: "当前环境不支持语音" };
  const synth = (window as unknown as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  const Utterance = (window as unknown as { SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance })
    .SpeechSynthesisUtterance;
  if (!synth || typeof Utterance !== "function") {
    return { ok: false, channel: "none", reason: "当前环境没有语音合成能力" };
  }
  try {
    const utterance = new Utterance(text);
    utterance.lang = lang;
    utterance.rate = rate;
    synth.cancel();
    synth.speak(utterance);
    return { ok: true, channel: "web" };
  } catch (error) {
    return {
      ok: false,
      channel: "none",
      reason: error instanceof Error ? error.message : "语音合成失败",
    };
  }
}

/** 立刻停止朗读（原生与 Web Speech 都停）。 */
export function stopSystemVoice(): void {
  const native = nativeBridge();
  if (native?.stopSpeaking) {
    try { native.stopSpeaking(); } catch { /* ignore */ }
  }
  if (typeof window !== "undefined") {
    const synth = (window as unknown as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
    try { synth?.cancel(); } catch { /* ignore */ }
  }
}

/** 当前是否正在朗读。 */
export function isSystemVoiceSpeaking(): boolean {
  const native = nativeBridge();
  if (native?.isSpeakingText) {
    try { return native.isSpeakingText() === true; } catch { /* ignore */ }
  }
  if (typeof window !== "undefined") {
    const synth = (window as unknown as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
    try { return synth?.speaking === true; } catch { /* ignore */ }
  }
  return false;
}

export type ShellTtsEvent = {
  type: "start" | "end" | "stop" | "error";
  utteranceId?: string;
  message?: string;
};

/**
 * 监听原生朗读的生命周期事件（壳内才可用）。
 * 返回取消订阅函数。非壳环境调用是安全的 no-op。
 */
export function onShellTts(listener: (event: ShellTtsEvent) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent).detail as ShellTtsEvent | undefined;
    if (detail && typeof detail.type === "string") listener(detail);
  };
  window.addEventListener("shell-tts", handler as EventListener);
  return () => window.removeEventListener("shell-tts", handler as EventListener);
}

// ── 麦克风权限（通话「按住说话」、语音消息的前提）────────────────
// 危险权限被拒一次后系统不再弹窗，getUserMedia 会永远静默失败，
// 用户看到的就是「壳不支持录音」。壳侧提供了检查/申请/跳设置三个入口。

export type MicrophonePermissionState = "granted" | "denied" | "unknown";

/** 查询麦克风权限（壳内走原生；浏览器里只能靠试探，返回 unknown）。 */
export function getMicrophonePermission(): MicrophonePermissionState {
  const native = nativeBridge();
  if (native?.hasMicrophonePermission) {
    try { return native.hasMicrophonePermission() ? "granted" : "denied"; } catch { /* ignore */ }
  }
  return "unknown";
}

/**
 * 申请麦克风权限。返回 true 表示已授权；false 表示弹出了系统对话框
 * （或已被永久拒绝），需要稍后重新查询状态。
 */
export async function requestMicrophonePermission(): Promise<boolean> {
  const native = nativeBridge();
  if (native?.requestMicrophonePermission) {
    try {
      if (native.requestMicrophonePermission()) return true;
      // 系统对话框是异步的，轮询几次看用户是否点了允许
      for (let i = 0; i < 20; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 250));
        if (native.hasMicrophonePermission?.()) return true;
      }
      return false;
    } catch {
      return false;
    }
  }
  return false;
}

/** 跳到系统里本应用的权限页（麦克风被永久拒绝时唯一的恢复路径）。 */
export function openMicrophonePermissionSettings(): boolean {
  const native = nativeBridge();
  if (!native?.openAppPermissionSettings) return false;
  try { return native.openAppPermissionSettings() === true; } catch { return false; }
}
