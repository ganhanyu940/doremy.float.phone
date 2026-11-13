package app.floatphone.shell

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.UUID

/**
 * 系统 TTS 桥：让网页用**手机自带的语音包**发声（免费、离线、不消耗任何 API 额度）。
 *
 * 为什么必须有它：Android System WebView 里没有 Chromium 的语音合成组件扩展，
 * 于是 `window.speechSynthesis` 虽然存在、`getVoices()` 也可能返回内容，但
 * `speak()` 静默失败——市场里所有自己调 Web Speech 的 APP（背单词、点读、
 * 听力）在壳内全都是哑的。同一份页面在手机 Chrome 里却有声，差别就在这里。
 * 只有原生 `android.speech.tts.TextToSpeech` 才能真正驱动系统语音引擎。
 *
 * 边界：
 * - 只朗读调用方给出的文本，不读页面内容、不落盘、不上传。
 * - 引擎由用户在系统设置里选（Google TTS / 厂商语音 / 第三方），本类不替用户改。
 * - 回调通过 ShellBus 以 window 自定义事件 `shell-tts` 派发给网页，
 *   网页据此知道「读完 / 出错」，而不是靠猜时长。
 */
class SystemTtsBridge(private val context: Context) {

    private enum class State(val wire: String) {
        IDLE("idle"),
        INITIALIZING("initializing"),
        READY("ready"),
        UNAVAILABLE("unavailable"),
        FAILED("failed"),
    }

    private val mainHandler = Handler(Looper.getMainLooper())

    @Volatile
    private var engine: TextToSpeech? = null

    @Volatile
    private var state = State.IDLE

    @Volatile
    private var lastError: String = ""

    /** 初始化期间来的朗读请求先存这里，引擎就绪后补读，避免用户第一次点读没反应。 */
    private var pending: PendingSpeech? = null

    private data class PendingSpeech(val text: String, val lang: String, val rate: Float)

    val isReady: Boolean
        get() = state == State.READY && engine != null

    /**
     * 预热引擎。App 启动时调一次即可：TextToSpeech 的 init 是异步的，
     * 等到用户点「朗读」才初始化，第一句几乎必然丢掉。
     */
    fun warmUp() {
        ensureInit()
    }

    private fun ensureInit() {
        if (state == State.INITIALIZING || state == State.READY) return
        if (state == State.UNAVAILABLE || state == State.FAILED) return
        state = State.INITIALIZING
        mainHandler.post {
            try {
                engine = TextToSpeech(context) { status ->
                    mainHandler.post {
                        if (status == TextToSpeech.SUCCESS) {
                            state = State.READY
                            lastError = ""
                            runCatching { engine?.setOnUtteranceProgressListener(progressListener) }
                            val queued = pending
                            pending = null
                            if (queued != null) speakNow(queued.text, queued.lang, queued.rate)
                        } else {
                            // 系统里没有任何可用 TTS 引擎（精简 ROM 常见）。
                            // 如实报告，不假装能读——网页据此提示用户去装语音包。
                            state = State.UNAVAILABLE
                            lastError = "系统没有可用的文字转语音引擎"
                            pending = null
                        }
                    }
                }
            } catch (error: Throwable) {
                state = State.FAILED
                lastError = error.message ?: error.javaClass.simpleName
                pending = null
            }
        }
    }

    private val progressListener = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) {
            dispatch("start", utteranceId)
        }

        override fun onDone(utteranceId: String?) {
            dispatch("end", utteranceId)
        }

        @Deprecated("Compat with API 21 signature", ReplaceWith("onError(utteranceId, errorCode)"))
        override fun onError(utteranceId: String?) {
            dispatchError(utteranceId, "系统语音播报失败")
        }

        override fun onError(utteranceId: String?, errorCode: Int) {
            dispatchError(utteranceId, describeError(errorCode))
        }

        override fun onStop(utteranceId: String?, interrupted: Boolean) {
            dispatch("stop", utteranceId)
        }
    }

    private fun describeError(errorCode: Int): String = when (errorCode) {
        TextToSpeech.ERROR_SYNTHESIS ->
            "当前语音包不支持这段文本（可能缺少该语言的语音数据）"
        TextToSpeech.ERROR_SERVICE ->
            "系统语音服务异常"
        TextToSpeech.ERROR_OUTPUT ->
            "音频输出失败（检查媒体音量或蓝牙占用）"
        TextToSpeech.ERROR_INVALID_REQUEST ->
            "朗读请求无效"
        TextToSpeech.ERROR_NETWORK ->
            "该语音包需要联网，当前网络不可用"
        TextToSpeech.ERROR_NETWORK_TIMEOUT ->
            "语音包联网超时"
        TextToSpeech.ERROR_NOT_INSTALLED_YET ->
            "语音数据还没下载完"
        else -> "系统语音错误（码 $errorCode）"
    }

    /**
     * 朗读一段文本。
     *
     * @return JSON 字符串 {"ok":true,...} 或 {"ok":false,"reason":"..."}。
     *         ok 只表示「已交给引擎」，真正读完/出错由 shell-tts 事件回报。
     */
    fun speak(text: String, lang: String, rate: Float): JSONObject {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return fail("empty_text", "没有可朗读的内容")
        // 防止调用方塞进整篇文章把语音队列堵死；朗读场景本来就是短句。
        val clipped = if (trimmed.length > 4000) trimmed.take(4000) else trimmed

        ensureInit()
        return when (state) {
            State.READY -> {
                val id = speakNow(clipped, lang, rate)
                if (id == null) fail("speak_failed", lastError.ifBlank { "系统语音拒绝了这次朗读" })
                else JSONObject().put("ok", true).put("utteranceId", id).put("state", state.wire)
            }
            State.INITIALIZING -> {
                // 引擎还没热好：排队，就绪后自动读，不返回失败让网页误以为不能发声。
                pending = PendingSpeech(clipped, lang, rate)
                JSONObject().put("ok", true).put("queued", true).put("state", state.wire)
            }
            State.UNAVAILABLE -> fail("unavailable", lastError.ifBlank { "系统没有可用的文字转语音引擎" })
            State.FAILED -> fail("failed", lastError.ifBlank { "系统语音引擎初始化失败" })
            State.IDLE -> fail("not_ready", "系统语音引擎尚未初始化")
        }
    }

    /** 在主线程真正调用引擎，返回 utteranceId；失败返回 null。 */
    private fun speakNow(text: String, lang: String, rate: Float): String? {
        val tts = engine ?: return null
        val utteranceId = "tts_" + UUID.randomUUID().toString().take(8)
        val safeRate = if (rate.isFinite() && rate > 0f) rate.coerceIn(0.1f, 4.0f) else 1.0f

        val locale = resolveLocale(lang)
        val langResult = runCatching { tts.setLanguage(locale) }.getOrDefault(TextToSpeech.LANG_NOT_SUPPORTED)
        if (langResult == TextToSpeech.LANG_MISSING_DATA || langResult == TextToSpeech.LANG_NOT_SUPPORTED) {
            // 不换语言硬读：英文词用中文音色念出来是灾难。让网页去提示装语音包。
            lastError = "系统缺少 ${locale.toLanguageTag()} 的语音数据"
            dispatchError(utteranceId, lastError)
            return null
        }
        runCatching { tts.setSpeechRate(safeRate) }

        val result = runCatching {
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId)
        }.getOrDefault(TextToSpeech.ERROR)
        if (result == TextToSpeech.ERROR) {
            lastError = "系统语音引擎拒绝了这次朗读"
            return null
        }
        return utteranceId
    }

    /** 立刻停止当前朗读并清空队列。 */
    fun stop() {
        pending = null
        runCatching { engine?.stop() }
    }

    fun speakingNow(): Boolean = runCatching { engine?.isSpeaking == true }.getOrDefault(false)

    /** 手机里真实可用的语音包清单（网页用来判断「有没有英文音色」）。 */
    fun voicesJson(): String {
        val tts = engine
        val array = JSONArray()
        if (tts != null && state == State.READY) {
            val voices = runCatching { tts.voices }.getOrNull()
            if (voices != null) {
                for (voice in voices) {
                    runCatching {
                        array.put(
                            JSONObject()
                                .put("name", voice.name.orEmpty())
                                .put("locale", voice.locale?.toLanguageTag().orEmpty())
                                .put("quality", voice.quality)
                                .put("latency", voice.latency)
                                .put("needsNetwork", voice.isNetworkConnectionRequired)
                        )
                    }
                }
            }
        }
        return array.toString()
    }

    /** 状态摘要，供网页诊断面板与「发音通道」卡片展示。 */
    fun stateJson(): JSONObject = JSONObject()
        .put("state", state.wire)
        .put("ready", isReady)
        .put("speaking", speakingNow())
        .put("error", lastError)
        .put("engineCount", runCatching { engine?.engines?.size ?: 0 }.getOrDefault(0))

    fun shutdown() {
        pending = null
        state = State.IDLE
        runCatching { engine?.stop() }
        runCatching { engine?.shutdown() }
        engine = null
    }

    private fun fail(reason: String, message: String): JSONObject = JSONObject()
        .put("ok", false)
        .put("reason", reason)
        .put("message", message)
        .put("state", state.wire)

    private fun resolveLocale(lang: String): Locale {
        val cleaned = lang.trim().replace('_', '-')
        if (cleaned.isEmpty()) return Locale.US
        val parsed = runCatching { Locale.forLanguageTag(cleaned) }.getOrNull()
        return if (parsed != null && parsed.language.isNotEmpty()) parsed else Locale.US
    }

    private fun dispatch(type: String, utteranceId: String?) {
        dispatchToPage(JSONObject().put("type", type).put("utteranceId", utteranceId.orEmpty()))
    }

    private fun dispatchError(utteranceId: String?, message: String) {
        dispatchToPage(
            JSONObject()
                .put("type", "error")
                .put("utteranceId", utteranceId.orEmpty())
                .put("message", message)
        )
    }

    /**
     * 把 TTS 事件投回宿主页面。
     *
     * 复用 ShellBus 的 evalJs 通道（与通话浮窗事件同一套路），网页侧监听
     * window 的 `shell-tts` 事件即可。写失败静默：朗读本身不该因为回调失败而中断。
     */
    private fun dispatchToPage(detail: JSONObject) {
        val literal = JSONObject.quote(detail.toString())
        ShellBus.evalJs(
            "window.dispatchEvent(new CustomEvent('shell-tts',{detail:JSON.parse($literal)}))"
        )
    }
}
