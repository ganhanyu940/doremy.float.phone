"use client";

// 健康系统面板：把所有「什么时候管你」的规则列在一处。
//
// 为什么要集中而不是各功能一个入口：
//   用户的目标是「健康生活 + 积极备考」，他需要一眼看清"这台手机到底会在
//   什么时候管我"。分散在四五个子页里，他既记不住，也不知道哪个开关是总闸。
//
// 面板分三块：
//   ① 说了就管我（意图锁）：你说要去做一件事，过几分钟还在用手机就锁
//   ② 起床叫醒：到点响铃 + 振动 + 念一句角色的话
//   ③ 各规则的放行清单与参数
//
// 一条贯穿全篇的原则：**任何"看起来开着、其实没生效"的状态都必须显式说出来**。
// 睡眠与自律类功能最怕这个——用户第二天只会觉得"这破东西没用"。

import { useCallback, useEffect, useMemo, useState } from "react";

import { Toggle } from "@/components/ui/form";
import {
  cancelIntent,
  createIntent,
  loadIntentLockConfig,
  loadIntentRecords,
  markIntentDone,
  saveIntentLockConfig,
  syncIntentsToNative,
  supportsIntentLock,
  countTodayLocks,
  type IntentLockConfig,
  type IntentRecord,
} from "@/lib/intent-lock";
import {
  cancelWakeupNative,
  checkWakeupReadiness,
  isWakeupRinging,
  loadWakeupConfig,
  loadWakeupPlans,
  nextWakeupPlan,
  saveWakeupConfig,
  scheduleWakeup,
  stopWakeupRingingNative,
  supportsWakeup,
  syncWakeupPlansToNative,
  type WakeupConfig,
  type WakeupPlan,
} from "@/lib/wakeup";
import { isShellEnvironment as isShell } from "@/lib/shell-call-overlay";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtWhen(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const clock = fmtClock(ms);
  if (d.toDateString() === now.toDateString()) return `今天 ${clock}`;
  if (d.toDateString() === tomorrow.toDateString()) return `明天 ${clock}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${clock}`;
}

const STATUS_LABEL: Record<IntentRecord["status"], string> = {
  pending: "在盯着",
  locked: "已锁上",
  done: "做完了",
  cancelled: "已取消",
  expired: "过期作废",
  skipped: "没锁",
  failed: "没锁成",
};

export function DisciplineSettings({ onNotice }: { onNotice?: (msg: string) => void }) {
  const [tab, setTab] = useState<"intent" | "wakeup">("intent");
  const [intentConfig, setIntentConfig] = useState<IntentLockConfig>(() => loadIntentLockConfig());
  const [wakeConfig, setWakeConfig] = useState<WakeupConfig>(() => loadWakeupConfig());
  const [records, setRecords] = useState<IntentRecord[]>(() => loadIntentRecords());
  const [plans, setPlans] = useState<WakeupPlan[]>(() => loadWakeupPlans());
  const [tick, setTick] = useState(0);

  // 手动加一条意图用的输入
  const [newTitle, setNewTitle] = useState("");
  const [newMinutes, setNewMinutes] = useState(20);

  // 手动定一次叫醒用的输入
  const [wakeHour, setWakeHour] = useState(6);
  const [wakeMinute, setWakeMinute] = useState(30);
  const [wakeSpeech, setWakeSpeech] = useState("起来了，今天要背的那一章还等着你");
  const [preparing, setPreparing] = useState(false);

  const inShell = useMemo(() => isShell(), []);
  const intentSupported = useMemo(() => supportsIntentLock(), []);
  const wakeSupported = useMemo(() => supportsWakeup(), []);

  const refresh = useCallback(() => {
    setIntentConfig(loadIntentLockConfig());
    setWakeConfig(loadWakeupConfig());
    setRecords(loadIntentRecords());
    setPlans(loadWakeupPlans());
  }, []);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener("intent-lock-config-changed", onChange);
    window.addEventListener("intent-lock-records-changed", onChange);
    window.addEventListener("wakeup-config-changed", onChange);
    window.addEventListener("wakeup-plans-changed", onChange);
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    // 「几分钟后检查」这个数字要随时间变，不然会像卡住了
    const timer = window.setInterval(() => setTick(v => v + 1), 30_000);
    return () => {
      window.removeEventListener("intent-lock-config-changed", onChange);
      window.removeEventListener("intent-lock-records-changed", onChange);
      window.removeEventListener("wakeup-config-changed", onChange);
      window.removeEventListener("wakeup-plans-changed", onChange);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const updateIntentConfig = useCallback((patch: Partial<IntentLockConfig>) => {
    const next = { ...loadIntentLockConfig(), ...patch };
    saveIntentLockConfig(next);
    setIntentConfig(next);
    // 关掉时要顺带清掉原生已排的闹钟：不清的话关了开关照样会锁。
    syncIntentsToNative();
  }, []);

  const updateWakeConfig = useCallback((patch: Partial<WakeupConfig>) => {
    const next = { ...loadWakeupConfig(), ...patch };
    saveWakeupConfig(next);
    setWakeConfig(next);
    syncWakeupPlansToNative();
  }, []);

  const openIntents = records.filter(item => item.status === "pending" || item.status === "locked");
  const history = records.filter(item => !["pending", "locked"].includes(item.status)).slice(0, 8);
  const readiness = checkWakeupReadiness();
  const nextPlan = nextWakeupPlan();
  const ringing = isWakeupRinging();
  void tick; // 仅用于每 30 秒触发一次重算

  const handleAddIntent = () => {
    const result = createIntent({
      title: newTitle,
      minutes: newMinutes,
      createdBy: "user",
    });
    if (!result.ok) {
      onNotice?.(result.reason);
      return;
    }
    // **新建后必须同步给原生**：不同步就根本不会响，这是最容易漏的一步。
    syncIntentsToNative();
    refresh();
    setNewTitle("");
    onNotice?.(`记下了：「${result.record.title}」${intentConfig.graceMinutes} 分钟后看你还动不动`);
  };

  const handleScheduleWakeup = async () => {
    setPreparing(true);
    try {
      const now = new Date();
      const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), wakeHour, wakeMinute, 0, 0);
      // 已经过了今天的这个点，就算明天
      if (target.getTime() <= now.getTime() + 60_000) target.setDate(target.getDate() + 1);
      const result = await scheduleWakeup({
        at: target.getTime(),
        speech: wakeSpeech,
        createdBy: "user",
      });
      onNotice?.(result.ok ? result.message : result.reason);
      refresh();
    } finally {
      setPreparing(false);
    }
  };

  return (
    <div className="per-shell">
      <div className="per-hero">
        <div className="per-hero-head">
          <span className="per-hero-title">什么时候该管你</span>
          <span className="per-state" data-tone={intentConfig.enabled || wakeConfig.enabled ? "on" : ""}>
            <i className="per-dot is-pulse" />
            {intentConfig.enabled || wakeConfig.enabled ? "已启用" : "未启用"}
          </span>
        </div>

        {!inShell && (
          <div className="per-note is-warn">
            当前不在小手机 App 内（浏览器/PWA）。这两项都依赖手机的精确闹钟，
            在这里只能看界面，改了不会真正生效。
          </div>
        )}
        {inShell && (!intentSupported || !wakeSupported) && (
          <div className="per-note is-warn">
            当前 App 版本不支持这两个功能，需要安卓壳 <b>1.0.38</b> 及以上。
            网页定时器在切到后台后会被系统冻结，所以定时必须靠原生闹钟。
          </div>
        )}

        <div className="per-note is-warn">
          <div style={{ fontWeight: 600 }}>它凭什么判断你在不在做</div>
          <div style={{ marginTop: 6, lineHeight: 1.65 }}>
            靠<b>应用使用记录</b>：说完要去做事之后，如果手机还在被用，就算你没去做。
            <br />
            它<b>读不到</b>屏幕内容、看不到你在浴室还是在床上——只知道手机动没动。
            <br />
            所以手机放客厅、你在刷平板，它不会锁（这是已知盲区，不是 bug）。
          </div>
        </div>
      </div>

      <div className="page-menu" style={{ paddingBottom: 40, gap: 16 }}>
        {/* 两个分页 */}
        <div style={{ display: "flex", gap: 8 }}>
          {([
            ["intent", "说了就管我"],
            ["wakeup", "起床叫醒"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className="ui-btn ui-btn-outline"
              style={{
                flex: 1,
                opacity: tab === key ? 1 : 0.55,
                borderColor: tab === key ? "var(--c-accent, #7a5af8)" : undefined,
              }}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "intent" && (
          <>
            <div>
              <div className="settings-menu-section-title">说了就管我</div>
              <div className="menu-group" style={{ marginTop: 10 }}>
                <div className="menu-item" style={{ cursor: "default" }}>
                  <div className="menu-label-group">
                    <span className="menu-label">总开关</span>
                    <span className="menu-desc">
                      开了之后，你跟角色说「我去洗澡」「我要学习」，它会记下来，
                      过几分钟看你手机还动不动；还在动就锁上。
                    </span>
                  </div>
                  <Toggle
                    checked={intentConfig.enabled}
                    onChange={(v: boolean) => {
                      updateIntentConfig({ enabled: v });
                      onNotice?.(v ? "已开启，说一句它就记着" : "已关闭，不会再因为这个锁你");
                    }}
                  />
                </div>

                <div className="menu-item" style={{ cursor: "default", flexDirection: "column", alignItems: "stretch", gap: 8 }}>
                  <span className="menu-label" style={{ fontSize: 13 }}>
                    说完之后等 {intentConfig.graceMinutes} 分钟再检查
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={30}
                    step={1}
                    value={intentConfig.graceMinutes}
                    onChange={e => updateIntentConfig({ graceMinutes: Number(e.target.value) })}
                    style={{ width: "100%" }}
                  />
                  <div className="per-note" style={{ padding: 0 }}>
                    给你走两步、放个水的时间。设 0 会立刻判你「还在玩」。
                  </div>
                </div>

                <div className="menu-item" style={{ cursor: "default", flexDirection: "column", alignItems: "stretch", gap: 8 }}>
                  <span className="menu-label" style={{ fontSize: 13 }}>
                    没说时长时，默认锁 {intentConfig.defaultMinutes} 分钟
                  </span>
                  <input
                    type="range"
                    min={5}
                    max={60}
                    step={5}
                    value={intentConfig.defaultMinutes}
                    onChange={e => updateIntentConfig({ defaultMinutes: Number(e.target.value) })}
                    style={{ width: "100%" }}
                  />
                  <div className="per-note" style={{ padding: 0 }}>
                    你明确说了「我要洗 40 分钟」就按 40 分钟；没说才用这个值。
                    宁可短一点——长了就是折磨。
                  </div>
                </div>

                <div className="menu-item" style={{ cursor: "default", flexDirection: "column", alignItems: "stretch", gap: 8 }}>
                  <span className="menu-label" style={{ fontSize: 13 }}>
                    说了之后 {Math.round(intentConfig.expireMinutes / 60)} 小时内有效
                  </span>
                  <input
                    type="range"
                    min={30}
                    max={360}
                    step={30}
                    value={intentConfig.expireMinutes}
                    onChange={e => updateIntentConfig({ expireMinutes: Number(e.target.value) })}
                    style={{ width: "100%" }}
                  />
                  <div className="per-note" style={{ padding: 0 }}>
                    超过这个时间还没触发就作废，不攒着秋后算账——
                    那是让人莫名其妙被锁的主要原因。
                  </div>
                </div>
              </div>
            </div>

            {/* 手动加一条 */}
            <div>
              <div className="settings-menu-section-title">现在就说一句</div>
              <div className="menu-group" style={{ marginTop: 10 }}>
                <div className="menu-item" style={{ cursor: "default", flexDirection: "column", alignItems: "stretch", gap: 10 }}>
                  <input
                    className="ui-input"
                    placeholder="你要去做什么？例：洗澡 / 学习 / 吃饭"
                    value={newTitle}
                    onChange={e => setNewTitle(e.target.value)}
                  />
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      className="ui-input"
                      type="number"
                      min={1}
                      max={120}
                      value={newMinutes}
                      onChange={e => setNewMinutes(Number(e.target.value))}
                      style={{ flex: 1 }}
                    />
                    <span className="menu-desc">分钟</span>
                    <button
                      type="button"
                      className="ui-btn ui-btn-outline"
                      style={{ flex: 1 }}
                      onClick={handleAddIntent}
                    >
                      记下来
                    </button>
                  </div>
                  <div className="per-note" style={{ padding: 0 }}>
                    也可以直接在对话里跟角色说，它会替你记。
                  </div>
                </div>
              </div>
            </div>

            {/* 正在盯的 */}
            {openIntents.length > 0 && (
              <div>
                <div className="settings-menu-section-title">正在盯的</div>
                <div className="menu-group" style={{ marginTop: 10 }}>
                  {openIntents.map(item => {
                    const minutesLeft = Math.max(0, Math.round((item.checkAt - Date.now()) / 60_000));
                    return (
                      <div className="menu-item" key={item.id} style={{ cursor: "default" }}>
                        <div className="menu-label-group">
                          <span className="menu-label">{item.title}</span>
                          <span className="menu-desc">
                            {item.status === "locked"
                              ? `已锁上${item.lockUntil ? `，到 ${fmtClock(item.lockUntil)}` : ""}`
                              : minutesLeft > 0
                                ? `${minutesLeft} 分钟后看你还动不动`
                                : "马上检查"}
                            {item.createdBy === "character" ? " · 角色记的" : ""}
                          </span>
                        </div>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            style={{ fontSize: 12, padding: "6px 10px" }}
                            onClick={() => {
                              const r = markIntentDone(item.id);
                              syncIntentsToNative();
                              refresh();
                              onNotice?.(r.message);
                            }}
                          >
                            我做完了
                          </button>
                          <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            style={{ fontSize: 12, padding: "6px 10px" }}
                            onClick={() => {
                              const r = cancelIntent(item.id);
                              syncIntentsToNative();
                              refresh();
                              onNotice?.(r.message);
                            }}
                          >
                            计划有变
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 历史 */}
            {history.length > 0 && (
              <div>
                <div className="settings-menu-section-title">最近的记录</div>
                <div className="menu-group" style={{ marginTop: 10 }}>
                  {history.map(item => (
                    <div className="menu-item" key={item.id} style={{ cursor: "default" }}>
                      <div className="menu-label-group">
                        <span className="menu-label">{item.title}</span>
                        <span className="menu-desc">
                          {STATUS_LABEL[item.status]}
                          {item.note ? ` · ${item.note}` : ""}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="per-note" style={{ padding: "0 var(--ui-padding, 16px)" }}>
                  今天锁了 {countTodayLocks()} 次。不设上限——你要的就是它管你。
                </div>
              </div>
            )}
          </>
        )}

        {tab === "wakeup" && (
          <>
            <div>
              <div className="settings-menu-section-title">起床叫醒</div>
              <div className="menu-group" style={{ marginTop: 10 }}>
                <div className="menu-item" style={{ cursor: "default" }}>
                  <div className="menu-label-group">
                    <span className="menu-label">总开关</span>
                    <span className="menu-desc">
                      到点响铃、振动、念一句角色的话。也可以在对话里让角色「明早叫我」，
                      它定的时间就排在这里。
                    </span>
                  </div>
                  <Toggle
                    checked={wakeConfig.enabled}
                    onChange={(v: boolean) => {
                      updateWakeConfig({ enabled: v });
                      onNotice?.(v ? "已开启" : "已关闭，明早不会叫你");
                    }}
                  />
                </div>

                <div className="menu-item" style={{ cursor: "default", flexDirection: "column", alignItems: "stretch", gap: 8 }}>
                  <span className="menu-label" style={{ fontSize: 13 }}>
                    音量 {wakeConfig.volume}%（{wakeConfig.rampSeconds} 秒内渐强）
                  </span>
                  <input
                    type="range"
                    min={20}
                    max={100}
                    step={5}
                    value={wakeConfig.volume}
                    onChange={e => updateWakeConfig({ volume: Number(e.target.value) })}
                    style={{ width: "100%" }}
                  />
                  <div className="per-note" style={{ padding: 0 }}>
                    从三成音量开始逐渐升到目标值，避免一上来就吓醒。
                  </div>
                </div>

                <div className="menu-item" style={{ cursor: "default" }}>
                  <div className="menu-label-group">
                    <span className="menu-label">同时振动</span>
                    <span className="menu-desc">睡着了听不见的时候，振动往往更有效</span>
                  </div>
                  <Toggle
                    checked={wakeConfig.vibrate}
                    onChange={(v: boolean) => updateWakeConfig({ vibrate: v })}
                  />
                </div>

                <div className="menu-item" style={{ cursor: "default" }}>
                  <div className="menu-label-group">
                    <span className="menu-label">叠加系统闹铃音</span>
                    <span className="menu-desc">
                      开启后角色的话和闹铃声一起响。睡得很沉时更有把握叫醒。
                    </span>
                  </div>
                  <Toggle
                    checked={wakeConfig.playAlarmTone}
                    onChange={(v: boolean) => updateWakeConfig({ playAlarmTone: v })}
                  />
                </div>

                <div className="menu-item" style={{ cursor: "default", flexDirection: "column", alignItems: "stretch", gap: 8 }}>
                  <span className="menu-label" style={{ fontSize: 13 }}>
                    没反应时每 {wakeConfig.repeatEveryMinutes} 分钟再响，最多 {wakeConfig.maxRounds} 轮
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      type="range"
                      min={1}
                      max={10}
                      step={1}
                      value={wakeConfig.repeatEveryMinutes}
                      onChange={e => updateWakeConfig({ repeatEveryMinutes: Number(e.target.value) })}
                      style={{ flex: 1 }}
                    />
                    <input
                      type="range"
                      min={1}
                      max={5}
                      step={1}
                      value={wakeConfig.maxRounds}
                      onChange={e => updateWakeConfig({ maxRounds: Number(e.target.value) })}
                      style={{ flex: 1 }}
                    />
                  </div>
                  <div className="per-note" style={{ padding: 0 }}>
                    轮数用完就停。无限响不是叫醒，是事故——白天突然响一下会把人吓着。
                  </div>
                </div>
              </div>
            </div>

            {/* 定一次叫醒 */}
            <div>
              <div className="settings-menu-section-title">定一次</div>
              <div className="menu-group" style={{ marginTop: 10 }}>
                <div className="menu-item" style={{ cursor: "default", flexDirection: "column", alignItems: "stretch", gap: 8 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <select
                      className="ui-select"
                      value={wakeHour}
                      onChange={e => setWakeHour(Number(e.target.value))}
                      style={{ flex: 1 }}
                    >
                      {Array.from({ length: 24 }, (_, i) => (
                        <option key={i} value={i}>{pad(i)} 点</option>
                      ))}
                    </select>
                    <select
                      className="ui-select"
                      value={wakeMinute}
                      onChange={e => setWakeMinute(Number(e.target.value))}
                      style={{ flex: 1 }}
                    >
                      {[0, 10, 15, 20, 30, 40, 45, 50].map(m => (
                        <option key={m} value={m}>{pad(m)} 分</option>
                      ))}
                    </select>
                  </div>
                  <input
                    className="ui-input"
                    value={wakeSpeech}
                    onChange={e => setWakeSpeech(e.target.value)}
                    placeholder="起床时要念的那句话"
                    maxLength={120}
                  />
                  <button
                    type="button"
                    className="ui-btn ui-btn-outline"
                    disabled={preparing}
                    onClick={handleScheduleWakeup}
                  >
                    {preparing ? "正在合成角色的声音…" : "定下这次叫醒"}
                  </button>
                  <div className="per-note" style={{ padding: 0 }}>
                    这句话会<b>提前合成成音频</b>存到手机里——早上 App 在后台被冻结，
                    那一刻没法再调语音接口。合成失败会退回系统语音念同一句话。
                  </div>
                </div>
              </div>
            </div>

            {/* 准备状态：必须一眼看到 */}
            <div>
              <div className="settings-menu-section-title">下一次叫醒</div>
              <div className="menu-group" style={{ marginTop: 10 }}>
                <div className="menu-item" style={{ cursor: "default" }}>
                  <div className="menu-label-group">
                    <span className="menu-label">
                      {nextPlan ? fmtWhen(nextPlan.at) : "还没有安排"}
                    </span>
                    <span
                      className="menu-desc"
                      style={{ color: readiness.ready ? "var(--c-success, #2b8a5f)" : "var(--c-warn, #c9840f)" }}
                    >
                      {readiness.message}
                    </span>
                  </div>
                  {nextPlan && (
                    <button
                      type="button"
                      className="ui-btn ui-btn-outline"
                      style={{ fontSize: 12, padding: "6px 10px" }}
                      onClick={() => {
                        cancelWakeupNative(nextPlan.id);
                        onNotice?.("已取消这次叫醒");
                        refresh();
                      }}
                    >
                      取消
                    </button>
                  )}
                </div>

                {ringing && (
                  <div className="menu-item" style={{ cursor: "default" }}>
                    <div className="menu-label-group">
                      <span className="menu-label">正在响</span>
                      <span className="menu-desc">叫醒正在发声</span>
                    </div>
                    <button
                      type="button"
                      className="ui-btn ui-btn-outline"
                      onClick={() => {
                        stopWakeupRingingNative();
                        onNotice?.("已停");
                        refresh();
                      }}
                    >
                      别响了
                    </button>
                  </div>
                )}

                {plans.filter(p => !p.done).length === 0 && (
                  <div className="menu-item" style={{ cursor: "default" }}>
                    <div className="menu-label-group">
                      <span className="menu-desc">
                        没有任何叫醒。没有安排的话明早不会响——这一项不替你猜几点起。
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div>
              <div className="settings-menu-section-title">它做不到什么</div>
              <div className="menu-group" style={{ marginTop: 10 }}>
                <div className="menu-item" style={{ cursor: "default" }}>
                  <div className="menu-label-group">
                    <span className="menu-desc" style={{ lineHeight: 1.75 }}>
                      · 它不知道你是真醒了还是躺着，只能靠「碰没碰手机」猜；
                      <br />
                      · 手机强制停止过这个 App、或重启后没打开过，闹钟可能不响
                      （部分国产 ROM 会清理定时任务，需要在系统设置里允许自启动）；
                      <br />
                      · 电池优化可能延迟闹钟，建议在系统里给这个 App 关掉省电限制。
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
