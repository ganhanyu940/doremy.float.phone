"use client";

// 角色锁机设置面板：授权、时长上限、拉回哪个应用、现场实测。
//
// 设计要点：
//  · 这是**唯一一个会让用户用不了手机**的能力，所以默认关，且必须用户亲自打开。
//    打开这件事本身就是「我同意被它管」的表达，不能由别处顺带完成。
//  · 卡在哪一环必须一眼可见：用户开了这里但没开无障碍，锁机依然完全不生效。
//    三态（已授权 / 壳支持 / 无障碍就绪）分开显示，别让用户猜。
//  · 白名单不在这里配——它在「锁机台」APP 里配，那边能从真实应用列表里勾。
//    这里只说明「用哪份白名单」，不重复造一份，避免两处不一致。
//
// 挂载方式与 DeviceActionSettings 一致：直接渲染内容，不套 PageShell。

import { useCallback, useEffect, useMemo, useState } from "react";

import { Toggle } from "@/components/ui/form";
import {
  checkCharacterLockAvailability,
  describePhoneLockStatus,
  humanizeLockMinutes,
  loadPhoneLockConfig,
  PHONE_LOCK_MAX_MINUTES,
  savePhoneLockConfig,
  type PhoneLockConfig,
} from "@/lib/device-lock";
import {
  listLaunchableApps,
  openAccessibilitySettings,
  type LaunchableApp,
} from "@/lib/phone-lock";
import { isShellEnvironment as isShell } from "@/lib/shell-call-overlay";

export function DeviceLockSettings({ onNotice }: { onNotice?: (msg: string) => void }) {
  const [config, setConfig] = useState<PhoneLockConfig>(() => loadPhoneLockConfig());
  const [apps, setApps] = useState<LaunchableApp[]>([]);
  const [statusText, setStatusText] = useState("");
  const [availability, setAvailability] = useState(() => checkCharacterLockAvailability());

  const refresh = useCallback(() => {
    setConfig(loadPhoneLockConfig());
    setAvailability(checkCharacterLockAvailability());
    setStatusText(describePhoneLockStatus());
  }, []);

  // 无障碍状态是「去系统设置改、回来才变」的，所以切回前台刷一次。
  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener("phone-lock-config-changed", onChange);
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    // 应用列表只在真正需要时才读（要查 PackageManager，比较重）
    try { setApps(listLaunchableApps()); } catch { setApps([]); }
    return () => {
      window.removeEventListener("phone-lock-config-changed", onChange);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const inShell = useMemo(() => isShell(), []);

  const update = useCallback((patch: Partial<PhoneLockConfig>) => {
    const next = { ...loadPhoneLockConfig(), ...patch };
    savePhoneLockConfig(next);
    setConfig(next);
    setAvailability(checkCharacterLockAvailability());
  }, []);

  const pullBackLabel = useMemo(() => {
    if (!config.pullBackPackage) return "";
    return apps.find(app => app.package === config.pullBackPackage)?.label || config.pullBackPackage;
  }, [config.pullBackPackage, apps]);

  return (
    <div className="per-shell">
      <div className="per-hero">
        <div className="per-hero-head">
          <span className="per-hero-title">让它能拦住你</span>
          <span className="per-state" data-tone={availability.available ? "on" : ""}>
            <i className="per-dot is-pulse" />
            {availability.available ? "可用" : "未启用"}
          </span>
        </div>

        {!inShell && (
          <div className="per-note is-warn">
            当前不在小手机 App 内（浏览器/PWA）。锁机需要安卓壳和无障碍服务，这里只能预览界面。
          </div>
        )}
        {inShell && !availability.bridgeAvailable && (
          <div className="per-note is-warn">
            当前 App 版本还没有锁机桥，请更新到 1.0.33 及以上版本。
          </div>
        )}
        {inShell && availability.bridgeAvailable && !availability.accessibilityReady && (
          <div className="per-note is-warn">
            无障碍服务没开启，锁机<b>完全不会生效</b>。先去把它打开，否则下面开了也没用。
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                className="ui-btn ui-btn-outline"
                onClick={() => {
                  const ok = openAccessibilitySettings();
                  onNotice?.(ok
                    ? "请在无障碍列表里找到「通话浮窗与界面陪伴」并打开"
                    : "没能跳到无障碍设置，请手动到「设置 → 无障碍 → 已下载的服务」里找");
                }}
              >
                去开启无障碍
              </button>
            </div>
          </div>
        )}

        <div className="per-note is-warn">
          <div style={{ fontWeight: 600 }}>默认关闭，需要你亲自打开</div>
          <div style={{ marginTop: 6, lineHeight: 1.65 }}>
            打开后，角色可以在对话里把你的手机锁上一段时间——不是聊天里的比喻，
            是真的锁。锁住期间只有<b>白名单应用</b>能用，桌面、电话、系统设置永远可用。
            它也能提前解锁，但每次都要说明理由，你会收到通知。
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
                <span className="menu-label">允许角色锁机</span>
                <span className="menu-desc">
                  默认关闭。打开后角色才能在对话里调用锁机；关掉它就再也锁不了你。
                  这不会影响你自己在「锁机台」里手动锁机。
                </span>
              </div>
              <Toggle checked={config.allowCharacterLock} onChange={(v: boolean) => {
                update({ allowCharacterLock: v });
                if (v) {
                  onNotice?.(availability.accessibilityReady
                    ? "已授权。它现在能锁你了——记得先在「锁机台」里挑好白名单"
                    : "已授权，但无障碍服务还没开，现在锁机不会生效");
                }
              }} />
            </div>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">锁机时通知我</span>
                <span className="menu-desc">
                  角色锁上或提前解锁时发一条通知，写明是谁、多久、为什么。默认开启。
                </span>
              </div>
              <Toggle
                checked={config.notifyOnAction !== false}
                onChange={(v: boolean) => update({ notifyOnAction: v })}
              />
            </div>
          </div>
          <div className="per-note" style={{ padding: "0 var(--ui-padding, 16px)" }}>
            还要单独开能力：工具箱 → 内置能力 → 「锁住手机」。两处都开，角色才调得到。
          </div>
        </div>

        {/* 时长 */}
        <div>
          <div className="settings-menu-section-title">单次最长多久</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">
                  上限 {humanizeLockMinutes(config.maxMinutes)}
                </span>
                <span className="menu-desc">
                  角色要求更久也只会按这个上限执行，结果里会告诉它实际锁了多久。
                  最长不超过 {humanizeLockMinutes(PHONE_LOCK_MAX_MINUTES)}。
                </span>
              </div>
            </div>
            <div className="menu-item" style={{ cursor: "default", flexDirection: "column", alignItems: "stretch", gap: 10 }}>
              <input
                type="range"
                min={10}
                max={PHONE_LOCK_MAX_MINUTES}
                step={10}
                value={config.maxMinutes}
                onChange={(event) => update({ maxMinutes: Number(event.target.value) })}
                style={{ width: "100%" }}
              />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {[30, 60, 120, 240, PHONE_LOCK_MAX_MINUTES].map(minutes => (
                  <button
                    key={minutes}
                    type="button"
                    className="ui-btn ui-btn-outline"
                    style={{
                      opacity: config.maxMinutes === minutes ? 1 : 0.65,
                      fontWeight: config.maxMinutes === minutes ? 700 : 400,
                    }}
                    onClick={() => update({ maxMinutes: minutes })}
                  >
                    {humanizeLockMinutes(minutes)}
                  </button>
                ))}
              </div>
              <div className="per-note" style={{ padding: 0 }}>
                考研冲刺的话，45 分钟一轮比较合适——太长反而容易在锁机时烦躁。
              </div>
            </div>
          </div>
        </div>

        {/* 拉回学习应用 */}
        <div>
          <div className="settings-menu-section-title">锁上之后拉我回来</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">
                  {config.pullBackPackage ? `已选：${pullBackLabel}` : "未选择：只锁，不自动打开应用"}
                </span>
                <span className="menu-desc">
                  锁上的同时把屏幕切到这个应用。适合设成你的背单词应用——锁完之后你总得有事可做。
                </span>
              </div>
            </div>
            <div className="menu-item" style={{ cursor: "default", flexDirection: "column", alignItems: "stretch", gap: 10 }}>
              <select
                value={config.pullBackPackage}
                onChange={(event) => update({ pullBackPackage: event.target.value })}
                style={{ width: "100%", minHeight: 40, borderRadius: 10, padding: "8px 10px" }}
              >
                <option value="">不自动打开</option>
                {apps.map(app => (
                  <option key={app.package} value={app.package}>{app.label}</option>
                ))}
              </select>
              {!apps.length && (
                <div className="per-note" style={{ padding: 0 }}>
                  读不到应用列表——需要在小手机 App 内、且安卓壳为 1.0.33 及以上。
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 白名单说明 + 实测 */}
        <div>
          <div className="settings-menu-section-title">白名单与实测</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">白名单在哪配</span>
                <span className="menu-desc">
                  桌面上的「锁机台」APP。那里能从你真实的应用列表里勾选，
                  角色锁机时会沿用同一份名单——不需要在这里再配一遍。
                </span>
              </div>
            </div>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">当前锁机状态</span>
                <span className="menu-desc">{statusText}</span>
              </div>
            </div>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">三处就绪情况</span>
                <span className="menu-desc">
                  授权：{availability.configEnabled ? "已开" : "未开"} ·
                  {" "}壳支持：{availability.bridgeAvailable ? "是" : "否"} ·
                  {" "}无障碍：{availability.accessibilityReady ? "已开" : "未开"}
                </span>
              </div>
            </div>
          </div>
          <div className="per-actions">
            <button type="button" className="ui-btn ui-btn-outline" onClick={refresh}>
              重新检测
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
