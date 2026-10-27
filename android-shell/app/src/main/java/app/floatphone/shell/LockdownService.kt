package app.floatphone.shell

import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 锁机浮层：角色把手机「收走」时盖住真机。
 *
 * 网页负责判断（该不该锁、锁多久、锁哪些应用），本服务只负责执行：
 *   · 用 TYPE_APPLICATION_OVERLAY 铺一层全屏浮层，盖住用户当前在看的任何 App；
 *   · 按前台包名决定「这一屏要不要盖」——指定应用锁只盖那几个，整机锁除豁免外全盖；
 *   · 计时以网页下发的绝对到点时间 endsAt 为准，自己每秒对表，到点自动收。
 *
 * 三条硬性边界（改这个文件前先读）：
 *  1. **用户随时能出去**：浮层上永远有一个「现在解除」入口，不需要密码、不需要角色同意。
 *     这是用户请角色管自己的自律工具，不是把用户关起来的东西。
 *  2. **不做隐形拦截**：浮层一直是可见的，被盖住时用户看得见是谁、为什么、还剩多久。
 *     不做「偷偷把 App 杀掉」或「静默返回桌面」这类没有痕迹的行为。
 *  3. **豁免清单优先**：电话、设置这些应用永远放行——手机被收走不能导致用户打不了电话。
 *     系统界面（桌面、输入法、本 App 自己）一律放行，否则用户连解锁都做不到。
 *
 * 为什么是「预热常驻 + 按需显示」：
 *   Android 12+ 禁止 App 从后台启动前台服务，而锁机恰恰是后台触发的（用户正在
 *   别的 App 里）。所以由网页在 App 前台时把服务暖起来常驻，真正锁定只是显示一个
 *   已经存在的窗口。与 CheckInService 同一套路。
 */
class LockdownService : Service() {

    companion object {
        private const val CH_ID = "shell_lockdown"
        private const val NOTIF_ID = 4211
        private const val PREFS = "lockdown_prefs"
        private const val KEY_PAYLOAD = "active_payload"
        private const val TICK_MS = 1000L

        @Volatile
        private var instance: LockdownService? = null

        /** 前台 App 包名，由无障碍服务持续更新；没有无障碍时是空串。 */
        @Volatile
        private var foregroundPackage: String = ""

        fun onForegroundApp(pkg: String) {
            if (pkg.isEmpty() || pkg == foregroundPackage) return
            foregroundPackage = pkg
            instance?.let { svc ->
                svc.handler.post { svc.applyVisibility() }
            }
        }

        /** 当前是否有活动的锁定（网页据此判断原生侧还锁着没有）。 */
        fun isActive(): Boolean = instance?.payload != null

        /**
         * 预热服务：App 在前台时由网页调用。已存在则不重复启动。
         * 返回 false 表示没有浮窗权限，锁真机根本做不了。
         */
        fun prepare(context: Context): Boolean {
            if (instance != null) return true
            if (!Settings.canDrawOverlays(context)) return false
            val intent = Intent(context, LockdownService::class.java)
            return runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
                true
            }.getOrDefault(false)
        }

        /**
         * 下发/更新一次锁定。payload 为 null 时收掉浮层。
         *
         * 同一个 id 视为同一次锁定：只更新内容（剩余时间、留言），不重建窗口，
         * 避免浮层闪一下。
         */
        fun apply(context: Context, payload: JSONObject?) {
            val svc = instance
            if (svc == null) {
                if (payload != null && prepare(context)) {
                    // 服务刚起来，onStartCommand 之前先存一份，起来后自取
                    storePayload(context, payload)
                }
                return
            }
            svc.handler.post { svc.setPayload(payload) }
        }

        fun stop(context: Context) {
            storePayload(context, null)
            instance?.let { svc ->
                svc.handler.post { svc.teardown(userInitiated = false) }
            }
            runCatching { context.stopService(Intent(context, LockdownService::class.java)) }
        }

        private fun prefs(context: Context): SharedPreferences =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        private fun storePayload(context: Context, payload: JSONObject?) {
            val editor = prefs(context).edit()
            if (payload == null) editor.remove(KEY_PAYLOAD) else editor.putString(KEY_PAYLOAD, payload.toString())
            editor.apply()
        }

        /** 读回上次存下的锁定（进程被杀后重建时用）。 */
        fun loadStoredPayload(context: Context): JSONObject? = runCatching {
            prefs(context).getString(KEY_PAYLOAD, null)?.let { JSONObject(it) }
        }.getOrNull()
    }

    private val handler = Handler(Looper.getMainLooper())
    private var windowManager: WindowManager? = null
    private var rootView: FrameLayout? = null
    private var payload: JSONObject? = null

    private var titleView: TextView? = null
    private var messageView: TextView? = null
    private var clockView: TextView? = null
    private var subView: TextView? = null
    private var confirmButton: TextView? = null

    /** 上一次「要不要显示」的决定，避免每秒重复 addView/removeView */
    private var shown = false

    private val ticker = object : Runnable {
        override fun run() {
            if (payload == null) return
            updateClock()
            // 到点：按绝对时间自己收，不等网页（网页可能已经被系统冻结）
            val endsAt = payload?.optLong("endsAt", 0L) ?: 0L
            if (endsAt > 0 && System.currentTimeMillis() >= endsAt) {
                teardown(userInitiated = false)
                return
            }
            handler.postDelayed(this, TICK_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        startForegroundCompat()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 进程被系统回收后重建：把上次的锁定接着显示（用户没主动解除就还算数）
        if (payload == null) {
            loadStoredPayload(this)?.let { setPayload(it) }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        instance = null
        handler.removeCallbacksAndMessages(null)
        removeOverlay()
        super.onDestroy()
    }

    // ── 内容 ──

    private fun setPayload(next: JSONObject?) {
        payload = next
        storePayload(this, next)
        if (next == null) {
            teardown(userInitiated = false)
            return
        }
        applyVisibility()
        handler.removeCallbacks(ticker)
        handler.post(ticker)
        // 通知文案跟着状态走（预热待命 vs 正在锁）
        runCatching { startForeground(NOTIF_ID, buildNotification()) }
    }

    /** 依据「当前前台是谁 + 这次锁的范围」决定要不要盖。 */
    private fun applyVisibility() {
        val data = payload
        if (data == null) {
            removeOverlay()
            return
        }
        if (shouldCover(data, foregroundPackage)) {
            showOverlay(data)
        } else {
            removeOverlay()
        }
    }

    private fun shouldCover(data: JSONObject, pkg: String): Boolean {
        // 本 App 自己永远不盖：用户得能回到小手机上看是谁锁的、还剩多久。
        if (pkg == packageName) return false

        val blockAll = data.optBoolean("blockAllApps", false)
        // 没开无障碍就不知道前台是哪个 App。这时整机锁照样生效（就是要它盖住一切），
        // 而应用锁无从判断，只能放行——否则会变成「什么都没锁上还自以为锁了」。
        if (pkg.isEmpty()) return blockAll

        if (isSystemUi(pkg)) return false
        if (isExempt(data, pkg)) return false
        if (blockAll) return true

        val apps = data.optJSONArray("apps") ?: return false
        if (apps.length() == 0) return false
        val label = resolveLabel(pkg)
        for (i in 0 until apps.length()) {
            if (matchesName(apps.optString(i, ""), label, pkg)) return true
        }
        return false
    }

    private fun isExempt(data: JSONObject, pkg: String): Boolean {
        val exempt = data.optJSONArray("exemptApps") ?: return false
        val label = resolveLabel(pkg)
        for (i in 0 until exempt.length()) {
            if (matchesName(exempt.optString(i, ""), label, pkg)) return true
        }
        return false
    }

    /** 网页侧存的是应用显示名；用 label 对比，也允许直接写包名。 */
    private fun matchesName(name: String, label: String, pkg: String): Boolean {
        if (name.isEmpty()) return false
        if (name == label || name == pkg) return true
        return label.isNotEmpty() && (label.contains(name) || name.contains(label))
    }

    /**
     * 系统界面一律放行：桌面、系统 UI、设置、输入法、本 App。
     * 盖住这些，用户连解锁屏幕、输入密码、回到小手机的路都没有了。
     */
    private fun isSystemUi(pkg: String): Boolean {
        if (pkg == "android") return true
        if (pkg == packageName) return true
        val systemPrefixes = listOf(
            "com.android.systemui",
            "com.android.launcher",
            "com.android.settings",
            "com.android.packageinstaller",
            "com.android.permissioncontroller",
        )
        if (systemPrefixes.any { pkg.startsWith(it) }) return true
        // 输入法：盖住它用户就没法在任何界面上打字（包括输入解锁确认）
        return runCatching {
            val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            imm.enabledInputMethodList.any { it.packageName == pkg }
        }.getOrDefault(false)
    }

    private fun resolveLabel(pkg: String): String = runCatching {
        val pm = packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    }.getOrDefault("")

    // ── 浮层 ──

    @SuppressLint("ClickableViewAccessibility")
    private fun showOverlay(data: JSONObject) {
        if (shown && rootView != null) {
            refreshTexts(data)
            return
        }
        removeOverlay()
        val wm = windowManager ?: return

        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#F00B0B12"))
            // 吞掉所有触摸：浮层期间不允许操作底下的应用
            setOnTouchListener { _, _ -> true }
        }

        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(26), dp(32), dp(26), dp(28))
        }

        val badge = TextView(this).apply {
            text = "已锁定"
            setTextColor(Color.parseColor("#8CFFFFFF"))
            textSize = 11f
            letterSpacing = 0.18f
            gravity = Gravity.CENTER
        }

        val title = TextView(this).apply {
            setTextColor(Color.parseColor("#E6F4F1EA"))
            textSize = 14f
            gravity = Gravity.CENTER
        }

        val message = TextView(this).apply {
            setTextColor(Color.parseColor("#F2F4F1EA"))
            textSize = 16f
            gravity = Gravity.CENTER
            setLineSpacing(dpF(8f), 1f)
            maxLines = 12
            setPadding(0, dp(18), 0, dp(18))
        }

        val clock = TextView(this).apply {
            setTextColor(Color.parseColor("#F2F4F1EA"))
            typeface = Typeface.create("sans-serif-light", Typeface.NORMAL)
            textSize = 44f
            gravity = Gravity.CENTER
        }

        val sub = TextView(this).apply {
            setTextColor(Color.parseColor("#8CFFFFFF"))
            textSize = 12f
            gravity = Gravity.CENTER
            setPadding(0, dp(8), 0, 0)
        }

        val confirm = TextView(this).apply {
            text = "我记住了"
            setTextColor(Color.WHITE)
            textSize = 15f
            gravity = Gravity.CENTER
            setPadding(dp(20), dp(14), dp(20), dp(14))
            background = GradientDrawable().apply {
                cornerRadius = dpF(999f)
                setColor(Color.parseColor("#1AFFFFFF"))
                setStroke(dp(1), Color.parseColor("#38FFFFFF"))
            }
            isClickable = true
            setOnClickListener { teardown(userInitiated = true) }
        }

        val release = TextView(this).apply {
            text = "现在解除"
            setTextColor(Color.parseColor("#5CFFFFFF"))
            textSize = 12f
            gravity = Gravity.CENTER
            setPadding(dp(12), dp(14), dp(12), dp(10))
            isClickable = true
            setOnClickListener { teardown(userInitiated = true) }
        }

        val note = TextView(this).apply {
            text = "这是你自己让 TA 管你的 · 范围与时长上限在「设置 → 锁机」里改"
            setTextColor(Color.parseColor("#47FFFFFF"))
            textSize = 10.5f
            gravity = Gravity.CENTER
            setPadding(0, dp(6), 0, 0)
        }

        column.addView(badge)
        column.addView(title, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(14) })
        column.addView(message)
        column.addView(clock)
        column.addView(sub)
        column.addView(confirm, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(30) })
        column.addView(release)
        column.addView(note)

        root.addView(column, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER))

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            } else {
                @Suppress("DEPRECATION")
                WindowManager.LayoutParams.TYPE_PHONE
            },
            // 关键：能盖住整个屏幕、能接收触摸（必须拦住底下 App 的操作）。
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            PixelFormat.OPAQUE,
        ).apply {
            gravity = Gravity.CENTER
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }

        rootView = root
        titleView = title
        messageView = message
        clockView = clock
        subView = sub
        confirmButton = confirm

        val added = runCatching { wm.addView(root, params) }.isSuccess
        if (!added) {
            rootView = null
            return
        }
        shown = true
        refreshTexts(data)
    }

    private fun refreshTexts(data: JSONObject) {
        val message = data.optString("message", "").trim()
        messageView?.text = message
        messageView?.visibility = if (message.isEmpty()) View.GONE else View.VISIBLE
        confirmButton?.visibility = if (data.optBoolean("allowConfirm", true)) View.VISIBLE else View.GONE
        titleView?.text = "${data.optString("characterName", "角色")} 收走了你的手机"
        updateClock()
    }

    private fun updateClock() {
        val data = payload ?: return
        val endsAt = data.optLong("endsAt", 0L)
        if (endsAt <= 0L) {
            clockView?.text = "等你确认"
            clockView?.textSize = 28f
            subView?.text = "TA 想听你说一句「我记住了」"
            return
        }
        val remainMs = (endsAt - System.currentTimeMillis()).coerceAtLeast(0L)
        val totalSec = (remainMs + 999) / 1000
        val h = totalSec / 3600
        val m = (totalSec % 3600) / 60
        val s = totalSec % 60
        clockView?.text = if (h > 0) String.format(Locale.US, "%d:%02d:%02d", h, m, s)
        else String.format(Locale.US, "%02d:%02d", m, s)
        clockView?.textSize = if (h > 0) 38f else 44f

        val startedAt = data.optLong("startedAt", 0L)
        val fmt = SimpleDateFormat("HH:mm", Locale.getDefault())
        subView?.text = if (startedAt > 0) {
            "${fmt.format(Date(startedAt))} 起 · ${fmt.format(Date(endsAt))} 还你"
        } else {
            "${fmt.format(Date(endsAt))} 还你"
        }
    }

    private fun removeOverlay() {
        val root = rootView ?: return
        runCatching { windowManager?.removeView(root) }
        rootView = null
        titleView = null
        messageView = null
        clockView = null
        subView = null
        confirmButton = null
        shown = false
    }

    private fun teardown(userInitiated: Boolean) {
        handler.removeCallbacksAndMessages(null)
        removeOverlay()
        payload = null
        storePayload(this, null)
        if (userInitiated) {
            // 告诉网页「用户点头了 / 用户自己解除了」，让状态与历史在网页侧落地
            ShellBus.dispatchLockdownEvent("unlocked")
        } else {
            ShellBus.dispatchLockdownEvent("stopped")
        }
        stopForegroundCompat()
        stopSelf()
    }

    // ── 前台通知（保活 + 让用户知道锁定还在） ──

    private fun startForegroundCompat() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java)
        runCatching {
            nm.createNotificationChannel(
                NotificationChannel(CH_ID, "锁机", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "角色锁住手机时的常驻提示"
                    setShowBadge(false)
                },
            )
        }
        runCatching { startForeground(NOTIF_ID, buildNotification()) }
    }

    /**
     * 常驻通知：服务是预热常驻的，没在锁的时候也得有一条（Android 要求前台服务必须有），
     * 但文案必须区分「正在锁」和「随时待命」——把待命说成「正在锁」，用户会以为
     * 角色在偷偷盯着他。
     */
    private fun buildNotification(): android.app.Notification {
        val data = payload
        val intent = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pi = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val title: String
        val text: String
        if (data != null) {
            title = "锁机中"
            val name = data.optString("characterName", "角色")
            text = if (data.optLong("endsAt", 0L) > 0L) "$name 收走了你的手机，到点自动还你" else "$name 在等你确认"
        } else {
            title = "锁机待命"
            text = "角色可以随时把手机收走 · 可在设置里关掉"
        }
        return NotificationCompat.Builder(this, CH_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_stat)
            .setOngoing(true)
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        } else {
            @Suppress("DEPRECATION")
            runCatching { stopForeground(true) }
        }
    }

    // ── 尺寸 ──

    private fun dp(value: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

    private fun dpF(value: Float): Float =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, resources.displayMetrics)
}
