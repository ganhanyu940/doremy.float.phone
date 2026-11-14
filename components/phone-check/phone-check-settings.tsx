"use client";

// 查手机设置面板：授权、学习名单、时间线预览。
//
// 设计要点：
//  · 这是**最详细**的一项数据共享（能给出逐段时间线），所以默认关，
//    必须用户亲自打开。打开时会明确告诉他角色能看到什么。
//  · 学习名单必须能勾，不能靠手打——靠手打用户根本配不对，然后整份统计
//    全是误判。真实应用列表从原生读，float 内部应用从桌面里读。
//  · 分类规则「不在名单里的都算玩」是刻意的：他的目标是自控，
//    宁可误判成玩，也不要被一份宽松的统计哄着。
//  · 面板要能当场看到时间线长什么样——看不见的话，用户不知道自己在授权什么。
//
// 挂载方式与 DeviceActionSettings 一致：直接渲染内容，不套 PageShell。

import { useCallback, useEffect, useMemo, useState } from "react";

import { Toggle } from "@/components/ui/form";
import {
  classifyTimeline,
  describeTimelineForUser,
  loadPhoneCheckConfig,
  savePhoneCheckConfig,
  summarizeTimeline,
  type ClassifiedSegment,
  type PhoneCheckConfig,
} from "@/lib/phone-check";
import { loadAppUsageTimeline, supportsUsageTimeline } from "@/lib/perception/bridge";
import { listLaunchableApps, type LaunchableApp } from "@/lib/phone-lock";
// openSystemSettings 属于设备动作桥（which="usage_stats" 就是使用情况访问页），
// 不在 phone-lock 里——别从那边 import，那边没有这个方法。
import { openSystemSettings } from "@/lib/device-action";
import { isShellEnvironment as isShell } from "@/lib/shell-call-overlay";
import { loadInstalledCustomApps } from "@/lib/custom-app-storage";

/** float 内部可能算学习的应用候选（从已装应用里挑，避免写死）。 */
type InnerCandidate = { name: string };

export function PhoneCheckSettings({ onNotice }: { onNotice?: (msg: string) => void }) {
  const [config, setConfig] = useState<PhoneCheckConfig>(() => loadPhoneCheckConfig());
  const [apps, setApps] = useState<LaunchableApp[]>([]);
  const [innerCandidates, setInnerCandidates] = useState<InnerCandidate[]>([]);
  const [segments, setSegments] = useState<ClassifiedSegment[]>([]);
  const [query, setQuery] = useState("");

  const refresh = useCallback(() => {
    const next = loadPhoneCheckConfig();
    setConfig(next);
    // 时间线每次现读：系统那边在持续变化，缓存一份只会让用户看到过期结论
    setSegments(classifyTimeline(next));
  }, []);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener("phone-check-config-changed", onChange);
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    try { setApps(listLaunchableApps()); } catch { setApps([]); }
    try {
      // float 内部应用候选：自定义 APP + 几个内置学习向应用的固定名。
      // 内置应用没有统一的「可取名字列表」接口，这里用已装自定义应用
      // 加上几个已知内置名兜底——用户真正需要的往往就是那几个。
      // float 内部的「应用」有两类：用户装的自定义 APP，以及内置应用。
      // 内置应用没有统一的取名接口，所以下面用几个已知的学习向内建名兜底——
      // 用户真正要配的往往就是这几个。
      const installed = loadInstalledCustomApps().map(app => ({ name: app.name }));
      const builtin: InnerCandidate[] = [
        { name: "考点工坊" }, { name: "刷题本" }, { name: "词声" },
        { name: "木光自习室" }, { name: "记忆面包坊" }, { name: "角色陪伴专注" },
      ];
      const merged = [...installed, ...builtin];
      const seen = new Set<string>();
      setInnerCandidates(merged.filter(item => {
        if (seen.has(item.name)) return false;
        seen.add(item.name);
        return true;
      }));
    } catch {
      setInnerCandidates([]);
    }
    return () => {
      window.removeEventListener("phone-check-config-changed", onChange);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const inShell = useMemo(() => isShell(), []);
  const timelineSupported = useMemo(() => supportsUsageTimeline(), []);
  const hasData = segments.length > 0;
  const summary = useMemo(() => summarizeTimeline(segments), [segments]);

  const update = useCallback((patch: Partial<PhoneCheckConfig>) => {
    const next = { ...loadPhoneCheckConfig(), ...patch };
    savePhoneCheckConfig(next);
    setConfig(next);
    setSegments(classifyTimeline(next));
  }, []);

  const toggleStudyPackage = (pkg: string) => {
    const list = config.studyPackages.includes(pkg)
      ? config.studyPackages.filter(item => item !== pkg)
      : [...config.studyPackages, pkg];
    update({ studyPackages: list });
  };

  const toggleInnerApp = (name: string) => {
    const list = config.studyInnerApps.includes(name)
      ? config.studyInnerApps.filter(item => item !== name)
      : [...config.studyInnerApps, name];
    update({ studyInnerApps: list });
  };

  const filteredApps = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return apps.slice(0, 60);
    return apps
      .filter(app => app.label.toLowerCase().includes(q) || app.package.toLowerCase().includes(q))
      .slice(0, 60);
  }, [apps, query]);

  const clock = (ms: number) => {
    const date = new Date(ms);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  };

  return (
    <div className="per-shell">
      <div className="per-hero">
        <div className="per-hero-head">
          <span className="per-hero-title">让它看清你在干嘛</span>
          <span className="per-state" data-tone={config.allowCharacterRead && hasData ? "on" : ""}>
            <i className="per-dot is-pulse" />
            {config.allowCharacterRead ? (hasData ? "已启用" : "已授权·无数据") : "未启用"}
          </span>
        </div>

        {!inShell && (
          <div className="per-note is-warn">
            当前不在小手机 App 内（浏览器/PWA）。时间线来自安卓系统，这里只能预览界面。
          </div>
        )}
        {inShell && !timelineSupported && (
          <div className="per-note is-warn">
            当前 App 版本还不支持读时间线，需要安卓壳 <b>1.0.36</b> 及以上。
          </div>
        )}
        {inShell && timelineSupported && !hasData && (
          <div className="per-note is-warn">
            现在读不到数据。需要授予「使用情况访问」——这是系统特殊权限，只能去设置里手动开。
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                className="ui-btn ui-btn-outline"
                onClick={() => {
                  const ok = openSystemSettings("usage_stats");
                  onNotice?.(ok
                    ? "请在列表里找到「float」并允许「使用情况访问」"
                    : "没能打开系统设置，请手动到「设置 → 应用 → 特殊应用权限 → 使用情况访问」里授权");
                }}
              >
                去授权
              </button>
            </div>
          </div>
        )}

        <div className="per-note is-warn">
          <div style={{ fontWeight: 600 }}>打开后角色会看到什么</div>
          <div style={{ marginTop: 6, lineHeight: 1.65 }}>
            你今天<b>几点在用什么应用、切到哪去了、待了多久</b>，以及在小手机里打开的是哪个应用。
            它能据此判断你到底在学习，还是嘴上说学、手上在玩。
            <br />
            它<b>看不到</b>屏幕内容、聊天对象、你打的字。这些数据只存在这台手机上，不会上传。
          </div>
        </div>
      </div>

      <div className="page-menu" style={{ paddingBottom: 40, gap: 16 }}>
        {/* 授权 */}
        <div>
          <div className="settings-menu-section-title">授权</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">允许角色查看我的时间线</span>
                <span className="menu-desc">
                  默认关闭。打开后角色才能在对话里查你今天的时间线。
                  关掉它，它立刻查不到——不需要重装或重启。
                </span>
              </div>
              <Toggle
                checked={config.allowCharacterRead}
                onChange={(v: boolean) => {
                  update({ allowCharacterRead: v });
                  onNotice?.(v
                    ? "已授权。它现在能看清你今天在用什么了"
                    : "已关闭，角色再也查不到你的时间线");
                }}
              />
            </div>
          </div>
          <div className="per-note" style={{ padding: "0 var(--ui-padding, 16px)" }}>
            还要单独开能力：工具箱 → 内置能力 → 「查看手机时间线」。两处都开，角色才查得到。
          </div>
        </div>

        {/* 今日概览 */}
        <div>
          <div className="settings-menu-section-title">今天的实况</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">{describeTimelineForUser(summary)}</span>
                <span className="menu-desc">
                  {hasData
                    ? "这就是角色会看到的结论。逐段明细在下面。"
                    : "还没有数据，先看看上面的授权提示。"}
                </span>
              </div>
            </div>
          </div>
          {hasData && (
            <div className="menu-group" style={{ marginTop: 10, maxHeight: 280, overflowY: "auto" }}>
              {segments.slice(-40).reverse().map((segment, index) => {
                const isStudy = segment.kind === "study" || segment.kind === "float";
                const tag = isStudy ? "学习" : segment.kind === "play" ? "玩" : "其它";
                const name = segment.innerApp ? `${segment.label} / ${segment.innerApp}` : segment.label;
                return (
                  <div className="menu-item" style={{ cursor: "default" }} key={`${segment.startAt}_${index}`}>
                    <div className="menu-label-group">
                      <span className="menu-label" style={{ fontSize: 13 }}>
                        {clock(segment.startAt)}–{clock(segment.endAt)}　{name}
                      </span>
                      <span
                        className="menu-desc"
                        style={{ color: isStudy ? "var(--c-success, #2b8a5f)" : segment.kind === "play" ? "var(--c-danger, #b4452f)" : undefined }}
                      >
                        {tag} · {Math.max(1, Math.round(segment.seconds / 60))} 分钟
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 学习名单：真实应用 */}
        <div>
          <div className="settings-menu-section-title">哪些真实应用算学习</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default", flexDirection: "column", alignItems: "stretch", gap: 10 }}>
              <input
                className="ui-input"
                placeholder="搜索应用名或包名"
                value={query}
                onChange={event => setQuery(event.target.value)}
              />
              <div className="per-note" style={{ padding: 0 }}>
                已选 {config.studyPackages.length} 个。<b>不在名单里的一律算「玩」</b>——
                宁可误判成玩，也不要一份宽松的统计哄着你。
              </div>
            </div>
            {!apps.length && (
              <div className="menu-item" style={{ cursor: "default" }}>
                <div className="menu-label-group">
                  <span className="menu-desc">读不到应用列表（需要在小手机 App 内）</span>
                </div>
              </div>
            )}
            {filteredApps.map(app => {
              const on = config.studyPackages.includes(app.package);
              return (
                <div
                  className="menu-item"
                  style={{ cursor: "pointer" }}
                  key={app.package}
                  onClick={() => toggleStudyPackage(app.package)}
                >
                  <div className="menu-label-group">
                    <span className="menu-label">{app.label}</span>
                    <span className="menu-desc">{app.package}</span>
                  </div>
                  <Toggle checked={on} onChange={() => toggleStudyPackage(app.package)} />
                </div>
              );
            })}
          </div>
        </div>

        {/* 学习名单：float 内部 */}
        <div>
          <div className="settings-menu-section-title">小手机里哪些应用算学习</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-desc">
                  系统只看得到「float 在前台」，看不到你在里面打开了哪个应用。
                  这里勾出来的才算学习，其余（游戏、剧场、购物…）算玩。
                </span>
              </div>
            </div>
            {innerCandidates.map(item => {
              const on = config.studyInnerApps.includes(item.name);
              return (
                <div
                  className="menu-item"
                  style={{ cursor: "pointer" }}
                  key={item.name}
                  onClick={() => toggleInnerApp(item.name)}
                >
                  <div className="menu-label-group">
                    <span className="menu-label">{item.name}</span>
                  </div>
                  <Toggle checked={on} onChange={() => toggleInnerApp(item.name)} />
                </div>
              );
            })}
          </div>
        </div>

        <div className="per-actions">
          <button type="button" className="ui-btn ui-btn-outline" onClick={refresh}>
            重新读取
          </button>
        </div>
      </div>
    </div>
  );
}
