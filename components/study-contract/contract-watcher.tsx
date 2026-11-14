"use client";

// 学习约定的结算触发器。
//
// 为什么是组件而不是模块级定时器：与 PerceptionBootstrap 同一套路——
// 用一个返回 null 的组件承载副作用，挂载即跑、卸载即停，不会在
// 别处（比如某次测试渲染）意外留下一个永久的定时器。
//
// 为什么复用「定时轮询」而不是给每条约定排一个 setTimeout：
//   · 网页进后台会被系统节流，setTimeout 到点不一定真跑；
//   · 约定数量不定，逐个排表要处理新增/取消/改期的清理，容易漏；
//   · 轮询是幂等的：扫一遍到期未判定的，判过了状态就变了，不会重复处置。
//
// 间隔 60 秒：约定本来就是「学到某个时刻」这种粒度，晚几十秒判定无影响，
// 却能把唤醒次数压到很低。
//
// 只在真正判定掉约定时才发事件（让聊天侧有机会让角色说一句），
// 平时完全静默——不能为了一个后台检查每分钟打扰用户。

import { useEffect } from "react";

import { settleDueContracts } from "@/lib/study-contract";

export const CONTRACT_SETTLED_EVENT = "study-contract-settled";

export function ContractWatcher() {
  useEffect(() => {
    let disposed = false;

    const tick = () => {
      if (disposed) return;
      // 没开这个功能就什么都不做（避免白算一遍时间线）
      try {
        const settled = settleDueContracts();
        if (!settled.length) return;
        window.dispatchEvent(new CustomEvent(CONTRACT_SETTLED_EVENT, {
          detail: {
            results: settled.map(item => ({
              title: item.evaluation.contract.title,
              passed: item.evaluation.passed,
              verdict: item.evaluation.verdict,
              locked: item.locked,
              lockMinutes: item.lockMinutes,
              sessionId: item.evaluation.contract.sessionId,
              characterId: item.evaluation.contract.characterId,
            })),
          },
        }));
      } catch {
        // 判定失败不该打断任何东西，下一轮再试
      }
    };

    // 启动后先跑一次：App 关了整晚再打开时，昨晚到期的约定要立刻结算，
    // 而不是等到第一个一分钟过去。
    tick();
    const timer = window.setInterval(tick, 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return null;
}
