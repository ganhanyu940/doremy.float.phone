// lib/stt-service.ts — 语音识别服务
//
// 两条通道，按环境自动选：
//   1. 壳内（安卓 APK）：原生 SpeechRecognizer（见 lib/system-stt.ts）。
//      **这是壳里唯一能用的通道** —— Android System WebView 没有 Web Speech
//      的识别后端（Chromium 的语音识别依赖 Google 在线服务/组件扩展，WebView
//      不带），webkitSpeechRecognition.start() 必定以 audio-capture 失败，
//      界面只会显示「无法访问麦克风」。用户把权限全开也没用，这不是权限问题。
//   2. 浏览器（iOS Safari / 桌面 Chrome）：Web Speech API，原生支持。

import {
    hasNativeSpeechRecognition,
    isSystemSpeechRecognitionAvailable,
    onShellSttEvent,
    startSystemSpeechRecognition,
    type SystemSttSession,
} from "./system-stt";

/** 是否跑在带原生桥的安卓壳里（老 APK 有桥但没有 STT 方法时也算"壳里"）。 */
function isShellWithNativeBridge(): boolean {
    return hasNativeSpeechRecognition() || hasAnyNativeShell();
}

/** 壳环境的兜底判定：只要有 AndroidShell 桥就认为在壳里（用于给准确报错）。 */
function hasAnyNativeShell(): boolean {
    if (typeof window === "undefined") return false;
    const shell = (window as unknown as { AndroidShell?: Record<string, unknown> }).AndroidShell;
    return Boolean(shell && typeof shell.getVersion === "function");
}

type SpeechRecognitionAlternativeLike = { transcript: string };
type SpeechRecognitionResultLike = {
    isFinal: boolean;
    0: SpeechRecognitionAlternativeLike;
};
type SpeechRecognitionResultsLike = ArrayLike<SpeechRecognitionResultLike>;
type SpeechRecognitionEventLike = { results: SpeechRecognitionResultsLike };
type SpeechRecognitionErrorEventLike = { error: string };

interface SpeechRecognitionLike {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    maxAlternatives: number;
    onresult: ((event: SpeechRecognitionEventLike) => void) | null;
    onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
    abort(): void;
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;
type SpeechRecognitionWindow = Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

export type STTCallbacks = {
    onInterim: (text: string) => void;
    onFinal: (text: string) => void;
    onError: (error: string) => void;
    onEnd: () => void;         // 没有识别到任何内容就结束了
    onNoSpeech: () => void;    // 没检测到语音（用于自动重试）
};

export type STTSession = {
    start: () => void;
    stop: () => void;
    abort: () => void;
    isSupported: boolean;
};

/**
 * Create an STT session using browser Web Speech API.
 */
export function createSTTSession(
    callbacks: STTCallbacks,
    lang = "zh-CN",
): STTSession {
    // 壳内优先走原生识别。判定条件用「系统真装了识别服务」而不是「有没有桥」，
    // 因为老 APK 有设备压根没装识别引擎，那时再回退 Web Speech 也是哑的，
    // 但至少不会让代码以为能识别却一直等不到结果。
    if (typeof window !== "undefined" && isSystemSpeechRecognitionAvailable()) {
        return createNativeSttSession(callbacks, lang);
    }
    // 在壳里但系统没装识别服务：别退回 Web Speech（那里必定 audio-capture 失败，
    // 只会让用户看到「无法访问麦克风」这条误导性提示）。直接给出可操作的说明。
    if (typeof window !== "undefined" && isShellWithNativeBridge()) {
        return {
            start: () => callbacks.onError(
                "这台手机的语音识别服务不可用：请在系统设置里安装或启用「语音服务 / 语音识别」，"
                + "或在「设置 → 语音 API」配置一个 OpenAI 兼容的语音识别接口。",
            ),
            stop: () => {},
            abort: () => {},
            isSupported: false,
        };
    }

    const SpeechRecognition =
        (window as SpeechRecognitionWindow).SpeechRecognition || (window as SpeechRecognitionWindow).webkitSpeechRecognition;

    if (!SpeechRecognition) {
        return {
            start: () => callbacks.onError("浏览器不支持语音识别"),
            stop: () => {},
            abort: () => {},
            isSupported: false,
        };
    }

    const recognition = new SpeechRecognition();
    recognition.lang = lang;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    let aborted = false;
    let finalText = "";
    let hadNoSpeech = false;

    recognition.onresult = (event: SpeechRecognitionEventLike) => {
        if (aborted) return;

        let interim = "";
        finalText = "";
        for (let i = 0; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                finalText += transcript;
            } else {
                interim += transcript;
            }
        }

        callbacks.onInterim(finalText + interim);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
        if (aborted) return;
        if (event.error === "aborted") return;

        if (event.error === "no-speech") {
            hadNoSpeech = true;
            return;
        }

        const errorMap: Record<string, string> = {
            "audio-capture": "无法访问麦克风",
            "not-allowed": "麦克风权限被拒绝",
            "network": "网络错误",
        };
        callbacks.onError(errorMap[event.error] || `语音识别错误: ${event.error}`);
    };

    recognition.onend = () => {
        if (aborted) return;

        if (finalText.trim()) {
            callbacks.onFinal(finalText.trim());
        } else if (hadNoSpeech) {
            hadNoSpeech = false;
            callbacks.onNoSpeech();
        } else {
            callbacks.onEnd();
        }
    };

    return {
        start: () => {
            aborted = false;
            finalText = "";
            hadNoSpeech = false;
            try {
                recognition.start();
            } catch {
                // Already started — ignore
            }
        },
        stop: () => {
            try {
                recognition.stop();
            } catch {
                // Already stopped — ignore
            }
        },
        abort: () => {
            aborted = true;
            try {
                recognition.abort();
            } catch {
                // Already aborted — ignore
            }
        },
        isSupported: true,
    };
}

/**
 * 壳内用原生 SpeechRecognizer 的识别会话。
 *
 * 与 Web Speech 分支保持完全相同的回调契约（onInterim / onFinal / onError /
 * onEnd / onNoSpeech），调用方无需知道底下走的是哪条通道。
 *
 * 差异说明：原生引擎的中间结果（partial）是累加的，最终结果（final）是独立的
 * 一句话；这里统一成「onInterim 给当前可见文本、onFinal 给最终文字」，
 * 与 Web Speech 的语义对齐。
 */
function createNativeSttSession(callbacks: STTCallbacks, lang: string): STTSession {
    let session: SystemSttSession | null = null;
    let unsubscribe: (() => void) | null = null;
    let aborted = false;
    let finalText = "";
    let sawError = false;

    const cleanup = () => {
        unsubscribe?.();
        unsubscribe = null;
    };

    return {
        start: () => {
            aborted = false;
            finalText = "";
            sawError = false;
            cleanup();
            unsubscribe = onShellSttEvent(event => {
                if (aborted) return;
                // 同一个页面可能有多个会话，只处理本会话的事件
                if (session && session.sessionId && event.sessionId && event.sessionId !== session.sessionId) return;

                switch (event.type) {
                    case "partial": {
                        const text = (event.text || "").trim();
                        if (text) callbacks.onInterim(text);
                        break;
                    }
                    case "final": {
                        finalText = (event.text || "").trim();
                        cleanup();
                        if (finalText) callbacks.onFinal(finalText);
                        else callbacks.onNoSpeech();
                        break;
                    }
                    case "end": {
                        // 没拿到文字就结束了：noSpeech / timeout
                        cleanup();
                        if (event.text && event.text.trim()) callbacks.onFinal(event.text.trim());
                        else if (event.reason === "noSpeech") callbacks.onNoSpeech();
                        else callbacks.onEnd();
                        break;
                    }
                    case "error": {
                        sawError = true;
                        cleanup();
                        callbacks.onError(event.message || "语音识别失败");
                        break;
                    }
                    default:
                        break;
                }
            });

            try {
                session = startSystemSpeechRecognition(lang);
            } catch (error) {
                cleanup();
                const message = error instanceof Error ? error.message : String(error);
                // 原生起不来（比如没识别服务/权限被拒）才回退 Web Speech；
                // 但壳里基本也起不来，所以直接把真实原因报给用户，别让人误以为是权限。
                callbacks.onError(message);
            }
        },
        stop: () => {
            try { session?.stop(); } catch { /* ignore */ }
        },
        abort: () => {
            aborted = true;
            try { session?.cancel(); } catch { /* ignore */ }
            cleanup();
            if (!sawError && !finalText) callbacks.onEnd();
        },
        isSupported: true,
    };
}
