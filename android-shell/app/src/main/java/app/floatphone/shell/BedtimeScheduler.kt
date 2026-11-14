package app.floatphone.shell

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONObject

/**
 * 睡前自动锁的原生定时器。
 *
 * 为什么必须做在原生（1.0.37 新增）：
 * 网页里的 setInterval 在 App 切到后台后会被系统冻结——用户实测「切屏挂后台就
 * 停了」。也就是说网页侧那句「每分钟检查一次该不该锁」在他锁屏睡觉时**根本不会跑**，
 * 到点永远不会响。这不是 bug，是 WebView 的正常行为，只能把定时挪到原生。
 *
 * 实现方式：AlarmManager.setExactAndAllowWhileIdle + 一个 BroadcastReceiver。
 * 选它而不选常驻前台服务，是因为：
 *   · 不需要一直有个进程醒着（省电，也不用常驻通知）；
 *   · setExactAndAllowWhileIdle 能在 Doze 深度休眠下唤醒一次，正好够用；
 *   · 触发完就可以立刻睡回去。
 *
 * 关键取舍：
 *   · **先重排下一次闹钟，再做判定**。否则一旦判定过程抛异常，闹钟链就断了，
 *     后面每晚都不会再响——这种「静默失效」最难发现。
 *   · 闹钟只负责「叫醒」，判定仍由 LockGuard 自己做（它要检查时间窗、是否已锁、
 *     用户是否解开过）。原生不在这里判断业务逻辑，保持单一决策点。
 *   · 开机后要重排（BootReceiver 里调一次），否则重启一次功能就永久失效——
 *     闹钟不会跨重启存活。
 *   · 用户手动解锁后当晚不再锁：这个状态在网页侧，但闹钟还会再响几次，
 *     所以收到「已解锁」的通知时也把后面的闹钟取消掉（见 cancelAll）。
 */
object BedtimeScheduler {

    private const val PREFS = "native_bedtime_lock"
    private const val ACTION_TRIGGER = "app.floatphone.shell.BEDTIME_TRIGGER"
    private const val REQUEST_CODE = 8021

    /** 网页下发的配置（全部由网页决定，原生不猜）。 */
    data class Config(
        /** 总开关 */
        val enabled: Boolean,
        /** 每天几点开始管（本地时区，0-23 / 0-59） */
        val startHour: Int,
        val startMinute: Int,
        /** 几点解锁 */
        val endHour: Int,
        val endMinute: Int,
        /** 锁机遮罩上显示的理由 */
        val reason: String,
        /**
         * 到点前多少分钟先醒一次（0 = 不提前）。
         *
         * 目前网页侧不下发这个值，固定 0：闹钟本来就用 setExactAndAllowWhileIdle，
         * 精度已经够，多排一次只会多一次唤醒。留着这个字段是为了将来
         * 「提前几分钟提醒」那种需求，不要在没有使用方的情况下给它编默认值。
         */
        val leadMinutes: Int,
    )

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun loadConfig(context: Context): Config {
        val p = prefs(context)
        return Config(
            enabled = p.getBoolean("enabled", false),
            startHour = p.getInt("startHour", 23).coerceIn(0, 23),
            startMinute = p.getInt("startMinute", 0).coerceIn(0, 59),
            endHour = p.getInt("endHour", 6).coerceIn(0, 23),
            endMinute = p.getInt("endMinute", 30).coerceIn(0, 59),
            reason = p.getString("reason", "").orEmpty(),
            leadMinutes = p.getInt("leadMinutes", 0).coerceIn(0, 60),
        )
    }

    /**
     * 网页下发配置并重排闹钟。
     *
     * 关掉开关时会把已有闹钟取消——不能让用户关了开关还半夜被锁。
     */
    fun configure(context: Context, json: String): Boolean = runCatching {
        val config = JSONObject(json)
        val p = prefs(context).edit()
        if (config.has("enabled")) p.putBoolean("enabled", config.optBoolean("enabled", false))
        if (config.has("startHour")) p.putInt("startHour", config.optInt("startHour", 23).coerceIn(0, 23))
        if (config.has("startMinute")) p.putInt("startMinute", config.optInt("startMinute", 0).coerceIn(0, 59))
        if (config.has("endHour")) p.putInt("endHour", config.optInt("endHour", 6).coerceIn(0, 23))
        if (config.has("endMinute")) p.putInt("endMinute", config.optInt("endMinute", 30).coerceIn(0, 59))
        if (config.has("reason")) p.putString("reason", config.optString("reason", "").take(200))
        if (config.has("leadMinutes")) p.putInt("leadMinutes", config.optInt("leadMinutes", 0).coerceIn(0, 60))
        p.apply()

        val cfg = loadConfig(context)
        if (cfg.enabled) scheduleNext(context) else cancel(context)
        true
    }.getOrDefault(false)

    /**
     * 排下一次触发。
     *
     * 时刻算法：算出「今天或明天的 startHour:startMinute（减去提前量）」中
     * 最近的一个未来时刻。用 1 分钟余量避免在恰好整点时排到过去。
     */
    fun scheduleNext(context: Context): Boolean = runCatching {
        val cfg = loadConfig(context)
        if (!cfg.enabled) {
            cancel(context)
            return@runCatching false
        }

        val now = System.currentTimeMillis()
        val next = nextTriggerAt(now, cfg.startHour, cfg.startMinute, cfg.leadMinutes)
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return@runCatching false
        val pi = pendingIntent(context)

        // setExactAndAllowWhileIdle 在 Doze 下也能唤醒。
        // 拿不到精确闹钟权限（部分 ROM 默认不给）时退回 setAndAllowWhileIdle：
        // 可能迟到几分钟，但总比完全不响强；这一点在网页面板上要如实提示。
        val exact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()
        if (exact) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, pi)
        } else {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, pi)
        }
        prefs(context).edit().putLong("nextTriggerAt", next).putBoolean("lastScheduleExact", exact).apply()
        true
    }.getOrDefault(false)

    /** 算出下一个触发时刻（毫秒）。抽成纯函数，方便核对跨天与跨月边界。 */
    fun nextTriggerAt(now: Long, startHour: Int, startMinute: Int, leadMinutes: Int): Long {
        val cal = java.util.Calendar.getInstance()
        cal.timeInMillis = now
        cal.set(java.util.Calendar.HOUR_OF_DAY, startHour)
        cal.set(java.util.Calendar.MINUTE, startMinute)
        cal.set(java.util.Calendar.SECOND, 0)
        cal.set(java.util.Calendar.MILLISECOND, 0)
        var target = cal.timeInMillis - leadMinutes * 60_000L
        // 已经过了（或正好在当下）就顺延到明天
        if (target <= now + 30_000L) target += 24 * 60 * 60 * 1000L
        return target
    }

    fun cancel(context: Context): Unit = runCatching {
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return@runCatching
        am.cancel(pendingIntent(context))
        prefs(context).edit().remove("nextTriggerAt").apply()
    }.getOrDefault(Unit)

    /**
     * 同一个 REQUEST_CODE + 同一个 Intent = 同一个 PendingIntent 槽位。
     *
     * 所以 cancel 和 schedule 必须用**完全一致**的构造参数，否则取消的
     * 是另一个槽位、原来的闹钟照样会响（「关了开关半夜还被锁」就是这么来的）。
     * FLAG_UPDATE_CURRENT 会让已排的闹钟改用新时刻，而不是再排一个。
     */
    private fun pendingIntent(context: Context): PendingIntent =
        PendingIntent.getBroadcast(
            context,
            REQUEST_CODE,
            Intent(context, BedtimeAlarmReceiver::class.java).setAction(ACTION_TRIGGER),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    /** 状态摘要，网页面板用来显示「下一次会在几点响」和是否精确。 */
    fun statusJson(context: Context): JSONObject {
        val p = prefs(context)
        val cfg = loadConfig(context)
        return JSONObject()
            .put("enabled", cfg.enabled)
            .put("startHour", cfg.startHour)
            .put("startMinute", cfg.startMinute)
            .put("endHour", cfg.endHour)
            .put("endMinute", cfg.endMinute)
            .put("nextTriggerAt", p.getLong("nextTriggerAt", 0L))
            .put("exact", p.getBoolean("lastScheduleExact", false))
            .put("reason", cfg.reason)
    }

    /** 开机后重排（闹钟不跨重启存活）。 */
    fun rescheduleAfterBoot(context: Context) {
        runCatching {
            if (loadConfig(context).enabled) scheduleNext(context)
        }
    }

    /**
     * 记下最近一次触发的结果。
     *
     * 为什么要落盘：半夜触发时用户已经睡了，第二天他打开网页要能看见
     * 「昨晚到底锁没锁、为什么没锁」。不记的话，没锁上这件事永远查不出来——
     * 而这个功能最怕的就是「以为在管，其实没管」。
     */
    fun markOutcome(context: Context, message: String) {
        runCatching {
            prefs(context).edit()
                .putString("lastOutcome", message.take(200))
                .putLong("lastTriggerAt", System.currentTimeMillis())
                .apply()
        }
    }

    /** 读最近一次触发结果（网页面板显示用）。 */
    fun lastOutcome(context: Context): String =
        prefs(context).getString("lastOutcome", "").orEmpty()

    fun lastTriggerAt(context: Context): Long = prefs(context).getLong("lastTriggerAt", 0L)

    /**
     * 锁上后发一条通知。
     *
     * 半夜点亮屏幕时，遮罩会盖住整个屏幕；通知是第二重告知，让用户在通知栏
     * 也能看到「是它锁的」。渠道用 LOW 重要性：半夜不响铃声，不震。
     */
    fun postLockedNotification(context: Context) {
        runCatching {
            // 注意：这里必须用 return@runCatching 而不是裸 return。
            // 裸 return 会从 postLockedNotification 整个返回，虽然能编过，
            // 但会让 lambda 的推断类型变成 Nothing 分支，后面再加逻辑时很容易踩坑。
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE)
                as? android.app.NotificationManager ?: return@runCatching
            val channelId = "bedtime_lock"
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val channel = android.app.NotificationChannel(
                    channelId,
                    "睡前锁",
                    android.app.NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = "到点自动锁机时通知你"
                    setShowBadge(false)
                }
                nm.createNotificationChannel(channel)
            }
            val cfg = loadConfig(context)
            val content = cfg.reason.ifBlank { "这个点该睡了" }
            // 用 NotificationCompat 而不是 android.app.Notification.Builder：
            // 后者在 API < 26 需要另一个构造器，那种「按版本二选一构造」的写法
            // 容易在 Kotlin 里踩注解位置（@Suppress 不能贴在表达式上）导致编译失败。
            // Compat 一个构造器通吃，也不用手写版本分支。
            val notification = androidx.core.app.NotificationCompat.Builder(context, channelId)
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle("手机已锁")
                .setContentText(content)
                .setStyle(androidx.core.app.NotificationCompat.BigTextStyle().bigText(content))
                .setPriority(androidx.core.app.NotificationCompat.PRIORITY_LOW)
                .setAutoCancel(true)
                .build()
            nm.notify(8021, notification)
        }
    }
}
