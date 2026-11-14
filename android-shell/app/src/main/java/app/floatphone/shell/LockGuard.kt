package app.floatphone.shell

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject

/**
 * 锁机守护：白名单硬锁。
 *
 * 为什么必须做在原生层：自定义 APP 跑在 iframe 沙盒里，只能管住自己，
 * 管不住抖音、微信这些别的应用。只有无障碍服务 + 系统级浮层能真正拦住。
 *
 * 工作方式：
 * - 白名单模式下，前台应用不在名单里就盖一层全屏遮罩（TYPE_ACCESSIBILITY_OVERLAY），
 *   遮罩上只有倒计时，点不掉、滑不走；
 * - 电话、系统设置、本应用始终放行。**「系统设置」必须永远可达**——那是用户
 *   关掉无障碍服务的唯一逃生门，也是防止把自己彻底锁死的最后保险；
 * - 到 lockedUntil 自动解锁，遮罩自行消失；
 * - 配置由网页下发（SharedPreferences "native_lock_guard"），原生只执行不判断。
 *
 * 不做的事：不记录应用使用内容、不读取界面文字、不上传任何数据。
 */
class LockGuard(private val service: AccessibilityService) {

    companion object {
        private const val PREFS = "native_lock_guard"
        private const val MAX_LOCK_MS = 8L * 60 * 60 * 1000 // 单次锁定上限 8 小时

        /** 锁机事件推给网页：'shell-lock' 事件，detail.action = lock / unlock / blocked。 */
        fun dispatch(action: String, payload: JSONObject = JSONObject()): Unit {
            val detail = JSONObject(payload.toString()).put("action", action)
            val literal = JSONObject.quote(detail.toString())
            ShellBus.evalJs(
                "window.dispatchEvent(new CustomEvent('shell-lock',{detail:JSON.parse($literal)}))"
            )
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var overlay: View? = null
    private var countdown: TextView? = null
    private var reasonView: TextView? = null

    /** 当前是否处于锁定状态（每次从 prefs 读，避免与网页配置不同步）。 */
    fun isLocked(): Boolean {
        // "是否正在锁" 只看 lockedUntil（未来时间戳）。
        // 刻意不与 enabled 混用：enabled 表示"锁机功能已启用/白名单已就绪"，
        // 如果把它也算进锁定条件，网页只是保存一次设置就会立刻把人锁住。
        val until = prefs().getLong("lockedUntil", 0L)
        if (until <= 0L) return false
        if (System.currentTimeMillis() >= until) {
            // 到点自动解锁，顺手清掉状态
            prefs().edit().putLong("lockedUntil", 0L).apply()
            return false
        }
        return true
    }

    fun lockedUntil(): Long = prefs().getLong("lockedUntil", 0L)

    fun lockReason(): String = prefs().getString("reason", "").orEmpty()

    fun lockSource(): String = prefs().getString("source", "").orEmpty()

    private fun prefs() = service.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** 网页下发完整配置：{enabled, whitelist:[包名], reason, source}。 */
    fun configure(json: String): Boolean = runCatching {
        val config = JSONObject(json)
        val editor = prefs().edit()
        if (config.has("enabled")) editor.putBoolean("enabled", config.optBoolean("enabled", false))
        if (config.has("whitelist")) {
            val list = config.optJSONArray("whitelist") ?: JSONArray()
            val cleaned = JSONArray()
            for (i in 0 until list.length()) {
                val pkg = list.optString(i).trim()
                if (pkg.isNotEmpty()) cleaned.put(pkg)
            }
            editor.putString("whitelist", cleaned.toString())
        }
        if (config.has("reason")) editor.putString("reason", config.optString("reason", "").take(200))
        if (config.has("source")) editor.putString("source", config.optString("source", "").take(80))
        editor.apply()
        // 配置变了立刻重新判定一次：关掉锁应该马上放人。
        // 注意调的是本类的 onForegroundPackageChanged，不是 service 的
        // （AccessibilityService 上没有这个方法，写成 service.xxx 会编译失败）。
        onForegroundPackageChanged(lastPackage)
        true
    }.getOrDefault(false)

    /** 立刻锁定到指定时刻（毫秒时间戳）。 */
    fun lock(untilMs: Long, reason: String, source: String): JSONObject {
        val now = System.currentTimeMillis()
        val capped = untilMs.coerceIn(now + 60_000L, now + MAX_LOCK_MS)
        prefs().edit()
            .putBoolean("enabled", true)
            .putLong("lockedUntil", capped)
            .putString("reason", reason.take(200))
            .putString("source", source.take(80))
            .apply()
        dispatch("lock", JSONObject().put("until", capped).put("reason", reason).put("source", source))
        onForegroundPackageChanged(lastPackage)
        return JSONObject()
            .put("ok", true)
            .put("until", capped)
            .put("minutes", (capped - now) / 60_000L)
    }

    /** 解锁（人工或到点）。 */
    fun unlock(source: String = "manual"): JSONObject {
        prefs().edit().putBoolean("enabled", false).putLong("lockedUntil", 0L).apply()
        hideOverlay()
        dispatch("unlock", JSONObject().put("source", source))
        return JSONObject().put("ok", true)
    }

    /** 状态摘要，网页用来回显。 */
    fun statusJson(): JSONObject {
        val locked = isLocked()
        val until = lockedUntil()
        return JSONObject()
            .put("enabled", prefs().getBoolean("enabled", false))
            .put("locked", locked)
            .put("lockedUntil", if (locked) until else 0L)
            .put("remainingMs", if (locked) (until - System.currentTimeMillis()).coerceAtLeast(0L) else 0L)
            .put("reason", lockReason())
            .put("source", lockSource())
            .put("whitelist", prefs().getString("whitelist", "[]"))
    }

    private fun whitelist(): Set<String> {
        val raw = prefs().getString("whitelist", "[]") ?: "[]"
        val result = mutableSetOf<String>()
        runCatching {
            val array = JSONArray(raw)
            for (i in 0 until array.length()) {
                val pkg = array.optString(i).trim()
                if (pkg.isNotEmpty()) result.add(pkg)
            }
        }
        return result
    }

    /**
     * 永不拦截的包名：本应用、电话、系统设置、系统 UI。
     *
     * 「系统设置」是刻意保留的逃生门：用户可以从中关掉无障碍服务来解除锁定。
     * 不做成绝对不可解 —— 真出急事时，把人锁在外面比"没管住自己"严重得多。
     */
    private fun alwaysAllowed(): Set<String> {
        val result = mutableSetOf(
            service.packageName,
            "com.android.systemui",
            "com.android.settings",
        )
        runCatching {
            val dial = Intent(Intent.ACTION_DIAL)
            service.packageManager.resolveActivity(dial, 0)?.activityInfo?.packageName?.let { result.add(it) }
        }
        runCatching {
            val settingsIntent = Intent(Settings.ACTION_SETTINGS)
            service.packageManager.resolveActivity(settingsIntent, 0)?.activityInfo?.packageName?.let { result.add(it) }
        }
        runCatching {
            // 紧急拨号与来电界面
            val emergency = Intent(Intent.ACTION_CALL_BUTTON)
            service.packageManager.resolveActivity(emergency, 0)?.activityInfo?.packageName?.let { result.add(it) }
        }
        return result
    }

    /** 由无障碍事件驱动：前台应用变化时调用。 */
    fun onForegroundPackageChanged(pkg: String) {
        lastPackage = pkg
        if (pkg.isBlank()) return
        if (!isLocked()) {
            hideOverlay()
            return
        }
        if (pkg in whitelist() || pkg in alwaysAllowed()) {
            hideOverlay()
            return
        }
        showOverlay()
        dispatch("blocked", JSONObject().put("package", pkg).put("until", lockedUntil()))
    }

    @Volatile
    private var lastPackage: String = ""

    /** 正在排队添加浮层（防止连续的前台事件重复 addView）。 */
    @Volatile
    private var pendingShow = false

    private fun showOverlay() {
        if (overlay != null) {
            refreshCountdown()
            return
        }
        if (pendingShow) return
        pendingShow = true
        handler.post {
            runCatching {
                val wm = service.getSystemService(Context.WINDOW_SERVICE) as WindowManager
                val root = buildOverlayView()
                val params = WindowManager.LayoutParams(
                    WindowManager.LayoutParams.MATCH_PARENT,
                    WindowManager.LayoutParams.MATCH_PARENT,
                    // TYPE_ACCESSIBILITY_OVERLAY 由无障碍服务添加，不需要 SYSTEM_ALERT_WINDOW
                    WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                    // 关键：**不能**加 FLAG_NOT_FOCUSABLE / FLAG_NOT_TOUCHABLE。
                    // 加了的话触摸会直接穿透到下面那个应用，遮罩只挡住画面、
                    // 手指照样能操作抖音——那不是硬锁。
                    // 这里刻意让它可获取焦点并吃掉所有触摸，才算真正拦住。
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        or WindowManager.LayoutParams.FLAG_LAYOUT_INSET_DECOR,
                    android.graphics.PixelFormat.OPAQUE,
                )
                params.gravity = Gravity.CENTER
                // 浮层没加成功前保持 pendingShow=true，成功后交给 overlay 接管
                wm.addView(root, params)
                overlay = root
                pendingShow = false
                startTicking()
            }.onFailure {
                // 浮层加不上（厂商限制）时不要静默：让人知道锁机没生效
                pendingShow = false
                dispatch("error", JSONObject().put("message", it.message ?: "无法显示锁机遮罩"))
            }
        }
    }

    private fun hideOverlay() {
        handler.post {
            stopTicking()
            // 标志位先清：即使下面的 removeView 抛异常，逻辑上也不再认为"浮层还在"，
            // 避免 showOverlay 因为 overlay != null 而永远走"已存在，只刷新倒计时"分支，
            // 结果是遮罩永远挂不掉。
            pendingShow = false
            val view = overlay ?: return@post
            overlay = null
            countdown = null
            reasonView = null
            runCatching {
                val wm = service.getSystemService(Context.WINDOW_SERVICE) as WindowManager
                wm.removeView(view)
            }
        }
    }

    private fun buildOverlayView(): View {
        val ctx = service
        val root = FrameLayout(ctx).apply {
            setBackgroundColor(Color.parseColor("#F2F0EA"))
            isClickable = true
        }

        val column = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(56, 56, 56, 56)
        }

        column.addView(TextView(ctx).apply {
            text = "现在不能玩手机"
            setTextColor(Color.parseColor("#221F1A"))
            textSize = 26f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            gravity = Gravity.CENTER
        })

        column.addView(TextView(ctx).apply {
            text = "还剩"
            setTextColor(Color.parseColor("#6B6255"))
            textSize = 13f
            gravity = Gravity.CENTER
            setPadding(0, 26, 0, 6)
        })

        val timer = TextView(ctx).apply {
            text = "--:--:--"
            setTextColor(Color.parseColor("#2B6A5B"))
            textSize = 40f
            typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
            gravity = Gravity.CENTER
        }
        countdown = timer
        column.addView(timer)

        val reason = TextView(ctx).apply {
            text = ""
            setTextColor(Color.parseColor("#6B6255"))
            textSize = 14f
            gravity = Gravity.CENTER
            setPadding(0, 30, 0, 0)
            setLineSpacing(0f, 1.5f)
        }
        reasonView = reason
        column.addView(reason)

        column.addView(TextView(ctx).apply {
            text = "电话、系统设置仍可使用"
            setTextColor(Color.parseColor("#A89D8B"))
            textSize = 12f
            gravity = Gravity.CENTER
            setPadding(0, 46, 0, 0)
        })

        root.addView(column, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.CENTER,
        ))
        refreshCountdown()
        return root
    }

    private val ticker = object : Runnable {
        override fun run() {
            if (!isLocked()) {
                hideOverlay()
                dispatch("unlock", JSONObject().put("source", "expired"))
                return
            }
            refreshCountdown()
            handler.postDelayed(this, 1000L)
        }
    }

    private fun startTicking() {
        handler.removeCallbacks(ticker)
        handler.post(ticker)
    }

    private fun stopTicking() {
        handler.removeCallbacks(ticker)
    }

    private fun refreshCountdown() {
        val remaining = (lockedUntil() - System.currentTimeMillis()).coerceAtLeast(0L)
        val total = remaining / 1000
        val h = total / 3600
        val m = (total % 3600) / 60
        val s = total % 60
        // 注意：Kotlin 不允许把赋值目标写成安全调用（`a?.b = c` 是编译错误），
        // 必须用 let 包一层。上一版就是这么炸的。
        val formatted = String.format(java.util.Locale.US, "%02d:%02d:%02d", h, m, s)
        countdown?.let { it.text = formatted }
        val why = lockReason()
        reasonView?.let { it.text = if (why.isNotBlank()) why else "" }
    }

    fun shutdown() {
        hideOverlay()
    }
}
