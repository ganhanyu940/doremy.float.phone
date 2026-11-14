package app.floatphone.shell

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import org.json.JSONArray
import org.json.JSONObject

/**
 * 临时意图锁的触发点：闹钟响了，判断该不该锁。
 *
 * 为什么判定要在原生里做，而不是叫醒网页让它算：
 *   用户说完「我去洗澡」就把手机放下/带进浴室，网页那时处于后台被冻结，
 *   根本不会执行。必须由这里直接读使用情况并决定锁不锁。
 *
 * 判定口径（与 lib/intent-lock/engine.ts 的网页侧保持一致，改一处要同步另一处）：
 *   · 只看「用户说完之后」这段窗口内**非放行清单**的前台使用时长；
 *   · 超过 20 秒算"还在玩"；
 *   · 放着音乐不动（清单里加了音乐应用）不算；
 *   · 读不到使用情况 → **照样锁**（未授权的人正是最需要被拦的）。
 *
 * 已知盲区：手机放客厅、人在刷平板 → 检测不到；
 * 一直停在同一个页面不动 → 时间线不刷新，可能被判成已放下。
 */
class IntentAlarmReceiver : BroadcastReceiver() {

    private companion object {
        /** float 自己的包名，见 decideAndLock 里为什么它永远不放过。 */
        const val FLOAT_PACKAGE_NAME = "app.floatphone.shell"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val intentId = intent.getStringExtra("intentId").orEmpty()
        if (intentId.isBlank()) return

        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val wakeLock: PowerManager.WakeLock? = try {
            power?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "float:intent-lock")?.apply {
                setReferenceCounted(false)
                acquire(60_000L)
            }
        } catch (t: Throwable) {
            null
        }

        try {
            val guard = CallControlService.instance?.currentLockGuard()
            if (guard == null) {
                IntentStore.markOutcome(context, intentId, "无障碍服务未连接，这次没能锁上")
                return
            }
            val record = IntentStore.findPending(context, intentId)
            if (record == null) {
                // 已经被网页侧结算过（打卡/取消），什么都不做。
                return
            }
            val result = decideAndLock(context, guard, record)
            IntentStore.markOutcome(context, intentId, result.optString("message", ""))
        } catch (t: Throwable) {
            IntentStore.markOutcome(context, intentId, "执行异常：${t.message ?: t::class.java.simpleName}")
        } finally {
            runCatching { if (wakeLock?.isHeld == true) wakeLock.release() }
        }
    }

    private fun decideAndLock(context: Context, guard: LockGuard, record: JSONObject): JSONObject {
        val title = record.optString("title", "去做事")
        val lockMinutes = record.optInt("lockMinutes", 20)
        val createdAt = record.optLong("createdAt", 0L)

        val allowedPackages = record.optJSONArray("allowPackages") ?: JSONArray()
        val allowPkgs = HashSet<String>()
        for (i in 0 until allowedPackages.length()) allowPkgs.add(allowedPackages.optString(i))

        // 原生只能看到「float 在前台」，看不到用户在里面开着哪个应用
        // （那是 WebView 内部状态）。所以 float 自己这个包名**永远不放过**：
        // 判定「在小手机里用的是不是白名单应用」由网页侧那份实现负责，
        // 原生这边宁可从严——用户要的是被管住，不是被宽松对待。
        //
        // 放行清单里的 float 内部应用同理：仍算使用，只是不计入"违规"这件事
        // 原生判不了，如实退回给网页侧在下次打开时纠正。
        allowPkgs.remove(FLOAT_PACKAGE_NAME)

        val usedSeconds = measureUsageSeconds(context, createdAt, allowPkgs)

        // 使用记录读不到（未授权）：照样锁。理由见类注释。
        if (usedSeconds < 0) {
            val minutes = lockMinutes.coerceIn(1, 120)
            guard.lock(System.currentTimeMillis() + minutes * 60_000L, "说好的「$title」，先把手机放下", "intent")
            return JSONObject().put("locked", true).put("message", "读不到使用记录，按设置照样锁了 $minutes 分钟")
        }

        if (usedSeconds < 20) {
            return JSONObject().put("locked", false).put("message", "你放下手机了，不锁")
        }

        val minutes = lockMinutes.coerceIn(1, 120)
        val usedMinutes = maxOf(1, usedSeconds / 60)
        guard.lock(System.currentTimeMillis() + minutes * 60_000L, "说好的「$title」，先把手机放下", "intent")
        return JSONObject()
            .put("locked", true)
            .put("message", "说完之后手机还用了约 $usedMinutes 分钟，已锁 $minutes 分钟")
    }

    /**
     * 自 since 之后，非放行清单应用的前台使用秒数。
     *
     * 返回 -1 表示读不到（没授权），调用方据此决定"照样锁"。
     *
     * 用 UsageEvents 逐段求交而不是 queryUsageStats 累计：
     * 后者只能给"今天某应用共用了多久"，回答不了"从我说完到现在他动了多久"。
     */
    private fun measureUsageSeconds(context: Context, since: Long, allowedPackages: Set<String>): Long {
        if (!hasUsageAccess(context)) return -1L
        val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager ?: return -1L
        val now = System.currentTimeMillis()
        if (since <= 0L || now <= since) return 0L

        return try {
            val events = usm.queryEvents(since, now)
            val event = UsageEvents.Event()
            var lastStart = 0L
            var lastPackage = ""
            var lastWasForeground = false
            var total = 0L

            fun settle(pkg: String, start: Long, end: Long) {
                if (pkg.isBlank() || start <= 0L || end <= start) return
                if (allowedPackages.contains(pkg)) return
                total += (end - start) / 1000
            }

            while (events.hasNextEvent()) {
                events.getNextEvent(event)
                val type = event.eventType
                val isForeground = type == UsageEvents.Event.MOVE_TO_FOREGROUND
                    || type == UsageEvents.Event.ACTIVITY_RESUMED
                val isBackground = type == UsageEvents.Event.MOVE_TO_BACKGROUND
                    || type == UsageEvents.Event.ACTIVITY_PAUSED
                if (!isForeground && !isBackground) continue

                if (isBackground && lastWasForeground) {
                    settle(lastPackage, lastStart, event.timeStamp)
                    lastWasForeground = false
                    lastStart = 0L
                } else if (isForeground) {
                    if (lastWasForeground) settle(lastPackage, lastStart, event.timeStamp)
                    lastPackage = event.packageName.orEmpty()
                    lastStart = event.timeStamp
                    lastWasForeground = true
                }
            }
            // 当前仍在前台的那一段算到此刻
            if (lastWasForeground) settle(lastPackage, lastStart, now)
            total
        } catch (t: Throwable) {
            -1L
        }
    }

    private fun hasUsageAccess(context: Context): Boolean = try {
        val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = appOps.unsafeCheckOpNoThrow(
            AppOpsManager.OPSTR_GET_USAGE_STATS,
            android.os.Process.myUid(),
            context.packageName,
        )
        mode == AppOpsManager.MODE_ALLOWED
    } catch (t: Throwable) {
        false
    }
}
