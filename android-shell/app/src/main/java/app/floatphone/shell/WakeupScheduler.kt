package app.floatphone.shell

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject

/**
 * 起床叫醒的原生调度与存储（1.0.38）。
 *
 * 和睡前锁的区别：睡前锁是「每天固定时刻」，一个闹钟长期有效；
 * 叫醒是**一次性计划**——几点起由角色和用户商量决定，每晚可能不同。
 * 所以每次安排都要单独排一个闹钟，响完作废。
 *
 * requestCode 用计划 id 的 hash，互不覆盖；取消时用同一个 id 精确取消。
 */
object WakeupScheduler {

    private const val PREFS = "native_wakeup"
    private const val KEY_PLANS = "plans"
    private const val ACTION_TRIGGER = "app.floatphone.shell.WAKEUP_TRIGGER"
    private const val KEY_NEXT_ROUND_AT = "nextRoundAt"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** 网页下发一条叫醒计划（整份覆盖，与意图锁同套路）。 */
    fun syncPlans(context: Context, plansJson: String): Boolean = runCatching {
        val parsed = JSONArray(plansJson)
        val kept = JSONArray()
        for (i in 0 until parsed.length()) {
            val item = parsed.optJSONObject(i) ?: continue
            if (item.optString("id").isBlank()) continue
            kept.put(item)
        }
        prefs(context).edit().putString(KEY_PLANS, kept.toString()).apply()
        true
    }.getOrDefault(false)

    /** 取一条计划（找不到返回 null）。 */
    fun findPlan(context: Context, planId: String): JSONObject? = runCatching {
        val raw = prefs(context).getString(KEY_PLANS, "[]") ?: "[]"
        val array = JSONArray(raw)
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            if (item.optString("id") == planId) return@runCatching item
        }
        null
    }.getOrNull()

    /** 排一次叫醒闹钟。atMs 是起床那一刻。 */
    fun schedule(context: Context, planId: String, atMs: Long): Boolean = runCatching {
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return@runCatching false
        val now = System.currentTimeMillis()
        val at = if (atMs <= now) now + 3_000L else atMs
        val pi = pendingIntent(context, planId)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        } else {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        }
        true
    }.getOrDefault(false)

    /** 取消一次叫醒（用户手动停了、或计划被删）。 */
    fun cancel(context: Context, planId: String): Boolean = runCatching {
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return@runCatching false
        am.cancel(pendingIntent(context, planId))
        true
    }.getOrDefault(false)

    /** 记下这一轮响了第几次、下一轮什么时候（用于"最多响 3 轮"）。 */
    fun recordRound(context: Context, planId: String, round: Int) {
        runCatching {
            prefs(context).edit()
                .putInt("round_$planId", round)
                .apply()
        }
    }

    fun roundOf(context: Context, planId: String): Int =
        prefs(context).getInt("round_$planId", 0)

    /**
     * 记下一次叫醒的结果。
     *
     * 为什么要落盘：早上那次响的时候网页不在场，用户上午打开 App 时
     * 面板上得能看到「昨晚那次的叫醒到底怎么样」——响了没、几轮、
     * 是他自己起来的还是根本没起。不记就是黑箱。
     */
    fun postOutcome(context: Context, planId: String, message: String) {
        runCatching {
            prefs(context).edit()
                .putString("outcome_$planId", message.take(200))
                .putLong("outcomeAt_$planId", System.currentTimeMillis())
                .apply()
        }
    }

    fun outcomeOf(context: Context, planId: String): String =
        prefs(context).getString("outcome_$planId", "").orEmpty()

    /** 清掉某条计划的所有痕迹（用户起来了）。 */
    fun clearPlan(context: Context, planId: String) {
        runCatching {
            val raw = prefs(context).getString(KEY_PLANS, "[]") ?: "[]"
            val array = JSONArray(raw)
            val kept = JSONArray()
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                if (item.optString("id") == planId) continue
                kept.put(item)
            }
            prefs(context).edit()
                .putString(KEY_PLANS, kept.toString())
                .remove("round_$planId")
                .apply()
        }
    }

    private fun pendingIntent(context: Context, planId: String): PendingIntent {
        val requestCode = planId.hashCode() and 0x7FFFFFFF
        return PendingIntent.getBroadcast(
            context,
            requestCode,
            Intent(context, WakeupAlarmReceiver::class.java)
                .setAction(ACTION_TRIGGER)
                .putExtra("planId", planId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
