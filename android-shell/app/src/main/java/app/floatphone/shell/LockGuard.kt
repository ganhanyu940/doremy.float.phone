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
import android.widget.ScrollView
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
 *   遮罩吃触摸、点不掉也滑不走，上面是倒计时 + 白名单内的应用入口 + 回到桌面；
 * - **桌面、电话、系统设置、本应用始终放行**。桌面放行是硬锁语义成立的前提
 *   （否则白名单应用图标点不到）；「系统设置」必须永远可达——那是用户关掉
 *   无障碍服务的唯一逃生门，也是防止把自己彻底锁死的最后保险；
 * - 到 lockedUntil 自动解锁，遮罩自行消失；
 * - 配置由网页下发（SharedPreferences "native_lock_guard"），原生只执行不判断。
 *
 * 边界：被拦时的表现是「桌面和白名单能用、其他应用点开即被盖住」，
 * 不是「整个手机只剩电话和设置」。
 *
 * 不做的事：不记录应用使用内容、不读取界面文字、不上传任何数据。
 */
class LockGuard(private val service: AccessibilityService) {

    companion object {
        private const val PREFS = "native_lock_guard"
        private const val MAX_LOCK_MS = 8L * 60 * 60 * 1000 // 单次锁定上限 8 小时

        /**
         * 遮罩窗口的标题标记。
         *
         * 用途：遮罩抢到焦点时会触发一条「前台应用变化」的无障碍事件，而那条事件的
         * 包名是本应用（遮罩归本应用管），放行名单里恰好包含本应用 —— 于是
         * 「盖遮罩 → 事件 → 判放行 → 拆遮罩 → 被拦应用夺回焦点 → 再盖上」形成
         * 死循环，屏幕表现为锁机画面和桌面高速交替闪烁（实测反馈，1.0.35 修）。
         */
        const val OVERLAY_WINDOW_TAG = "FloatLockOverlay"

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
    /** 遮罩上的一行提示（例如"没能直接打开应用"），不参与倒计时刷新。 */
    private var tipView: TextView? = null
    /** 遮罩上次被拆掉的时刻，用于 showOverlay 的防抖（见那里的注释）。 */
    @Volatile
    private var lastHiddenAt: Long = 0L

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
     * 放行名单的缓存。
     *
     * onForegroundPackageChanged 每次前台变化都会问一遍放行名单，而 alwaysAllowed()
     * 要查 5 次 PackageManager。不缓存的话，切应用时会重复做这些查询，
     * 在低端机上能明显拖慢"点开应用的一瞬间被挡住"的手感。
     * 缓存 30 秒足够：用户的电话/桌面应用不会在半分钟内换掉。
     * （不如白名单那样每次现读——白名单要跟着用户勾选立刻变，这里不需要。）
     */
    private var allowedCache: Set<String>? = null
    private var allowedCacheAt: Long = 0L

    private fun alwaysAllowedCached(): Set<String> {
        val now = System.currentTimeMillis()
        val cached = allowedCache
        if (cached != null && now - allowedCacheAt < 30_000L) return cached
        val fresh = alwaysAllowed()
        allowedCache = fresh
        allowedCacheAt = now
        return fresh
    }

    /**
     * 永不拦截的包名：本应用、桌面、电话、系统设置、系统 UI。
     *
     * 「系统设置」是刻意保留的逃生门：用户可以从中关掉无障碍服务来解除锁定。
     * 不做成绝对不可解 —— 真出急事时，把人锁在外面比"没管住自己"严重得多。
     *
     * 「桌面」是 1.0.34 补上的：遮罩吃触摸且全屏，桌面不放行的话，用户回到桌面
     * 看到的仍是遮罩，白名单应用图标点不到 —— 白名单形同虚设。
     */
    private fun alwaysAllowed(): Set<String> {
        val result = mutableSetOf(
            service.packageName,
            "com.android.systemui",
            "com.android.settings",
        )
        // 桌面（启动器）必须放行。
        //
        // 这是 1.0.34 修的核心问题：遮罩是全屏且吃触摸的，如果桌面也被盖住，
        // 用户按 Home 回到桌面看到的就是一张遮罩 —— 白名单里的应用图标根本点不到，
        // 白名单等于形同虚设（实测反馈：锁上后只有电话和设置能进）。
        // 放行桌面后，锁机的语义才回到"逐个应用被拦"：桌面能进、白名单能进，
        // 其余应用点开即被盖住。
        runCatching {
            val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
            for (info in service.packageManager.queryIntentActivities(home, 0)) {
                info.activityInfo?.packageName?.let { result.add(it) }
            }
            service.packageManager.resolveActivity(home, 0)?.activityInfo?.packageName?.let { result.add(it) }
        }
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
        // alwaysAllowed 用缓存版（见 alwaysAllowedCached 的注释）。
        // whitelist() 必须每次现读：用户在锁机台的勾选要立刻生效，缓存会让
        // "刚加进白名单却还被拦"这种问题出现。
        if (pkg in whitelist() || pkg in alwaysAllowedCached()) {
            hideOverlay()
            lastBlockedPackage = "" // 放行了，下一次被拦要重新推送
            return
        }
        showOverlay()
        // 去重：同一个包连续来多条窗口事件（切页面、弹窗都会发）时只推一次。
        // 原来每条都 dispatch，网页侧会收到一串重复的 blocked 事件。
        if (lastBlockedPackage != pkg) {
            lastBlockedPackage = pkg
            dispatch("blocked", JSONObject().put("package", pkg).put("until", lockedUntil()))
        }
    }

    /** 上一次已推送过 blocked 事件的包名，避免重复推送（见 onForegroundPackageChanged）。 */
    @Volatile
    private var lastBlockedPackage: String = ""

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
        // 第二道保险（防抖）：遮罩刚被拆掉不到 400ms 又要求显示，说明前后台
        // 事件正在打架（典型是遮罩与被拦应用互相抢焦点）。此时稍等一下再盖，
        // 让系统的焦点状态稳定下来；不加这道的话，即使类名过滤漏了某条事件，
        // 也会退化成"高频闪烁"而不是直接卡死。
        val sinceHide = System.currentTimeMillis() - lastHiddenAt
        if (lastHiddenAt > 0L && sinceHide in 1..400L) {
            handler.postDelayed({ showOverlay() }, 400L - sinceHide)
            return
        }
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
                // 让系统给这个窗口一个能认出来的标题。遮罩抢焦点时会引发一条
                // 前台应用事件，事件里带上它（部分机型放在 FLAG_ALT_FOCUSABLE_IM
                // 之外的窗口标题字段），作为 isOwnOverlayWindow 的第二道判据。
                // 注意别设成 FLAG_NOT_FOCUSABLE——那会让触摸穿透（见上）。
                params.title = OVERLAY_WINDOW_TAG
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
            tipView = null
            lastHiddenAt = System.currentTimeMillis()
            runCatching {
                val wm = service.getSystemService(Context.WINDOW_SERVICE) as WindowManager
                wm.removeView(view)
            }
        }
    }

    /**
     * 遮罩的根视图。刻意用**具名子类**而不是裸 FrameLayout。
     *
     * 原因（1.0.35 修的死循环）：遮罩是 FLAG 全开、能吃触摸的窗口，加进去就会
     * 抢走焦点，于是系统发出一条 TYPE_WINDOW_STATE_CHANGED —— 而那条事件的
     * 包名是**本应用**（窗口归属本应用），className 则是这个根视图的类名。
     * 本应用在放行名单里，于是被判定为「用户打开了 float，放行」→ 拆遮罩 →
     * 被拦的应用重新夺回焦点 → 再判拦截 → 再盖 → 再抢焦…… 表现就是
     * 锁机画面和桌面高频交替闪烁（实测反馈）。
     *
     * 有了这个具名子类，className 会带上 "OverlayRootView"，据此即可识别
     * 「这条事件是我自己的遮罩产生的」，直接忽略（见 isOwnOverlayWindow）。
     * 不要图省事换回 FrameLayout：那样就再也分不清"用户真的打开了 float"
     * 和"遮罩自己抢了焦点"。
     */
    private class OverlayRootView(context: Context) : FrameLayout(context)

    /** 这条前台事件是不是本遮罩自己抢焦点产生的（不是用户切换了应用）。 */
    fun isOwnOverlayWindow(className: CharSequence?): Boolean =
        className != null && className.contains("OverlayRootView")

    private fun dp(value: Int): Int = (value * service.resources.displayMetrics.density).toInt()

    private fun roundedBackground(color: Int, radiusDp: Int = 14): GradientDrawable =
        GradientDrawable().apply {
            setColor(color)
            cornerRadius = dp(radiusDp).toFloat()
        }

    /** 白名单里的应用（包名 + 显示名），供遮罩上的快捷入口用。 */
    private fun whitelistEntries(): List<Pair<String, String>> {
        val result = ArrayList<Pair<String, String>>()
        // alwaysAllowed() 每次都查一遍 PackageManager，循环里反复调没必要，先取一份。
        val always = alwaysAllowed()
        for (pkg in whitelist()) {
            if (pkg in always) continue // 桌面/电话/设置已经有专门入口
            val label = runCatching {
                val pm = service.packageManager
                pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
            }.getOrDefault("")
            result.add(Pair(pkg, label.ifBlank { pkg }))
        }
        return result.sortedBy { it.second.lowercase() }
    }

    /**
     * 从无障碍服务里拉起另一个应用。
     *
     * 后台服务直接 startActivity 在 Android 10+ 会被拦，但无障碍服务属于
     * 系统认可的"用户可见辅助"成分，实测多数机型放行；万一被拦，就返回 false，
     * 由界面提示「点回到桌面再打开」——绝不假装成功。
     */
    private fun launchApp(pkg: String): Boolean {
        // 必须用块函数体：下面有提前 return，而 Kotlin 禁止在表达式函数体
        // （`= ...`）里写 return——1.0.32 就因为同类写法炸过一次编译。
        return try {
            val intent = service.packageManager.getLaunchIntentForPackage(pkg)
            if (intent == null) {
                false
            } else {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                service.startActivity(intent)
                true
            }
        } catch (e: Throwable) {
            false
        }
    }

    private fun buildOverlayView(): View {
        val ctx = service
        // 必须是 OverlayRootView（不是 FrameLayout）：无障碍事件靠类名识别
        // 「这条焦点变化是遮罩自己造成的」，见 OverlayRootView 的注释。
        val root = OverlayRootView(ctx).apply {
            setBackgroundColor(Color.parseColor("#F2F0EA"))
            isClickable = true
        }

        // 内容多了要能滚（白名单可能有十几个），所以外面套 ScrollView。
        val scroll = ScrollView(ctx).apply {
            isFillViewport = true
        }

        val column = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(28), dp(40), dp(28), dp(32))
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
            setPadding(0, dp(22), 0, dp(4))
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
            setPadding(0, dp(24), 0, 0)
            setLineSpacing(0f, 1.5f)
        }
        reasonView = reason
        column.addView(reason)

        // ── 白名单快捷入口 ──
        // 桌面已经放行，理论上用户回桌面就能点到白名单应用。但遮罩刚好盖在
        // 当前应用上时，多一个直达入口体验更顺，也避免用户以为"整个手机都锁死了"。
        val entries = whitelistEntries()
        if (entries.isNotEmpty()) {
            column.addView(TextView(ctx).apply {
                text = "这些还能用"
                setTextColor(Color.parseColor("#A89D8B"))
                textSize = 12f
                letterSpacing = 0.08f
                gravity = Gravity.CENTER
                setPadding(0, dp(34), 0, dp(10))
            })
            for (entry in entries.take(12)) {
                column.addView(TextView(ctx).apply {
                    text = entry.second
                    setTextColor(Color.parseColor("#221F1A"))
                    textSize = 15f
                    gravity = Gravity.CENTER
                    setPadding(dp(18), dp(13), dp(18), dp(13))
                    background = roundedBackground(Color.parseColor("#FFFFFF"), 14)
                    isClickable = true
                    setOnClickListener {
                        if (!launchApp(entry.first)) {
                            tipView?.let { tip ->
                                tip.text = "没能直接打开，点下面「回到桌面」再从图标进去"
                                tip.visibility = View.VISIBLE
                            }
                        }
                    }
                }, LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply { bottomMargin = dp(8) })
            }
        }

        // 回到桌面：桌面本身在放行名单里，回去之后白名单应用都能点。
        column.addView(TextView(ctx).apply {
            text = "回到桌面"
            setTextColor(Color.parseColor("#2B6A5B"))
            textSize = 15f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            gravity = Gravity.CENTER
            setPadding(dp(18), dp(14), dp(18), dp(14))
            background = roundedBackground(Color.parseColor("#E4EDE8"), 14)
            isClickable = true
            setOnClickListener {
                // 刻意不先 hideOverlay：桌面在放行名单里，回到桌面这个事件本身
                // 就会让遮罩自动收掉。先拆遮罩再回桌面的话，万一 GLOBAL_ACTION_HOME
                // 被系统拒绝，用户就会停在被拦的应用上，那个应用等于临时解禁了。
                runCatching { service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME) }
            }
        }, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = dp(18) })

        val tip = TextView(ctx).apply {
            text = ""
            setTextColor(Color.parseColor("#B4452F"))
            textSize = 12f
            gravity = Gravity.CENTER
            setPadding(0, dp(12), 0, 0)
            visibility = View.GONE
        }
        tipView = tip
        column.addView(tip)

        column.addView(TextView(ctx).apply {
            text = "桌面、电话、系统设置仍可使用"
            setTextColor(Color.parseColor("#A89D8B"))
            textSize = 12f
            gravity = Gravity.CENTER
            setPadding(0, dp(30), 0, 0)
        })

        // 再套一层：内容少时垂直居中（不是贴在屏幕顶），内容多时照常滚动。
        // isFillViewport=true 让这层在内容不满一屏时也撑到视口高度。
        val inner = FrameLayout(ctx)
        inner.addView(column, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.CENTER_VERTICAL,
        ))
        scroll.addView(inner, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
        ))
        root.addView(scroll, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT,
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
