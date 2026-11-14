package app.floatphone.shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import org.json.JSONObject

/**
 * 起床叫醒的触发点（1.0.38）。
 *
 * 一次叫醒不是"响一声就完事"，而是一个小状态机：
 *
 *   闹钟响（第 1 轮）→ 播角色的话 + 振动 + 可选闹铃音
 *     ├ 用户点「我起来了」→ 停，记 done
 *     ├ 用户碰了手机超过设定时长 → 停，记"起来了但赖床"
 *     └ 没反应 → 每隔 N 分钟再响一轮，最多 maxRounds 轮
 *                └ 轮数用完 → 停，记"一直没起来"（如实记，不美化）
 *
 * 为什么轮数有限：用户自述易困，但如果响了十轮还没反应，
 * 那多半是已经起床走了、或手机不在身边。继续响只会在白天某个时刻
 * 突然把人吓一跳——那不是叫醒，是事故。
 *
 * 怎么"再响一轮"：不在这里 sleep 等待，而是重新排一个 AlarmManager 闹钟。
 * Receiver 必须尽快返回，长时间占着会拖垮系统，也不可靠。
 */
class WakeupAlarmReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val planId = intent.getStringExtra("planId").orEmpty()
        if (planId.isBlank()) return

        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val wakeLock: PowerManager.WakeLock? = try {
            power?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "float:wakeup")?.apply {
                setReferenceCounted(false)
                acquire(60_000L)
            }
        } catch (t: Throwable) {
            null
        }

        try {
            val plan = WakeupScheduler.findPlan(context, planId)
            if (plan == null) {
                // 计划已被删除或已完成，别响。
                return
            }
            val round = WakeupScheduler.roundOf(context, planId) + 1
            val maxRounds = plan.optInt("maxRounds", 3).coerceIn(1, 5)

            if (round > maxRounds) {
                // 轮数用完：停，并如实记下来。
                WakeUpPlayer.stop(context)
                WakeupScheduler.clearPlan(context, planId)
                WakeupScheduler.postOutcome(context, planId, "响了 $maxRounds 轮都没起来，已停止")
                return
            }

            WakeupScheduler.recordRound(context, planId, round)
            WakeUpPlayer.start(
                context = context,
                planId = planId,
                audioDataUrl = plan.optString("audioDataUrl", ""),
                speech = plan.optString("speech", "该起床了"),
                volume = plan.optInt("volume", 80),
                rampSeconds = plan.optInt("rampSeconds", 20),
                vibrate = plan.optBoolean("vibrate", true),
                playTone = plan.optBoolean("playAlarmTone", true),
            )
            postWakeNotification(context, planId, plan.optString("characterName", ""), plan.optString("speech", ""))

            // 排下一轮：不在这里等待，交给闹钟。
            if (round < maxRounds) {
                val everyMinutes = plan.optInt("repeatEveryMinutes", 2).coerceIn(1, 15)
                WakeupScheduler.schedule(
                    context,
                    planId,
                    System.currentTimeMillis() + everyMinutes * 60_000L,
                )
            }
        } catch (t: Throwable) {
            WakeupScheduler.postOutcome(context, planId, "执行异常：${t.message ?: t::class.java.simpleName}")
        } finally {
            runCatching { if (wakeLock?.isHeld == true) wakeLock.release() }
        }
    }

    /**
     * 叫醒通知：带一个「我起来了」按钮。
     *
     * 为什么必须有这个按钮：用户半梦半醒时最可能做的就是关掉通知，
     * 而"关掉通知"与"我起来了"是两件事——后者要能立刻停响、并且让角色知道
     * 他是自己起来的（角色对这件事的反应应该不一样）。
     */
    private fun postWakeNotification(context: Context, planId: String, characterName: String, speech: String) {
        runCatching {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                ?: return@runCatching
            val channelId = "wakeup_call"
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val channel = NotificationChannel(
                    channelId,
                    "起床叫醒",
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply {
                    description = "到了起床时间叫你"
                    setShowBadge(false)
                }
                nm.createNotificationChannel(channel)
            }

            val stopIntent = Intent(context, WakeupActionReceiver::class.java)
                .setAction(WakeupActionReceiver.ACTION_DONE)
                .putExtra("planId", planId)
            val stopPending = PendingIntent.getBroadcast(
                context,
                ("done_$planId").hashCode() and 0x7FFFFFFF,
                stopIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

            // 点通知本身打开 App（用户可能想直接进面板关掉叫醒）。
            val openIntent = Intent(context, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            }
            val openPending = PendingIntent.getActivity(
                context,
                0,
                openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

            val title = if (characterName.isNotBlank()) "${characterName} 在叫你" else "该起床了"
            val notification = androidx.core.app.NotificationCompat.Builder(context, channelId)
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle(title)
                .setContentText(speech.ifBlank { "该起床了" })
                .setStyle(androidx.core.app.NotificationCompat.BigTextStyle().bigText(speech))
                .setPriority(androidx.core.app.NotificationCompat.PRIORITY_HIGH)
                .setCategory(Notification.CATEGORY_ALARM)
                .setAutoCancel(false)
                .setOngoing(true)
                .setContentIntent(openPending)
                .addAction(0, "我起来了", stopPending)
                .build()
            nm.notify(NOTIFICATION_ID, notification)
        }
    }

    companion object {
        const val NOTIFICATION_ID = 8031
    }
}
