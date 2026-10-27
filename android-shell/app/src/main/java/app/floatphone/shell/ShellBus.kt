package app.floatphone.shell

import android.webkit.WebView
import org.json.JSONObject

/**
 * 壳 ↔ 网页的单向广播通道（原生 → 网页）。
 *
 * 通话浮窗、无障碍服务这些原生组件不在 MainActivity 里，需要主动把事件塞回网页。
 * 这里持有当前 WebView 的引用（MainActivity 创建/销毁时登记），统一负责：
 * - 把 JS 安全地投递到主线程执行（WebView 只能在主线程碰）；
 * - 用 JSONObject.quote 生成合法 JS 字符串字面量（含引号/换行/反斜杠都能扛），
 *   再交给页面 JSON.parse，避免手写字符串转义在角色名含引号时把脚本拼坏。
 *
 * 网页侧监听 window 上的 'shell-call-overlay' 事件，detail 形如
 * { action: 'restore' | 'hangup' | 'reply' | 'tick', text?: string }。
 */
object ShellBus {

    @Volatile
    var webView: WebView? = null

    /** 网页还活着吗（WebView 未销毁）。原生据此决定是走浮窗交互还是退化成通知。 */
    fun isWebAlive(): Boolean = webView != null

    /** 在主线程执行一段 JS。失败静默——原生侧不该因为网页异常而崩。 */
    fun evalJs(script: String) {
        val target = webView ?: return
        target.post { runCatching { target.evaluateJavascript(script, null) } }
    }

    /**
     * 向网页派发一个通话浮窗事件。
     * @param action restore（点浮窗回全屏）/ hangup（挂断）/ reply（快捷回复）/ tick（心跳）
     */
    fun dispatchOverlayEvent(action: String, payload: JSONObject = JSONObject()) {
        val detail = JSONObject(payload.toString()).put("action", action)
        val literal = JSONObject.quote(detail.toString())
        evalJs("window.dispatchEvent(new CustomEvent('shell-call-overlay',{detail:JSON.parse($literal)}))")
    }

    /**
     * 向网页派发一个锁机事件（网页侧监听 'shell-lockdown'）。
     *
     * 与通话浮窗事件分开走：锁机要处理的是「用户点了确认/锁定结束了」这种生命周期，
     * 和通话的 restore/hangup/tick 语义完全不同，混在一个事件里会让订阅方疯狂分支。
     *
     * @param action unlocked（用户在浮层点了确认/自己解除）/ stopped（到点或被回收）
     */
    fun dispatchLockdownEvent(action: String, payload: JSONObject = JSONObject()) {
        val detail = JSONObject(payload.toString()).put("action", action)
        val literal = JSONObject.quote(detail.toString())
        evalJs("window.dispatchEvent(new CustomEvent('shell-lockdown',{detail:JSON.parse($literal)}))")
    }
}
