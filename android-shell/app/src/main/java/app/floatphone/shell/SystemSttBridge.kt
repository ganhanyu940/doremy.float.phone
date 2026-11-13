package app.floatphone.shell

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import org.json.JSONObject
import java.util.Locale
import java.util.UUID

/**
 * 系统语音识别桥：用**手机自带的识别引擎**把说话转成文字（免费、通常可离线）。
 *
 * 为什么必须有它：和 TTS 是同一个病根。`webkitSpeechRecognition` 在
 * Android System WebView 里没有可用的后端（Chromium 的语音识别依赖 Google
 * 在线服务/组件扩展，WebView 不带），`start()` 会立刻以 `audio-capture`
 * 失败——网页侧只能显示「无法访问麦克风」，用户以为是权限没给。
 * 只有原生 `android.speech.SpeechRecognizer` 才能真正开麦识别。
 *
 * 边界与取舍：
 * - **只返回文字，不返回音频**。做得了「说话转文字」，做不了「录一条语音消息」。
 *   要发语音条仍需 MediaRecorder（走 getUserMedia，壳已转授麦克风权限）。
 * - 识别引擎由用户在系统里选（Google / 厂商），本类不替用户改。
 * - 结果通过 ShellBus 以 window 自定义事件 `shell-stt` 派发给网页：
 *   detail.type = start | partial | final | error | end。
 * - 同一时刻只允许一个会话；新会话会取消旧的。
 */
class SystemSttBridge(private val context: Context) {

    private val mainHandler = Handler(Looper.getMainLooper())

    @Volatile
    private var recognizer: SpeechRecognizer? = null

    /** 当前会话 id；空 = 没有活跃会话。 */
    @Volatile
    private var sessionId: String = ""

    /** 已收到的最终文字缓冲（一次会话可能触发多次 onResults）。 */
    private var finalText: StringBuilder = StringBuilder()

    /** 防止同一会话重复收尾（end/error 可能都来）。 */
    @Volatile
    private var settled = false

    private var autoStop: Runnable? = null

    companion object {
        /** 单次识别上限：防止用户一直不说话、或忘了停，麦克风被无限占用。 */
        private const val MAX_SESSION_MS = 60_000L
    }

    fun isAvailable(): Boolean = runCatching { SpeechRecognizer.isRecognitionAvailable(context) }.getOrDefault(false)

    /**
     * 开始一次识别。
     *
     * @return JSON: {"ok":true,"sessionId":"..."} 或 {"ok":false,"reason":...,"message":...}
     */
    fun start(lang: String): JSONObject {
        if (!isAvailable()) {
            return fail("unavailable", "这台手机没有可用的语音识别服务")
        }
        // 先收掉上一轮，避免两个识别器抢麦克风
        cancel()

        val id = "stt_" + UUID.randomUUID().toString().take(8)
        sessionId = id
        finalText = StringBuilder()
        settled = false

        // SpeechRecognizer 必须在有 Looper 的主线程创建与调用，否则回调不触发。
        mainHandler.post {
            try {
                val engine = SpeechRecognizer.createSpeechRecognizer(context)
                recognizer = engine
                engine.setRecognitionListener(listenerFor(id))

                val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(
                        RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                        RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
                    )
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, normalizeLang(lang))
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, normalizeLang(lang))
                    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                    putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                    // 不强制「只说短句」：通话里一句话可能有好几秒。
                    putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2000L)
                    putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 1000L)
                }
                engine.startListening(intent)
                dispatch(JSONObject().put("type", "start").put("sessionId", id))

                // 兜底闸门：引擎不回调时也要放开麦克风
                autoStop = Runnable { finish(id, "timeout") }.also {
                    mainHandler.postDelayed(it, MAX_SESSION_MS)
                }
            } catch (error: Throwable) {
                dispatch(
                    JSONObject()
                        .put("type", "error")
                        .put("sessionId", id)
                        .put("message", error.message ?: error.javaClass.simpleName)
                )
                release(id)
            }
        }

        return JSONObject().put("ok", true).put("sessionId", id)
    }

    /**
     * 停止并返回已识别的内容（相当于「松手发送」）。
     * 引擎会在 onResults 里给最终结果，这里只负责结束采集。
     */
    fun stop() {
        mainHandler.post {
            runCatching { recognizer?.stopListening() }
        }
    }

    /** 取消本次识别，丢弃已识别内容（相当于「上滑取消」）。 */
    fun cancel() {
        val id = sessionId
        if (id.isEmpty()) return
        settled = true
        mainHandler.post {
            runCatching { recognizer?.cancel() }
        }
        release(id)
    }

    fun shutdown() {
        cancel()
        runCatching { recognizer?.destroy() }
        recognizer = null
    }

    private fun listenerFor(id: String) = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}

        override fun onBeginningOfSpeech() {
            dispatch(JSONObject().put("type", "speech").put("sessionId", id))
        }

        override fun onRmsChanged(rmsdB: Float) {
            // 供网页画音量波形；高频事件，只发数值，别带多余字段。
            dispatch(JSONObject().put("type", "volume").put("sessionId", id).put("rms", rmsdB.toDouble()))
        }

        override fun onBufferReceived(buffer: ByteArray?) {}

        override fun onEndOfSpeech() {
            dispatch(JSONObject().put("type", "endOfSpeech").put("sessionId", id))
        }

        override fun onError(error: Int) {
            if (settled) return
            // 用户说话前的静音超时 / 没识别到，不算错误：直接收尾，让网页回到待命态
            if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                finish(id, "noSpeech")
                return
            }
            val message = describeError(error)
            settled = true
            dispatch(
                JSONObject()
                    .put("type", "error")
                    .put("sessionId", id)
                    .put("message", message)
                    .put("code", error)
            )
            release(id)
        }

        override fun onResults(results: Bundle?) {
            val text = firstResult(results)
            if (text.isNotEmpty()) finalText.append(if (finalText.isEmpty()) text else " $text")
            emitFinal(id)
        }

        override fun onPartialResults(partialResults: Bundle?) {
            val text = firstResult(partialResults)
            if (text.isEmpty()) return
            dispatch(
                JSONObject()
                    .put("type", "partial")
                    .put("sessionId", id)
                    .put("text", (finalText.toString() + " " + text).trim())
            )
        }

        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    private fun firstResult(bundle: Bundle?): String {
        val list = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION) ?: return ""
        return list.firstOrNull()?.trim().orEmpty()
    }

    /** 正常收尾：把累积的最终文字发出去。 */
    private fun emitFinal(id: String) {
        if (settled) return
        settled = true
        dispatch(
            JSONObject()
                .put("type", "final")
                .put("sessionId", id)
                .put("text", finalText.toString().trim())
        )
        release(id)
    }

    /** 没拿到文字就收尾（静音超时 / 没识别到）。 */
    private fun finish(id: String, reason: String) {
        if (settled) return
        settled = true
        dispatch(
            JSONObject()
                .put("type", "end")
                .put("sessionId", id)
                .put("reason", reason)
                .put("text", finalText.toString().trim())
        )
        release(id)
    }

    private fun release(id: String) {
        val stopTask = autoStop
        autoStop = null
        if (stopTask != null) runCatching { mainHandler.removeCallbacks(stopTask) }
        if (sessionId == id) sessionId = ""
        mainHandler.post {
            // 每次会话用完就销毁：SpeechRecognizer 复用容易出现
            // 「第二次 startListening 没反应」的机型差异，重建成本可以接受。
            runCatching { recognizer?.destroy() }
            recognizer = null
        }
    }

    private fun describeError(error: Int): String = when (error) {
        SpeechRecognizer.ERROR_AUDIO -> "录音出错（麦克风可能被其他应用占用）"
        SpeechRecognizer.ERROR_CLIENT -> "识别客户端异常"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "没有麦克风权限：请到系统设置里允许本应用使用麦克风"
        SpeechRecognizer.ERROR_NETWORK -> "识别需要联网，当前网络不可用"
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "识别服务联网超时"
        SpeechRecognizer.ERROR_NO_MATCH -> "没有识别到内容"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "识别服务正忙，请稍后再试"
        SpeechRecognizer.ERROR_SERVER -> "识别服务返回错误"
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "没有检测到说话"
        SpeechRecognizer.ERROR_TOO_MANY_REQUESTS -> "识别请求太频繁，请稍后再试"
        else -> "语音识别错误（码 $error）"
    }

    private fun normalizeLang(lang: String): String {
        val cleaned = lang.trim().replace('_', '-')
        if (cleaned.isEmpty()) return Locale.getDefault().toLanguageTag()
        val parsed = runCatching { Locale.forLanguageTag(cleaned) }.getOrNull()
        return if (parsed != null && parsed.language.isNotEmpty()) parsed.toLanguageTag() else cleaned
    }

    private fun dispatch(detail: JSONObject) {
        val literal = JSONObject.quote(detail.toString())
        ShellBus.evalJs(
            "window.dispatchEvent(new CustomEvent('shell-stt',{detail:JSON.parse($literal)}))"
        )
    }

    private fun fail(reason: String, message: String): JSONObject = JSONObject()
        .put("ok", false)
        .put("reason", reason)
        .put("message", message)
}
