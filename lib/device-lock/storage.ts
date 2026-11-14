"use client";

// 角色锁机的配置与门控。
//
// 与「设备动作」分开另成一册，不塞进 device-action：
//   ① 设备动作是「一次性、立即可见、可撤销」的，锁机是**持续性**状态
//      （锁住到某个时刻），两者生命周期根本不同，混在一起会把
//      device-action 那套「每个动作独立开关」的粒度模型撑坏；
//   ② 锁机的开关语义不一样：这里只有一个「谁可以锁我」的总开关，
//      默认关，用户亲自开启才算授权；
//   ③ 白名单存在原生侧（native_lock_guard），网页侧只负责下发，
//      不需要在这份配置里再存一份，避免两处不一致。
//
// 安全取向（改之前先读）：
//   - 默认关闭。不开这个开关，角色连「有锁机这个能力」都看不到；
//   - 角色能锁也能解（用户要求「更像真人」），但**每一次解锁都要说明理由**
//     并记进感知流水，让用户事后翻得到「它是怎么把我放出来的」；
//   - 单次时长由用户设定上限（默认 8 小时，与手动锁机一致），
//     角色说「锁两小时」不可能超过这个上限；
//   - 锁上后不假装成功：失败（没开无障碍、壳版本过低）明确回报原因。

import { kvGet, kvSet, registerKvMigration } from "../kv-db";

const CONFIG_KEY = "ai_phone_phone_lock_config_v1";
registerKvMigration(CONFIG_KEY);

/** 单次锁定时长的硬上限：与原生 LockGuard.MAX_LOCK_MS 一致（8 小时）。 */
export const PHONE_LOCK_MAX_MINUTES = 480;

export type PhoneLockConfig = {
  /**
   * 角色是否被允许锁机。**默认关**，必须用户亲自打开。
   *
   * 为什么单开一个开关、不复用「无障碍已开启」当授权：
   * 无障碍是系统层面的能力开关，用户开它是为了用锁机台自己锁自己；
   * 「让角色也能锁我」是另一层授权，必须单独表达同意。
   */
  allowCharacterLock: boolean;
  /**
   * 单次锁定时长上限（分钟），角色传入超过它的值会被夹到它。
   *
   * 与手动锁机不同：手动那边用户自己点，8 小时是产品硬上限；
   * 这边是角色发起的，用户依然希望保留自己的话语权，所以可调。
   */
  maxMinutes: number;
  /**
   * 锁上后是否把用户拉回「学习应用」。
   *
   * 用户的选择（A）：要。默认值留空字符串 = 不自动拉起，
   * 因为不知道他装的是哪个应用；用户在小手机里指定包名后才生效。
   */
  pullBackPackage: string;
  /** 有人动你的手机时是否发一条系统通知告诉你。默认开（与设备动作一致）。 */
  notifyOnAction: boolean;
};

export const PHONE_LOCK_DEFAULTS: PhoneLockConfig = {
  allowCharacterLock: false,
  maxMinutes: PHONE_LOCK_MAX_MINUTES,
  pullBackPackage: "",
  notifyOnAction: true,
};

export function loadPhoneLockConfig(): PhoneLockConfig {
  try {
    const raw = kvGet(CONFIG_KEY);
    if (!raw) return { ...PHONE_LOCK_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<PhoneLockConfig>;
    const max = Number(parsed.maxMinutes);
    return {
      allowCharacterLock: parsed.allowCharacterLock === true,
      maxMinutes: Number.isFinite(max) && max >= 1
        ? Math.min(PHONE_LOCK_MAX_MINUTES, Math.round(max))
        : PHONE_LOCK_DEFAULTS.maxMinutes,
      pullBackPackage: typeof parsed.pullBackPackage === "string" ? parsed.pullBackPackage.trim() : "",
      notifyOnAction: parsed.notifyOnAction !== false,
    };
  } catch {
    return { ...PHONE_LOCK_DEFAULTS };
  }
}

export function savePhoneLockConfig(config: PhoneLockConfig): void {
  kvSet(CONFIG_KEY, JSON.stringify(config));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("phone-lock-config-changed"));
  }
}
