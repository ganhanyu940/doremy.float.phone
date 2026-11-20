package app.floatphone.shell

import android.content.Context
import android.os.Handler
import android.os.PowerManager
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar

/** Opt-in, device-local focus rules. No model call and no screen contents. */
internal class FocusGuard(
    private val context: Context,
    private val handler: Handler,
    private val allowed: (String) -> Boolean,
    private val refresh: () -> Unit,
) {
    private val prefs = context.getSharedPreferences("native_focus_guard", Context.MODE_PRIVATE)
    private var current = ""
    private var began = 0L
    private var warned = false
    private var closed = false
    private val tick = Runnable { evaluate() }

    private fun config() = runCatching { JSONObject(prefs.getString("config", "{}").orEmpty()) }.getOrElse { JSONObject() }
    private fun blocks() = runCatching { JSONObject(prefs.getString("blocks", "{}").orEmpty()) }.getOrElse { JSONObject() }

    fun configure(input: JSONObject) {
        val packages = JSONArray()
        val source = input.optJSONArray("packages") ?: JSONArray()
        for (i in 0 until minOf(source.length(), 200)) {
            val pkg = source.optString(i)
            if (pkg.matches(Regex("[A-Za-z0-9_.]{1,200}"))) packages.put(pkg)
        }
        val previous = config()
        val next = JSONObject()
            .put("enabled", input.optBoolean("enabled") && packages.length() > 0)
            .put("packages", packages)
            .put("start", input.optInt("start", 480).coerceIn(0, 1439))
            .put("end", input.optInt("end", 1320).coerceIn(0, 1439))
            .put("until", input.optLong("until").coerceIn(0L, System.currentTimeMillis() + 29L * 86_400_000L))
        if (previous.toString() != next.toString()) {
            prefs.edit().putString("config", next.toString()).remove("blocks").remove("lastEvent").apply()
            handler.post { resetDwell(); evaluate() }
        }
    }

    fun status(): JSONObject {
        val cfg = config()
        return JSONObject()
            .put("enabled", cfg.optBoolean("enabled"))
            .put("packages", cfg.optJSONArray("packages") ?: JSONArray())
            .put("start", cfg.optInt("start", 480))
            .put("end", cfg.optInt("end", 1320))
            .put("until", cfg.optLong("until"))
            .put("lastEvent", runCatching { JSONObject(prefs.getString("lastEvent", "{}").orEmpty()) }.getOrElse { JSONObject() })
    }

    private fun eligible(cfg: JSONObject, pkg: String, now: Long): Boolean {
        if (pkg.isBlank() || !cfg.optBoolean("enabled") || now >= cfg.optLong("until") || allowed(pkg)) return false
        val cal = Calendar.getInstance().apply { timeInMillis = now }
        val minute = cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE)
        val start = cfg.optInt("start", 480)
        val end = cfg.optInt("end", 1320)
        val inside = if (start <= end) minute in start until end else minute >= start || minute < end
        if (!inside) return false
        val apps = cfg.optJSONArray("packages") ?: return false
        return (0 until apps.length()).any { apps.optString(it) == pkg }
    }

    fun blockedUntil(pkg: String): Long {
        val now = System.currentTimeMillis()
        if (!eligible(config(), pkg, now)) return 0L
        return blocks().optLong(pkg).takeIf { it > now } ?: 0L
    }

    fun foreground(pkg: String) {
        if (current != pkg) {
            current = pkg
            resetDwell()
        }
        evaluate()
    }

    fun resetDwell() {
        handler.removeCallbacks(tick)
        began = 0L
        warned = false
    }

    fun shutdown() {
        closed = true
        resetDwell()
    }

    private fun evaluate() {
        handler.removeCallbacks(tick)
        if (closed) return
        val now = System.currentTimeMillis()
        val cfg = config()
        val pkg = current
        if (!cfg.optBoolean("enabled") || now >= cfg.optLong("until")) { resetDwell(); return }
        val power = context.getSystemService(PowerManager::class.java) ?: return
        val keyguard = context.getSystemService(android.app.KeyguardManager::class.java)
        if (!power.isInteractive || keyguard?.isKeyguardLocked == true || !eligible(cfg, pkg, now)) {
            resetDwell()
            handler.postDelayed(tick, 5_000L)
            return
        }
        val deadline = blockedUntil(pkg)
        if (deadline > now) {
            resetDwell()
            // 单独重排：即使遮罩未能创建、没有遮罩倒计时，期满也能重新计时。
            handler.postDelayed(tick, minOf(5_000L, deadline - now))
            return
        }
        val elapsedNow = SystemClock.elapsedRealtime()
        if (began == 0L) began = elapsedNow
        val elapsed = elapsedNow - began
        if (!warned && elapsed >= 180_000L) {
            warned = true
            val delivered = notifyReminder()
            record(if (delivered) "reminder" else "reminder_unavailable", pkg, now)
        }
        if (elapsed >= 300_000L) {
            val next = blocks()
            val keys = next.keys()
            while (keys.hasNext()) if (next.optLong(keys.next()) <= now) keys.remove()
            next.put(pkg, minOf(now + 25L * 60_000L, cfg.optLong("until")))
            prefs.edit().putString("blocks", next.toString()).apply()
            resetDwell()
            handler.postDelayed(tick, 5_000L)
            refresh()
            return
        }
        handler.postDelayed(tick, minOf(5_000L, (if (warned) 300_000L else 180_000L) - elapsed).coerceAtLeast(1L))
    }

    fun shown(pkg: String) = record("blocked", pkg, System.currentTimeMillis())

    private fun record(event: String, pkg: String, now: Long) {
        val prior = status().optJSONObject("lastEvent")
        if (prior?.optString("event") == event && prior.optString("package") == pkg && now - prior.optLong("at") < 60_000L) return
        val label = runCatching {
            val pm = context.packageManager
            pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString().take(80)
        }.getOrDefault("")
        val data = JSONObject().put("event", event).put("package", pkg).put("label", label).put("at", now)
        prefs.edit().putString("lastEvent", data.toString()).apply()
    }

    private fun notifyReminder(): Boolean = runCatching {
        val nm = context.getSystemService(android.app.NotificationManager::class.java) ?: return@runCatching false
        val channel = "focus_guard_reminders"
        nm.createNotificationChannel(android.app.NotificationChannel(channel, "考前陪管提醒", android.app.NotificationManager.IMPORTANCE_DEFAULT))
        if (!nm.areNotificationsEnabled() || nm.getNotificationChannel(channel)?.importance == android.app.NotificationManager.IMPORTANCE_NONE) return@runCatching false
        nm.notify(8027, androidx.core.app.NotificationCompat.Builder(context, channel)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle("该回去复习了")
            .setContentText("已经用了 3 分钟。再用 2 分钟会暂停这个应用。")
            .setAutoCancel(true).build())
        true
    }.getOrDefault(false)
}
