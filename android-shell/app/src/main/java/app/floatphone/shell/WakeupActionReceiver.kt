package app.floatphone.shell

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 叫醒通知上的动作（1.0.38）。
 *
 * 目前只有一件事：用户点「我起来了」。
 *
 * 为什么这个按钮值得单独做：
 *   半梦半醒时人的第一反应是"关掉通知"，但那和"我起来了"是两件事。
 *   前者只是让声音停下，后者是用户明确表态「我起」。记录下来，
 *   面板上就能分清"他自己起来的"和"一直没起来"，
 *   角色事后也可以据此说不同的话。
 */
class WakeupActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_DONE) return
        val planId = intent.getStringExtra("planId").orEmpty()

        // 停声、停振动、还原音量。
        WakeUpPlayer.stop(context)
        // 撤掉那条常驻通知（ongoing=true 的通知必须显式 cancel）。
        runCatching {
            context.getSystemService(NotificationManager::class.java)
                ?.cancel(WakeupAlarmReceiver.NOTIFICATION_ID)
        }

        if (planId.isNotBlank()) {
            // 先取消可能的下一轮闹钟，再清计划——顺序反了的话，
            // 下一轮可能在清空之后又响一次（它靠 planId 找计划，找不到才不响，
            // 但那一刻已经进了 onReceive）。
            WakeupScheduler.cancel(context, planId)
            WakeupScheduler.postOutcome(context, planId, "用户点了「我起来了」")
            WakeupScheduler.clearPlan(context, planId)
        }
    }

    companion object {
        const val ACTION_DONE = "app.floatphone.shell.WAKEUP_DONE"
    }
}
