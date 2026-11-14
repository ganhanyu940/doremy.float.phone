package app.floatphone.shell

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * 临时意图锁的原生定时器（1.0.38 新增）。
 *
 * 和睡前锁一样，**定时不能放在网页里**：WebView 进后台后 JS 会被系统冻结，
 * 用户实测「切屏挂后台就停了」。他说完「我去洗澡」就把手机带进浴室，
 * 这正是 App 必然在后台的场景——网页定时器在那时候根本不会跑。
 *
 * 与睡前锁的区别（所以没有复用 BedtimeScheduler）：
 *   · 睡前锁是「每天固定时刻」，一天一个闹钟；
 *   · 意图锁是「说完之后 N 分钟检查一次」，随时可能来一条，且只响一次。
 *   两者的槽位、取消语义、重排逻辑都不一样，混用一个 PendingIntent
 *   requestCode 会互相覆盖——那会导致"设了意图却响成睡前锁"这种鬼问题。
 *
 * requestCode 用意图 id 的 hash 保证每条意图各占一个槽位，
 * 既能多条并存，也能按 id 精确取消。
 */
object IntentScheduler {

    private const val ACTION_TRIGGER = "app.floatphone.shell.INTENT_TRIGGER"

    /** 排一条意图的检查闹钟。checkAt 是毫秒时间戳。 */
    fun schedule(context: Context, intentId: String, checkAt: Long): Boolean = runCatching {
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return@runCatching false
        val now = System.currentTimeMillis()
        // 已经过点了就给它 3 秒（不能传过去的时间，否则可能立刻乱响）
        val at = if (checkAt <= now) now + 3_000L else checkAt
        val pi = pendingIntent(context, intentId)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        } else {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        }
        true
    }.getOrDefault(false)

    /** 取消一条意图的闹钟（用户取消、打卡完成、已经结算过都要调）。 */
    fun cancel(context: Context, intentId: String): Boolean = runCatching {
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return@runCatching false
        am.cancel(pendingIntent(context, intentId))
        true
    }.getOrDefault(false)

    /**
     * 同一条意图必须用同一个 requestCode，否则 cancel 落到别的槽位上，
     * 表现为「取消了却还会响」。
     */
    private fun pendingIntent(context: Context, intentId: String): PendingIntent {
        val requestCode = intentId.hashCode() and 0x7FFFFFFF
        return PendingIntent.getBroadcast(
            context,
            requestCode,
            Intent(context, IntentAlarmReceiver::class.java)
                .setAction(ACTION_TRIGGER)
                .putExtra("intentId", intentId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
