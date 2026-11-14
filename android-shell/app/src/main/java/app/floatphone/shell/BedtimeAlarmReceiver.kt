package app.floatphone.shell

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import org.json.JSONObject

/**
 * 睡前锁的触发点：闹钟响了就执行锁定。
 *
 * 这条链路是「App 不在前台、甚至进程已被回收」时唯一能跑通的路：
 *   AlarmManager（精确闹钟）→ BedtimeAlarmReceiver → LockGuard
 *
 * 判定在哪做：全部交给 LockGuard.decideBedtimeLock()，这里只负责叫醒和重排。
 * 原因和别处一致——只保留一个决策点，否则网页侧和原生侧的判断迟早不一致，
 * 而这类不一致的表现往往是「明明该锁却没锁」。
 *
 * 三条必须守住的地方：
 *   ① **先重排下一天，再判定**。判定里任何一步抛异常都不能让闹钟链断掉，
 *      断了就是「静默失效」：功能看起来开着，实际永远不响了。
 *   ② 拿 WakeLock 再干活：Doze 下闹钟唤醒了但 CPU 可能立刻又睡回去，
 *      不持锁的话判定跑到一半就断了。超时设 60 秒，绝不长期持有。
 *   ③ 拿不到无障碍（锁机通道不可用）时如实返回，不假装成功。
 */
class BedtimeAlarmReceiver : BroadcastReceiver() {

    private val wakeLockTimeoutMs = 60_000L

    override fun onReceive(context: Context, intent: Intent) {
        // ① 先把明天那一次排上，再处理这一次。
        runCatching { BedtimeScheduler.scheduleNext(context) }

        // ② 持锁干活，避免判定跑到一半被系统掐断。
        //
        // 这里**必须显式标注类型**：`runCatching { ... }.getOrNull()` 会推断成
        // lambda 最后一句的类型，而 apply 的最后一句是 acquire(...)（返回 Unit），
        // 于是 lock 会被推成 Unit?，下面 lock.isHeld / lock.release() 直接编译失败。
        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val lock: PowerManager.WakeLock? = try {
            power?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "float:bedtime-lock")?.apply {
                setReferenceCounted(false)
                acquire(wakeLockTimeoutMs)
            }
        } catch (t: Throwable) {
            null
        }

        try {
            val guard = CallControlService.instance?.currentLockGuard()
            if (guard == null) {
                // 无障碍服务没在跑：锁机根本不可能生效。如实记下来，别让用户以为锁上了。
                BedtimeScheduler.markOutcome(context, "无障碍服务未连接，这一晚没能锁上")
                return
            }
            val result = guard.runBedtimeLock()
            BedtimeScheduler.markOutcome(context, result.optString("message", ""))
            // 真的锁上了才发通知；没锁上由网页面板显示原因，不打扰半夜的用户。
            if (result.optBoolean("locked", false)) {
                BedtimeScheduler.postLockedNotification(context)
            }
        } catch (t: Throwable) {
            BedtimeScheduler.markOutcome(context, "执行异常：${t.message ?: t::class.java.simpleName}")
        } finally {
            runCatching { if (lock?.isHeld == true) lock.release() }
        }
    }
}
