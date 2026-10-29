// lib/stt-cloud.ts — 云端语音识别（按住说话）
//
// 非 iOS 设备的通话不再依赖浏览器 Web Speech API（国内安卓基本不可用，且持续
// 开麦会把整页音频会话钉在通话模式）。改为微信式按住说话：按住用 MediaRecorder
// 录一段音，松手后发给 OpenAI 兼容的 /audio/transcriptions 转文字。麦克风只在
// 按住的几秒内打开，松手立刻释放，不再有音频会话残留问题。
// iOS 保持原有 Web Speech 免提方案（见 tts-service.ts 的会话说明）。

import { loadBindingConfig, loadVoiceConfigs, resolveBinding } from "./settings-storage";
import type { VoiceApiConfig } from "./settings-types";

export type CloudSttConfig = {
    baseUrl: string;
    apiKey: string;
    model: string;
};

const DEFAULT_STT_MODEL = "whisper-1";
const TRANSCRIBE_TIMEOUT_MS = 60_000;
// 录音兜底上限：忘记松手/指针事件丢失时自动停，避免无限占用麦克风
const MAX_RECORDING_MS = 60_000;

/**
 * 安卓壳的原生录音桥（见 android-shell/.../MainActivity.kt 的 ShellBridge）。
 * 存在的意义：部分 ROM/WebView 组合会直接拒绝页面的 getUserMedia，请求根本到不了
 * 系统层（系统「行为记录 → 录音」里查不到本应用），授系统权限也没用。
 * 实测同一台机 Chrome 浏览器能录、壳内 WebView 不能，所以录音改由壳来做。
 */
type NativeRecordBridge = {
    hasRecordPermission?: () => boolean;
    requestRecordPermission?: () => boolean;
    startNativeRecord?: () => string;
    stopNativeRecord?: () => string;
    cancelNativeRecord?: () => string;
};

function nativeRecordBridge(): NativeRecordBridge | null {
    if (typeof window === "undefined") return null;
    const bridge = (window as unknown as { AndroidShell?: NativeRecordBridge }).AndroidShell;
    if (!bridge || typeof bridge.startNativeRecord !== "function") return null;
    return bridge;
}

function bridgeParse(raw: unknown): Record<string, unknown> | null {
    try {
        const value = JSON.parse(String(raw ?? ""));
        return value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

/** dataUrl → Blob（原生桥交回的是 base64，转写接口要 Blob/FormData）。 */
function dataUrlToBlob(dataUrl: string): Blob | null {
    const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl);
    if (!match) return null;
    const mime = match[1] || "audio/mp4";
    try {
        if (match[2]) {
            const binary = atob(match[3]);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return new Blob([bytes], { type: mime });
        }
        return new Blob([decodeURIComponent(match[3])], { type: mime });
    } catch {
        return null;
    }
}

function bridgeReasonText(reason: string): string {
    if (reason === "no-permission") return "小手机还没有录音权限。";
    if (reason === "busy") return "麦克风正被占用，等一下再试。";
    if (reason === "empty") return "没有录到声音（按得太短）。";
    if (reason === "no-active-recording") return "当前没有正在进行的录音。";
    return reason;
}

/** 用壳的原生录音器录一段，接口与 Web MediaRecorder 版本保持一致。 */
async function startNativeCallRecording(bridge: NativeRecordBridge): Promise<ActiveCallRecording> {
    if (bridge.hasRecordPermission && !bridge.hasRecordPermission()) {
        try { bridge.requestRecordPermission?.(); } catch { /* 用户之前拒绝过，可能不弹窗 */ }
        throw new Error("小手机还没有录音权限，已尝试弹出授权，允许后再按一次。");
    }

    const startInfo = bridgeParse(bridge.startNativeRecord?.());
    if (!startInfo || startInfo.ok !== true) {
        throw new Error(`原生录音启动失败：${bridgeReasonText(String(startInfo?.reason ?? "未知原因"))}`);
    }

    let finished = false;
    let cancelled = false;

    return {
        stop: () => Promise.resolve().then(() => {
            if (finished) return null;
            finished = true;
            const info = bridgeParse(bridge.stopNativeRecord?.());
            if (!info || info.ok !== true) return null;
            const dataUrl = typeof info.dataUrl === "string" ? info.dataUrl : "";
            if (!dataUrl) return null;
            return dataUrlToBlob(dataUrl);
        }),
        cancel: () => {
            if (finished) return;
            cancelled = true;
            finished = true;
            try { bridge.cancelNativeRecord?.(); } catch { /* 忽略 */ }
            void cancelled;
        },
    };
}

function toCloudSttConfig(config: VoiceApiConfig | undefined | null): CloudSttConfig | null {
    if (!config || config.provider !== "OpenAI") return null;
    if (!config.apiKey?.trim()) return null;
    if (config.enableSTT === false) return null;
    return {
        baseUrl: (config.baseUrl || "https://api.openai.com/v1").trim().replace(/\/+$/, ""),
        apiKey: config.apiKey.trim(),
        model: config.sttModel?.trim() || DEFAULT_STT_MODEL,
    };
}

/**
 * 解析可用的云端识别配置：优先角色绑定的语音配置（须为 OpenAI 兼容且启用 STT），
 * 否则取第一个满足条件的语音配置。没有则返回 null（通话回落到旧输入方式）。
 */
export function resolveCloudSttConfig(characterId?: string): CloudSttConfig | null {
    const configs = loadVoiceConfigs();
    if (characterId) {
        const bindings = loadBindingConfig();
        const slot = resolveBinding(bindings, characterId, "chat");
        const bound = configs.find(c => c.id === slot.voiceConfigId);
        const fromBound = toCloudSttConfig(bound);
        if (fromBound) return fromBound;
    }
    for (const config of configs) {
        const cloud = toCloudSttConfig(config);
        if (cloud) return cloud;
    }
    return null;
}

/** 页面侧（Web MediaRecorder）是否存在。注意它只检查 API 存在，不代表真能拿到麦克风。 */
function hasWebRecorder(): boolean {
    return typeof navigator !== "undefined"
        && !!navigator.mediaDevices?.getUserMedia
        && typeof MediaRecorder !== "undefined";
}

export function isCallRecordingSupported(): boolean {
    // 壳里有原生录音桥也算支持：Android WebView 常常拿不到 getUserMedia，
    // 但壳自己录是通的，不能因为页面没 getUserMedia 就把入口藏掉。
    if (typeof window !== "undefined" && nativeRecordBridge()) return true;
    return hasWebRecorder();
}

export type ActiveCallRecording = {
    /** 松手：停止录音并返回音频（没录到内容返回 null）。 */
    stop: () => Promise<Blob | null>;
    /** 取消：丢弃已录内容，立即释放麦克风。 */
    cancel: () => void;
};

/** 按下开始录音。resolve 时麦克风已经在录；权限被拒等失败会 reject。 */
async function startWebCallRecording(): Promise<ActiveCallRecording> {
    if (!hasWebRecorder()) throw new Error("当前环境不支持录音");

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {
        throw new Error("麦克风权限被拒绝或不可用");
    });

    // 优先 opus：体积小、转写接口普遍支持
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
        .find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } });
    const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32_000 })
        : new MediaRecorder(stream);

    const chunks: Blob[] = [];
    let finished = false;
    let cancelled = false;
    let resolveStop: ((blob: Blob | null) => void) | null = null;

    const releaseMic = () => {
        try { stream.getTracks().forEach(track => track.stop()); } catch { /* ignore */ }
    };

    recorder.ondataavailable = event => {
        if (event.data && event.data.size) chunks.push(event.data);
    };
    recorder.onstop = () => {
        if (finished) return;
        finished = true;
        window.clearTimeout(maxTimer);
        releaseMic();
        if (cancelled) { resolveStop?.(null); return; }
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        resolveStop?.(blob.size > 0 ? blob : null);
    };
    recorder.onerror = () => {
        if (finished) return;
        finished = true;
        window.clearTimeout(maxTimer);
        releaseMic();
        resolveStop?.(null);
    };

    const maxTimer = window.setTimeout(() => {
        try { recorder.stop(); } catch { /* ignore */ }
    }, MAX_RECORDING_MS);

    recorder.start();

    return {
        stop: () => new Promise<Blob | null>(resolve => {
            resolveStop = resolve;
            if (finished) { resolve(null); return; }
            try { recorder.stop(); } catch { recorder.onstop?.(new Event("stop") as never); }
        }),
        cancel: () => {
            cancelled = true;
            if (finished) return;
            try { recorder.stop(); } catch {
                finished = true;
                window.clearTimeout(maxTimer);
                releaseMic();
            }
        },
    };
}

/**
 * 按下开始录音。resolve 时麦克风已经在录；权限被拒等失败会 reject。
 *
 * 两级策略：先走页面自己的 MediaRecorder；拿不到麦克风时退回壳的原生录音。
 * 后者是 Android WebView 的兜底——有些 ROM/WebView 组合会把页面的 getUserMedia
 * 直接拒掉，请求连系统层都到不了，授系统权限也没用（实测同机 Chrome 能录、壳内不能）。
 * 两条路最终都交出 Blob，转写链路完全不用关心音频是哪儿录的。
 */
export async function startCallRecording(): Promise<ActiveCallRecording> {
    try {
        return await startWebCallRecording();
    } catch (webError) {
        const bridge = nativeRecordBridge();
        if (!bridge) throw webError;
        console.warn("[CallRecord] 页面录音失败，改用壳原生录音：", webError);
        return startNativeCallRecording(bridge);
    }
}

/** 调 OpenAI 兼容 /audio/transcriptions 把录音转文字。 */
export async function transcribeAudioBlob(blob: Blob, config: CloudSttConfig): Promise<string> {
    const type = (blob.type || "").toLowerCase();
    const ext = type.includes("mp4") ? "mp4"
        : type.includes("ogg") ? "ogg"
        : type.includes("wav") ? "wav"
        : "webm";
    const form = new FormData();
    form.set("model", config.model);
    form.set("file", blob, `speech.${ext}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
    try {
        const res = await fetch(`${config.baseUrl}/audio/transcriptions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${config.apiKey}` },
            body: form,
            signal: controller.signal,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`语音识别 API 错误 ${res.status}: ${text.slice(0, 200)}`);
        }
        const contentType = (res.headers.get("content-type") || "").toLowerCase();
        if (contentType.includes("json")) {
            const data = await res.json() as { text?: unknown };
            return typeof data.text === "string" ? data.text.trim() : "";
        }
        // response_format=text 风格的中转直接回纯文本
        return (await res.text()).trim();
    } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
            throw new Error(`语音识别超时（超过 ${Math.round(TRANSCRIBE_TIMEOUT_MS / 1000)} 秒无响应）`);
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}
