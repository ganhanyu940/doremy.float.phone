"use client";

// 麦克风自检面板（配合安卓壳 1.0.15 的探针）
//
// 存在理由：壳内 getUserMedia 失败时，页面上什么都不会说——只有 console 里一行
// 报错，用户看不到。而「请求到底走到哪一步了」决定了该怎么修：
//   · onPermissionRequest 被调用 + grant 了，但仍然失败 → ROM/采集层问题；
//   · onPermissionRequest 压根没被调用 → 请求在 WebView 内部就被拒，改壳的授权代码无用。
// 这个面板把两边的证据摊在屏幕上，用户截图即可，不必连电脑看 chrome://inspect。
//
// 只读诊断：除了用户主动点按钮时申请一次录音权限、开一次麦（立刻关掉）之外，
// 不做任何采集，也不改设置。

import { useCallback, useState } from "react";
import { AlertCircle, Check, Copy, Mic, RefreshCw, X } from "lucide-react";

type ShellMicBridge = {
    getVersion?: () => string;
    hasRecordPermission?: () => boolean;
    requestRecordPermission?: () => boolean;
    getMicProbe?: () => string;
    logMicProbe?: (text: string) => void;
    clearMicProbe?: () => void;
};

type ProbeRow = { label: string; ok: boolean | null; detail: string };

type ProbeDump = {
    version?: string;
    sdkInt?: number;
    webViewPackage?: string;
    hasRecordPermission?: boolean;
    events?: string[];
};

function getBridge(): ShellMicBridge | null {
    if (typeof window === "undefined") return null;
    const bridge = (window as unknown as { AndroidShell?: ShellMicBridge }).AndroidShell;
    return bridge && typeof bridge === "object" ? bridge : null;
}

function sleep(ms: number): Promise<void> {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
}

/** WebView 里 getUserMedia 有时既不 resolve 也不 reject（回调根本没来），必须自己兜超时。 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`超时 ${ms}ms 没有任何回调（请求可能卡在容器层）`)),
            ms,
        );
        promise.then(
            value => { clearTimeout(timer); resolve(value); },
            error => { clearTimeout(timer); reject(error); },
        );
    });
}

function parseDump(raw: unknown): ProbeDump | null {
    try {
        const value = JSON.parse(String(raw ?? ""));
        return value && typeof value === "object" && !Array.isArray(value)
            ? (value as ProbeDump)
            : null;
    } catch {
        return null;
    }
}

function statusIcon(ok: boolean | null) {
    if (ok === true) return <Check size={15} strokeWidth={2.2} className="text-emerald-600" />;
    if (ok === false) return <X size={15} strokeWidth={2.2} className="text-red-500" />;
    return <AlertCircle size={15} strokeWidth={2} className="text-amber-500" />;
}

export function MicProbePanel() {
    const [rows, setRows] = useState<ProbeRow[]>([]);
    const [dump, setDump] = useState<ProbeDump | null>(null);
    const [hasProbeApi, setHasProbeApi] = useState<boolean | null>(null);
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);

    const refreshDump = useCallback(() => {
        const bridge = getBridge();
        if (!bridge?.getMicProbe) {
            setHasProbeApi(false);
            setDump(null);
            return;
        }
        setHasProbeApi(true);
        setDump(parseDump(bridge.getMicProbe()));
    }, []);

    const run = useCallback(async () => {
        setBusy(true);
        setCopied(false);
        const bridge = getBridge();
        const next: ProbeRow[] = [];
        const push = (label: string, ok: boolean | null, detail: string) => {
            next.push({ label, ok, detail });
        };

        try {
            push(
                "运行环境",
                !!bridge,
                bridge
                    ? `壳版本 ${bridge.getVersion?.() ?? "未知（老壳无 getVersion）"}`
                    : "不在壳里：浏览器直接打开，或壳太老没有 AndroidShell 桥",
            );
            push(
                "安全上下文",
                typeof window !== "undefined" ? window.isSecureContext : null,
                typeof window !== "undefined"
                    ? `${location.origin} · isSecureContext=${window.isSecureContext}`
                    : "-",
            );

            const mediaDevices = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
            push(
                "mediaDevices 接口",
                !!mediaDevices,
                mediaDevices ? "存在" : "不存在：WebView 没有暴露媒体设备接口",
            );

            // 壳的系统权限：先查，没授权就让壳弹一次，再复查
            if (bridge?.hasRecordPermission) {
                let granted = bridge.hasRecordPermission();
                push("壳·系统录音权限", granted, granted ? "已授权" : "未授权");
                if (!granted && bridge.requestRecordPermission) {
                    bridge.requestRecordPermission();
                    await sleep(1500);
                    granted = bridge.hasRecordPermission();
                    push(
                        "壳·申请后复查",
                        granted,
                        granted ? "已授权" : "仍未授权（请到系统设置里手动允许「录音」）",
                    );
                }
            } else if (bridge) {
                push("壳·系统录音权限", null, "老壳没有 hasRecordPermission，查不到");
            }

            // 主菜：getUserMedia
            if (!mediaDevices) {
                push("getUserMedia", false, "接口不存在，跳过");
            } else {
                try {
                    const stream = await withTimeout(mediaDevices.getUserMedia({ audio: true }), 10_000);
                    const tracks = stream.getAudioTracks();
                    const label = tracks[0]?.label || "无标签";
                    push("getUserMedia", true, `成功 · ${tracks.length} 条音频轨 · 「${label}」`);
                    stream.getTracks().forEach(track => track.stop());
                } catch (error) {
                    const err = error as { name?: string; message?: string };
                    const detail = `${err?.name ?? "Error"}: ${err?.message ?? String(error)}`;
                    push("getUserMedia", false, detail);
                    bridge?.logMicProbe?.(`getUserMedia ${detail}`);
                }
            }

            // 设备枚举：有标签说明授权真的生效了（未授权时 label 是空的）
            try {
                const devices = await mediaDevices?.enumerateDevices?.();
                const inputs = (devices ?? []).filter(device => device.kind === "audioinput");
                push(
                    "音频输入设备",
                    inputs.length > 0,
                    inputs.length > 0
                        ? inputs.map(device => device.label || "(未授权，无标签)").join(" / ")
                        : "一个都没枚举到",
                );
            } catch {
                push("音频输入设备", null, "枚举失败（不影响上面的结论）");
            }
        } finally {
            setRows(next);
            refreshDump();
            setBusy(false);
        }
    }, [refreshDump]);

    const buildReport = useCallback(() => {
        const lines = rows.map(row => {
            const mark = row.ok === true ? "[OK]" : row.ok === false ? "[FAIL]" : "[--]";
            return `${mark} ${row.label}: ${row.detail}`;
        });
        lines.push("");
        if (dump) {
            lines.push(
                `壳 ${dump.version ?? "?"} · SDK ${dump.sdkInt ?? "?"} · WebView ${dump.webViewPackage || "?"} · 录音权限 ${dump.hasRecordPermission ? "已授权" : "未授权"}`,
            );
            lines.push("—— 壳内探针 ——");
            const events = dump.events ?? [];
            if (events.length === 0) lines.push("(空)");
            else events.forEach(event => lines.push(event));
        } else {
            lines.push("壳内探针：无（需要壳 1.0.15 及以上；老壳没有 getMicProbe）");
        }
        return lines.join("\n");
    }, [rows, dump]);

    const copyReport = useCallback(async () => {
        const text = buildReport();
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // WebView 里 clipboard 可能不可用：退回让用户长按选中
            setCopied(false);
        }
    }, [buildReport]);

    return (
        <div className="flex flex-col gap-3 rounded-2xl border border-black/10 bg-white/60 p-4">
            <div className="flex items-center gap-2">
                <Mic size={17} strokeWidth={1.9} />
                <span className="text-[calc(14.4px*var(--app-text-scale,1))] font-bold text-[var(--c-text-title)]">
                    麦克风自检
                </span>
            </div>
            <p className="menu-desc m-0">
                检查页面到底能不能拿到麦克风。只看不改：不录音、不改设置。出问题时把这页截图发给小坊。
            </p>

            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    onClick={run}
                    disabled={busy}
                    className="ui-btn ui-btn-primary rounded-[20px]"
                >
                    <RefreshCw size={15} className={busy ? "animate-spin" : undefined} />
                    {busy ? "检查中…" : "开始自检"}
                </button>
                <button
                    type="button"
                    onClick={() => { refreshDump(); }}
                    className="ui-btn rounded-[20px]"
                >
                    <RefreshCw size={15} />
                    刷新探针
                </button>
                {rows.length > 0 && (
                    <button type="button" onClick={copyReport} className="ui-btn rounded-[20px]">
                        {copied ? <Check size={15} /> : <Copy size={15} />}
                        {copied ? "已复制" : "复制结果"}
                    </button>
                )}
            </div>

            {rows.length > 0 && (
                <div className="flex flex-col gap-1.5">
                    {rows.map(row => (
                        <div key={row.label} className="flex items-start gap-2">
                            <span className="mt-[2px] shrink-0">{statusIcon(row.ok)}</span>
                            <span className="menu-desc m-0 min-w-0 break-words">
                                <strong className="text-[var(--c-text-title)]">{row.label}：</strong>
                                {row.detail}
                            </span>
                        </div>
                    ))}
                </div>
            )}

            {hasProbeApi === false && (
                <p className="menu-desc m-0">
                    壳内探针不可用：当前壳版本早于 1.0.15。装上 1.0.15 后这里会显示
                    「onPermissionRequest 有没有被调用」等原始记录。
                </p>
            )}

            {dump && (dump.events?.length ?? 0) > 0 && (
                <div className="flex flex-col gap-1">
                    <span className="menu-desc m-0 font-semibold text-[var(--c-text-title)]">
                        壳内探针（{dump.version} · WebView {dump.webViewPackage || "?"}）
                    </span>
                    <pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-black/5 p-2 text-[11px] leading-relaxed">
                        {(dump.events ?? []).join("\n")}
                    </pre>
                </div>
            )}
        </div>
    );
}
