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

import { clearAllUsageLogs, getApiLogsForUsage, type DebugInfo } from "@/lib/api-log-store";
import {
  USAGE_WINDOWS,
  filterLogsSince,
  formatTokens,
  resolveLogFeature,
  summarizeUsage,
  type UsageWindowId,
} from "@/lib/api-usage-stats";
import {
  createEmptyRule,
  formatMoney,
  loadPricing,
  resolveRuleFor,
  resetPricingCache,
  savePricing,
  summarizeCost,
  tokensOfLog,
  type CostPricingConfig,
} from "@/lib/api-cost";
import "./api-usage-page.css";

/** 一条日志一行摘要：功能名 + 时间 + token，点开看详情。 */
function LogRow({ log, onOpen, pricing }: { log: DebugInfo; onOpen: () => void; pricing: CostPricingConfig }) {
  const feature = resolveLogFeature(log);
  const tokens = tokensOfLog(log);
  const rule = resolveRuleFor(log.model, pricing);
  const time = new Date(log.timestamp);
  const timeText = Number.isFinite(time.getTime())
    ? time.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    : "—";

  // 按次计费时 token 与金额无关，只标「按次」；按量且是估算值则加个 ~
  const tokenText = rule.mode === "perCall"
    ? "按次"
    : tokens.total > 0
      ? (tokens.real ? formatTokens(tokens.total) : "≈" + formatTokens(tokens.total))
      : "无 usage";

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
        {tokenText}
        <i className="au-log-cost">
          {formatMoney(
            rule.mode === "perCall"
              ? rule.perCallPrice
              : (() => {
                  // 单条费用直接用聚合函数算，保证与总计口径一致
                  const one = summarizeCost([log], pricing, resolveLogFeature);
                  return one.total;
                })(),
            pricing.currency,
          )}
        </i>
      </span>
    </button>
  );
}

/** 详情面板：展开看这次调用的完整统计与首条消息。 */
function LogDetail({ log, onClose, pricing }: { log: DebugInfo; onClose: () => void; pricing: CostPricingConfig }) {
  const tokens = tokensOfLog(log);
  const rule = resolveRuleFor(log.model, pricing);
  const cost = summarizeCost([log], pricing, resolveLogFeature).total;
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
        <div>
          <span>输入 token{tokens.real ? "" : "（估算）"}</span>
          <b>{tokens.total > 0 ? formatTokens(tokens.prompt) : "无数据"}</b>
        </div>
        <div>
          <span>输出 token{tokens.real ? "" : "（估算）"}</span>
          <b>{tokens.total > 0 ? formatTokens(tokens.completion) : "无数据"}</b>
        </div>
        <div>
          <span>缓存命中</span>
          <b>{tokens.cached > 0 ? formatTokens(tokens.cached) : "无"}</b>
        </div>
        <div>
          <span>本次费用</span>
          <b>{rule.mode === "perCall" ? "按次 " + formatMoney(cost, pricing.currency) : formatMoney(cost, pricing.currency)}</b>
        </div>
        <div><span>耗时</span><b>{typeof log.durationMs === "number" ? (log.durationMs / 1000).toFixed(1) + " 秒" : "未记录"}</b></div>
      </div>
      <div className="au-detail-msg">
        <span>这次发出的内容（截断）</span>
        <pre>{firstUser.slice(0, 600) || "（空）"}</pre>
      </div>
    </div>
  );
}

/**
 * 单价设置。
 *
 * 设计取舍：默认不展开。大多数人只想看「谁在烧钱」，不想先填六个价格框；
 * 但单价必须能改——服务商价格各不相同，写死一个数字等于编造账单。
 * 所以默认给一套可用的起点价，并在卡片上明确写「按你填的单价估算」。
 */
function PricingEditor({
  config,
  onChange,
}: {
  config: CostPricingConfig;
  onChange: (next: CostPricingConfig) => void;
}) {
  const updateRule = (id: string, patch: Partial<CostPricingConfig["rules"][number]>) => {
    onChange({
      ...config,
      rules: config.rules.map(rule => (rule.id === id ? { ...rule, ...patch } : rule)),
    });
  };

  const removeRule = (id: string) => {
    onChange({ ...config, rules: config.rules.filter(rule => rule.id !== id) });
  };

  const addRule = () => {
    // 新规则默认空 matchModel，用户填上模型名关键词即可命中
    onChange({ ...config, rules: [...config.rules, createEmptyRule()] });
  };

  return (
    <section className="au-section au-pricing">
      <div className="au-section-head">
        <h3>单价设置</h3>
        <button type="button" className="au-link" onClick={addRule}>＋ 加一条</button>
      </div>
      <p className="au-hint">
        「模型关键词」留空 = 默认规则，兜住所有没单独配置的模型；填了就按包含匹配（不分大小写），
        更长的关键词优先。按量计费的单价单位是「元 / 百万 token」。
      </p>

      {config.rules.map(rule => (
        <div className="au-rule" key={rule.id}>
          <div className="au-rule-head">
            <input
              type="text"
              className="au-input"
              placeholder="模型关键词（留空=默认）"
              value={rule.matchModel}
              onChange={e => updateRule(rule.id, { matchModel: e.target.value })}
            />
            <button type="button" className="au-rule-del" onClick={() => removeRule(rule.id)}>删除</button>
          </div>

          <div className="au-seg">
            <button
              type="button"
              className="au-seg-btn"
              data-active={rule.mode === "perToken" ? "" : undefined}
              onClick={() => updateRule(rule.id, { mode: "perToken" })}
            >
              按量计费
            </button>
            <button
              type="button"
              className="au-seg-btn"
              data-active={rule.mode === "perCall" ? "" : undefined}
              onClick={() => updateRule(rule.id, { mode: "perCall" })}
            >
              按次计费
            </button>
          </div>

          {rule.mode === "perToken" ? (
            <div className="au-price-grid">
              <label>
                <span>输入单价</span>
                <input
                  type="number" inputMode="decimal" min={0} step="0.01"
                  value={rule.inputPrice}
                  onChange={e => updateRule(rule.id, { inputPrice: Number(e.target.value) })}
                />
              </label>
              <label>
                <span>输出单价</span>
                <input
                  type="number" inputMode="decimal" min={0} step="0.01"
                  value={rule.outputPrice}
                  onChange={e => updateRule(rule.id, { outputPrice: Number(e.target.value) })}
                />
              </label>
              <label>
                <span>缓存读取单价</span>
                <input
                  type="number" inputMode="decimal" min={0} step="0.01"
                  value={rule.cachedInputPrice}
                  onChange={e => updateRule(rule.id, { cachedInputPrice: Number(e.target.value) })}
                />
              </label>
            </div>
          ) : (
            <div className="au-price-grid">
              <label>
                <span>每次调用价格</span>
                <input
                  type="number" inputMode="decimal" min={0} step="0.001"
                  value={rule.perCallPrice}
                  onChange={e => updateRule(rule.id, { perCallPrice: Number(e.target.value) })}
                />
              </label>
            </div>
          )}
        </div>
      ))}

      <button
        type="button"
        className="au-reset"
        onClick={() => {
          resetPricingCache();
          onChange(loadPricing());
        }}
      >
        恢复默认单价
      </button>
    </section>
  );
}

export function ApiUsagePage({ onBack }: { onBack?: () => void }) {
  const [windowId, setWindowId] = useState<UsageWindowId>("24h");
  const [version, setVersion] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pricing, setPricing] = useState<CostPricingConfig>(() => loadPricing());
  const [pricingOpen, setPricingOpen] = useState(false);

  const refresh = useCallback(() => setVersion(v => v + 1), []);

  const updatePricing = useCallback((next: CostPricingConfig) => {
    setPricing(next);
    savePricing(next);
  }, []);

  // 页面打开期间定时刷新：后台调用可能正在发生，看着数字跳才有说服力
  useEffect(() => {
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const allLogs = useMemo(() => {
    void version;
    // 新的排前面，翻的时候先看最近的。
    // 用合并版：工坊（QA 助手）的调用存在独立的环里，只读主环会漏掉这部分用量。
    return getApiLogsForUsage().slice().reverse();
  }, [version]);

  const logs = useMemo(() => {
    const windowDef = USAGE_WINDOWS.find(w => w.id === windowId);
    if (!windowDef || windowDef.ms === 0) return allLogs;
    return filterLogsSince(allLogs, Date.now() - windowDef.ms);
  }, [allLogs, windowId]);

  const summary = useMemo(() => summarizeUsage(logs), [logs]);
  const cost = useMemo(() => summarizeCost(logs, pricing, resolveLogFeature), [logs, pricing]);

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
          <div className="au-card au-card-cost">
            <span>估算花费</span>
            <b>{formatMoney(cost.total, pricing.currency)}</b>
          </div>
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
          <div className="au-card">
            <span>缓存命中</span>
            <b>{summary.totalCachedTokens > 0 ? formatTokens(summary.totalCachedTokens) : "无"}</b>
          </div>
        </div>

        <div className="au-cost-bar">
          <span>
            花费按你填的单价估算，你的服务商实际账单可能不同。
            {cost.estimatedCalls > 0 ? `其中 ${formatTokens(cost.estimatedCalls)} 次没有 usage，token 为估算值。` : ""}
          </span>
          <button type="button" className="au-link" onClick={() => setPricingOpen(v => !v)}>
            {pricingOpen ? "收起单价设置" : "设置单价"}
          </button>
        </div>

        {pricingOpen ? (
          <PricingEditor config={pricing} onChange={updatePricing} />
        ) : null}

        {summary.missingUsageCalls > 0 ? (
          <p className="au-warn">
            有 {formatTokens(summary.missingUsageCalls)} 次调用服务商没有返回 usage 字段，
            这些次数已在「调用次数」里，token 是按日志文本估算的（标 ≈），
            花费也按估算值算。换个会返回 usage 的渠道或模型就能拿到精确数字。
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
                      {item.cachedTokens > 0 ? " · 缓存 " + formatTokens(item.cachedTokens) : ""}
                      {item.missingUsageCalls > 0 ? " · " + item.missingUsageCalls + " 次估算" : ""}
                      {(() => {
                        const fc = cost.byFeature.find(f => f.feature === item.feature);
                        return fc ? " · " + formatMoney(fc.cost, pricing.currency) : "";
                      })()}
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
                  <LogRow log={log} onOpen={() => setOpenId(openId === log.id ? null : log.id)} pricing={pricing} />
                  {openId === log.id ? (
                    <LogDetail log={log} onClose={() => setOpenId(null)} pricing={pricing} />
                  ) : null}
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
              // 合并版清空：工坊那个环也要清，否则清完数字不归零
              clearAllUsageLogs();
              setOpenId(null);
              refresh();
            }}
          >
            清空全部调用记录
          </button>
          <p>清空只删本地记录（含工坊），不影响服务商那边的账单。</p>
        </div>
    </div>
  );
}
