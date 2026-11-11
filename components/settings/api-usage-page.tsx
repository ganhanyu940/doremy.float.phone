"use client";

/**
 * 调用与用量明细：回答「我的 token 到底被谁花了」。
 *
 * 为什么值得单独做一页：
 *   原来只有「底层调用日志」——一条条完整请求堆在一起，人能翻但没法汇总，
 *   而用户真正想知道的是「哪个功能在偷跑」。这里把它按功能聚合，
 *   并明确区分「本次会话记录到的」与「服务商账单上的」。
 *
 * 必须诚实的一点写在页面最上方：
 *   本应用不代理模型调用，请求从浏览器/壳直连服务商，日志也只是本地记录。
 *   同一把 key 若还配在别的软件上，那部分不会出现在这里。
 *   不写清楚，用户只会觉得「统计不准」。
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { clearApiLogs, getApiLogs, type DebugInfo } from "@/lib/api-log-store";
import {
  USAGE_WINDOWS,
  filterLogsSince,
  formatTokens,
  resolveLogFeature,
  summarizeUsage,
  type UsageWindowId,
} from "@/lib/api-usage-stats";
import "./api-usage-page.css";

/** 一条日志一行摘要：功能名 + 时间 + token，点开看详情。 */
function LogRow({ log, onOpen }: { log: DebugInfo; onOpen: () => void }) {
  const feature = resolveLogFeature(log);
  const total = log.usage?.total_tokens
    ?? (log.usage ? (log.usage.prompt_tokens ?? 0) + (log.usage.completion_tokens ?? 0) : 0);
  const time = new Date(log.timestamp);
  const timeText = Number.isFinite(time.getTime())
    ? time.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    : "—";

  return (
    <button type="button" className="au-log-row" onClick={onOpen}>
      <span className="au-log-main">
        <span className="au-log-feature">{feature}</span>
        <span className="au-log-meta">
          {timeText}
          {log.model ? " · " + log.model : ""}
          {typeof log.durationMs === "number" ? " · " + (log.durationMs / 1000).toFixed(1) + "s" : ""}
        </span>
      </span>
      <span className="au-log-tokens">
        {total > 0 ? formatTokens(total) : "无 usage"}
      </span>
    </button>
  );
}

/** 详情面板：展开看这次调用的完整统计与首条消息。 */
function LogDetail({ log, onClose }: { log: DebugInfo; onClose: () => void }) {
  const usage = log.usage;
  const firstUser = log.messages?.find(m => m.role === "user")?.content
    ?? log.messages?.[0]?.content ?? "";

  return (
    <div className="au-detail">
      <div className="au-detail-head">
        <b>{resolveLogFeature(log)}</b>
        <button type="button" className="au-link" onClick={onClose}>收起</button>
      </div>
      <div className="au-detail-grid">
        <div><span>时间</span><b>{new Date(log.timestamp).toLocaleString("zh-CN")}</b></div>
        <div><span>模型</span><b>{log.model || "未记录"}</b></div>
        <div><span>输入 token</span><b>{usage?.prompt_tokens != null ? formatTokens(usage.prompt_tokens) : "服务商未返回"}</b></div>
        <div><span>输出 token</span><b>{usage?.completion_tokens != null ? formatTokens(usage.completion_tokens) : "服务商未返回"}</b></div>
        <div><span>合计</span><b>{usage?.total_tokens != null ? formatTokens(usage.total_tokens) : "—"}</b></div>
        <div><span>耗时</span><b>{typeof log.durationMs === "number" ? (log.durationMs / 1000).toFixed(1) + " 秒" : "未记录"}</b></div>
      </div>
      <div className="au-detail-msg">
        <span>这次发出的内容（截断）</span>
        <pre>{firstUser.slice(0, 600) || "（空）"}</pre>
      </div>
    </div>
  );
}

export function ApiUsagePage({ onBack }: { onBack?: () => void }) {
  const [windowId, setWindowId] = useState<UsageWindowId>("24h");
  const [version, setVersion] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = useCallback(() => setVersion(v => v + 1), []);

  // 页面打开期间定时刷新：后台调用可能正在发生，看着数字跳才有说服力
  useEffect(() => {
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const allLogs = useMemo(() => {
    void version;
    // 新的排前面，翻的时候先看最近的
    return getApiLogs().slice().reverse();
  }, [version]);

  const logs = useMemo(() => {
    const windowDef = USAGE_WINDOWS.find(w => w.id === windowId);
    if (!windowDef || windowDef.ms === 0) return allLogs;
    return filterLogsSince(allLogs, Date.now() - windowDef.ms);
  }, [allLogs, windowId]);

  const summary = useMemo(() => summarizeUsage(logs), [logs]);

  // 不套 PageShell：设置页的子页已经在外层提供了标题栏与返回键，
  // 再套一层会出现两个 header。
  return (
    <div className="au-page">
        <div className="au-note">
          这里统计的是<strong>本应用自己发出的请求</strong>。本应用不代理模型调用——
          请求由你的设备直连你配置的服务商，同一把 key 若还配在别的软件上，
          那部分不会出现在这里，只能去服务商控制台看。
        </div>

        <div className="au-windows">
          {USAGE_WINDOWS.map(w => (
            <button
              key={w.id}
              type="button"
              className="au-window"
              data-active={windowId === w.id ? "" : undefined}
              onClick={() => setWindowId(w.id)}
            >
              {w.label}
            </button>
          ))}
        </div>

        <div className="au-cards">
          <div className="au-card">
            <span>调用次数</span>
            <b>{formatTokens(summary.totalCalls)}</b>
          </div>
          <div className="au-card">
            <span>总 token</span>
            <b>{formatTokens(summary.totalTokens)}</b>
          </div>
          <div className="au-card">
            <span>输入</span>
            <b>{formatTokens(summary.totalPromptTokens)}</b>
          </div>
          <div className="au-card">
            <span>输出</span>
            <b>{formatTokens(summary.totalCompletionTokens)}</b>
          </div>
        </div>

        {summary.missingUsageCalls > 0 ? (
          <p className="au-warn">
            有 {formatTokens(summary.missingUsageCalls)} 次调用服务商没有返回 usage 字段，
            这些次数已在「调用次数」里，但 token 数按 0 计。换个支持返回 usage 的渠道或模型即可补上。
          </p>
        ) : null}

        <section className="au-section">
          <div className="au-section-head">
            <h3>按功能统计</h3>
            <button type="button" className="au-link" onClick={refresh}>刷新</button>
          </div>
          {summary.byFeature.length === 0 ? (
            <p className="au-empty">这个时间段没有调用记录。</p>
          ) : (
            <div className="au-list">
              {summary.byFeature.map(item => {
                // 用最费 token 的那个当基准画条，直观看出谁是大头
                const max = summary.byFeature[0]?.totalTokens || 1;
                const percent = Math.max(2, Math.round((item.totalTokens / max) * 100));
                return (
                  <div className="au-feature" key={item.feature}>
                    <div className="au-feature-top">
                      <span className="au-feature-name">{item.feature}</span>
                      <span className="au-feature-num">
                        {formatTokens(item.totalTokens)} token · {formatTokens(item.calls)} 次
                      </span>
                    </div>
                    <div className="au-bar">
                      <i style={{ width: percent + "%" }} />
                    </div>
                    <div className="au-feature-sub">
                      输入 {formatTokens(item.promptTokens)} · 输出 {formatTokens(item.completionTokens)}
                      {item.missingUsageCalls > 0 ? " · " + item.missingUsageCalls + " 次无 usage" : ""}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {summary.models.length > 0 ? (
          <section className="au-section">
            <h3>按模型统计</h3>
            <div className="au-list">
              {summary.models.map(item => (
                <div className="au-model" key={item.model}>
                  <span>{item.model}</span>
                  <span>{formatTokens(item.calls)} 次 · {formatTokens(item.totalTokens)} token</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="au-section">
          <div className="au-section-head">
            <h3>调用明细</h3>
            <span className="au-count">{formatTokens(logs.length)} 条</span>
          </div>
          {logs.length === 0 ? (
            <p className="au-empty">没有记录。发一条消息或等后台功能跑一次再来看。</p>
          ) : (
            <div className="au-logs">
              {logs.slice(0, 100).map(log => (
                <div key={log.id}>
                  <LogRow log={log} onOpen={() => setOpenId(openId === log.id ? null : log.id)} />
                  {openId === log.id ? <LogDetail log={log} onClose={() => setOpenId(null)} /> : null}
                </div>
              ))}
              {logs.length > 100 ? (
                <p className="au-empty">只显示最近 100 条，共 {formatTokens(logs.length)} 条。</p>
              ) : null}
            </div>
          )}
        </section>

        <div className="au-footer">
          <button
            type="button"
            className="au-danger"
            onClick={() => {
              clearApiLogs();
              setOpenId(null);
              refresh();
            }}
          >
            清空全部调用记录
          </button>
          <p>清空只删本地记录，不影响服务商那边的账单。</p>
        </div>
    </div>
  );
}
