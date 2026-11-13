// lib/system-stt.ts — 用**手机自带的识别引擎**把说话转成文字（免费、通常可离线）
//
// 为什么需要它：
//   聊天室和通话里的语音输入走的是 webkitSpeechRecognition（Web Speech API）。
//   但 Android System WebView 没有可用的识别后端（Chromium 的语音识别依赖
//   Google 在线服务/组件扩展，WebView 不带），start() 会立刻以
//   `audio-capture` 失败 —— 网页只能显示「无法访问麦克风」，用户以为是权限
//   没给，其实给了也没用。只有原生 SpeechRecognizer 才能真正开麦识别。
//
// 与「录音」的区别（重要）：
//   本模块**只返回文字，不返回音频**。能做「说话转文字」（通话对讲、语音输入），
//   做不了「录一条语音消息发给角色」——那需要 MediaRecorder + getUserMedia，
//   走的是另一条链路（壳已代转授麦克风权限）。
//
// 事件协议（原生 → 网页，window 上的 `shell-stt` 事件）：
//   detail = { type, sessionId, text?, message?, code?, rms?, reason? }
//   type: start | speech | volume | partial | endOfSpeech | final | end | error
//      start      引擎已开始监听
//      speech     检测到人开始说话
//      volume     音量波形（rms，负数 dB）
//      partial    中间结果（边说边出字）
//      endOfSpeech 检测到说完了，等最终结果
//      final      最终文字
//      end        没拿到文字就结束了（reason: noSpeech / timeout）
//      error      出错（message 是人话）

export type SystemSttEvent = {
  type: "start" | "speech" | "volume" | "partial" | "endOfSpeech" | "final" | "end" | "error";
  sessionId: string;
  text?: string;
  message?: string;
  reason?: string;
  code?: number;
  rms?: number;
};

type NativeSttBridge = {
  isSpeechRecognitionAvailable?: () => boolean;
  startSpeechRecognition?: (lang: string) => string;
  stopSpeechRecognition?: () => void;
  cancelSpeechRecognition?: () => void;
};

function nativeStt(): NativeSttBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { AndroidShell?: NativeSttBridge }).AndroidShell;
  if (candidate && typeof candidate.startSpeechRecognition === "function") return candidate;
  return null;
}

/** 壳是否提供了系统识别桥（老 APK 没有，网页据此降级）。 */
export function hasNativeSpeechRecognition(): boolean {
  return nativeStt() !== null;
}

/**
 * 本机能不能做「系统级」语音识别。
 * 壳内看原生桥 + 系统是否真装了识别服务；浏览器里返回 false（走 Web Speech）。
 */
export function isSystemSpeechRecognitionAvailable(): boolean {
  const bridge = nativeStt();
  if (!bridge?.isSpeechRecognitionAvailable) return false;
  try {
    return bridge.isSpeechRecognitionAvailable() === true;
  } catch {
    return false;
  }
}

export type SystemSttSession = {
  sessionId: string;
  /** 结束采集（松手发送），引擎随后给出 final。 */
  stop: () => void;
  /** 取消并丢弃内容（上滑取消）。 */
  cancel: () => void;
};

/**
 * 开始一次系统语音识别。失败时抛错（消息可直接展示给用户）。
 * 结果通过 onShellSttEvent 订阅的 `shell-stt` 事件拿到。
 */
export function startSystemSpeechRecognition(lang = "zh-CN"): SystemSttSession {
  const bridge = nativeStt();
  if (!bridge?.startSpeechRecognition) throw new Error("当前环境没有系统语音识别");
  const raw = bridge.startSpeechRecognition(lang);
  let parsed: { ok?: boolean; sessionId?: string; message?: string; reason?: string } = {};
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    throw new Error("语音识别桥返回了无法解析的结果");
  }
  if (parsed.ok === false) {
    throw new Error(parsed.message || parsed.reason || "无法开始语音识别");
  }
  return {
    sessionId: parsed.sessionId || "",
    stop: () => {
      try { bridge.stopSpeechRecognition?.(); } catch { /* ignore */ }
    },
    cancel: () => {
      try { bridge.cancelSpeechRecognition?.(); } catch { /* ignore */ }
    },
  };
}

/**
 * 订阅系统识别事件。返回取消订阅函数。
 * 非壳环境调用是安全的 no-op（只会永远收不到事件）。
 */
export function onShellSttEvent(listener: (event: SystemSttEvent) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent).detail as SystemSttEvent | undefined;
    if (detail && typeof detail.type === "string") listener(detail);
  };
  window.addEventListener("shell-stt", handler as EventListener);
  return () => window.removeEventListener("shell-stt", handler as EventListener);
}

/**
 * 等待一次完整识别的便捷封装：自动订阅、自动清理。
 *
 * resolve 时返回最终文字（可能为空串 = 没识别到 / 超时）。
 * 用户取消会话时 reject。
 *
 * 调用方拿到文字后自己决定发消息还是填进输入框——本模块不碰聊天。
 */
export function recognizeOnce(
  options?: { lang?: string; timeoutMs?: number },
): {
  promise: Promise<string>;
  stop: () => void;
  cancel: () => void;
} {
  const lang = options?.lang || "zh-CN";
  const timeoutMs = options?.timeoutMs ?? 60_000;
  let session: SystemSttSession | null = null;
  let cleanup: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;

  const promise = new Promise<string>((resolve, reject) => {
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cleanup?.();
      fn();
    };

    cleanup = onShellSttEvent(event => {
      if (session && event.sessionId && session.sessionId && event.sessionId !== session.sessionId) return;
      if (event.type === "final") {
        finish(() => resolve((event.text || "").trim()));
      } else if (event.type === "end") {
        // 没拿到文字就结束：resolve 空串，让调用方区分「没说话」和「出错」
        finish(() => resolve((event.text || "").trim()));
      } else if (event.type === "error") {
        finish(() => reject(new Error(event.message || "语音识别失败")));
      }
    });

    try {
      session = startSystemSpeechRecognition(lang);
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      return;
    }

    timer = setTimeout(() => {
      try { session?.stop(); } catch { /* ignore */ }
      finish(() => resolve(""));
    }, timeoutMs);
  });

  return {
    promise,
    stop: () => { try { session?.stop(); } catch { /* ignore */ } },
    cancel: () => {
      try { session?.cancel(); } catch { /* ignore */ }
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        cleanup?.();
      }
    },
  };
}
