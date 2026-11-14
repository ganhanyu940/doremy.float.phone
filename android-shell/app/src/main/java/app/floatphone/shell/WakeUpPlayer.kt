package app.floatphone.shell

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import org.json.JSONObject

/**
 * 起床叫醒的播放侧（1.0.38）。
 *
 * 用户要的感觉是「像角色喊我起床」，所以这里做三件事叠在一起：
 *   ① 播角色那句话——优先用**提前合成好的音频**（网页在睡前用 Minimax 合好存本地），
 *      没有就退回系统 TTS 现念（用户确认过这个降级：宁可声音不像也不能不叫人）；
 *   ② 可选叠加系统闹铃音（怕睡眠深的人只靠人声叫不醒）；
 *   ③ 振动。
 *
 * 音量从起始值渐强到目标值，20 秒左右升满：一上来就 80% 会把人惊着，
 * 而用户自述易困，太轻又叫不醒。
 *
 * 为什么整套必须在原生：早上 6:30 App 在后台被冻结，网页的音频与 TTS 都跑不起来。
 *
 * 边界：
 *   · 只在用户设了叫醒计划时发声，不监听任何内容；
 *   · 播完/停止立刻释放 MediaPlayer，不留后台占用；
 *   · 最多响 maxRounds 轮，轮数用完就停——无限响是折磨，不是叫醒。
 */
object WakeUpPlayer {

    private val handler = Handler(Looper.getMainLooper())

    private var player: MediaPlayer? = null
    private var tonePlayer: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var tts: SystemTtsBridge? = null

    /** 当前正在叫醒的计划 id；空 = 没在响。 */
    @Volatile
    var activePlanId: String = ""
        private set

    @Volatile
    private var rampRunnable: Runnable? = null

    @Volatile
    private var savedVolume: Int = -1

    /**
     * 开始一轮叫醒。
     *
     * @param audioDataUrl 提前合成好的音频（data:audio/... 内联）；空则用 TTS
     * @param speech       要念的那句话（TTS 用，也显示在遮罩上）
     */
    fun start(
        context: Context,
        planId: String,
        audioDataUrl: String,
        speech: String,
        volume: Int,
        rampSeconds: Int,
        vibrate: Boolean,
        playTone: Boolean,
    ): Boolean {
        stop(context, releaseTts = false)
        activePlanId = planId
        val target = volume.coerceIn(10, 100)
        val start = maxOf(10, target / 3)

        val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        // 记住用户原本的媒体音量，停下来之后还原——悄悄改了他手机的音量
        // 是很讨厌的事，尤其叫醒之后接电话发现声音巨大。
        if (am != null && savedVolume < 0) savedVolume = am.getStreamVolume(AudioManager.STREAM_MUSIC)
        applyVolume(context, start)
        rampUp(context, start, target, rampSeconds)

        val playedAudio = if (audioDataUrl.isNotBlank()) playDataUrl(context, audioDataUrl, target) else false
        if (!playedAudio) {
            // 降级：用系统 TTS 念那句话。宁可声音不像，也不能不叫人。
            val bridge = SystemTtsBridge(context)
            tts = bridge
            bridge.warmUp()
            bridge.speak(speech.ifBlank { "该起床了" }, "zh-CN", 0.95f)
        }

        if (playTone) {
            runCatching {
                val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                    ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
                tonePlayer = MediaPlayer().apply {
                    setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ALARM)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build()
                    )
                    setDataSource(context, uri)
                    isLooping = true
                    prepare()
                    start()
                }
            }
        }

        if (vibrate) {
            vibrator = systemVibrator(context)?.also { v ->
                runCatching {
                    val pattern = longArrayOf(0, 800, 400, 800, 1200)
                    if (Build.VERSION.SDK_INT >= 26) {
                        v.vibrate(VibrationEffect.createWaveform(pattern, 1))
                    } else {
                        @Suppress("DEPRECATION")
                        v.vibrate(pattern, 1)
                    }
                }
            }
        }
        return true
    }

    /** 停一轮：停声、停振动、还原音量。TTS 实例默认一起释放。 */
    fun stop(context: Context, releaseTts: Boolean = true) {
        activePlanId = ""
        rampRunnable?.let { handler.removeCallbacks(it) }
        rampRunnable = null
        runCatching { player?.stop(); player?.release() }
        player = null
        runCatching { tonePlayer?.stop(); tonePlayer?.release() }
        tonePlayer = null
        runCatching { vibrator?.cancel() }
        vibrator = null
        if (releaseTts) {
            runCatching { tts?.stop() }
            tts = null
        }
        if (savedVolume >= 0) {
            applyVolume(context, savedVolume)
            savedVolume = -1
        }
    }

    private fun playDataUrl(context: Context, dataUrl: String, volume: Int): Boolean = runCatching {
        val comma = dataUrl.indexOf(',')
        if (comma < 0) return@runCatching false
        val bytes = android.util.Base64.decode(dataUrl.substring(comma + 1), android.util.Base64.DEFAULT)
        if (bytes.isEmpty()) return@runCatching false
        // 写临时文件再播：MediaPlayer 从字节数组播要额外 API，落盘最稳。
        val file = java.io.File(context.cacheDir, "wakeup_voice.mp3")
        file.writeBytes(bytes)
        player = MediaPlayer().apply {
            setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            setDataSource(file.absolutePath)
            setVolume(volume / 100f, volume / 100f)
            isLooping = true
            prepare()
            start()
        }
        true
    }.getOrDefault(false)

    /** 渐强：每 500ms 抬一点，避免一上来就 80% 把人惊着。 */
    private fun rampUp(context: Context, from: Int, to: Int, seconds: Int) {
        if (seconds <= 0) {
            applyVolume(context, to)
            return
        }
        val steps = maxOf(1, seconds * 2)
        val delta = (to - from).toFloat() / steps
        var step = 0
        val runnable = object : Runnable {
            override fun run() {
                step += 1
                val level = (from + delta * step).toInt().coerceIn(0, 100)
                applyVolume(context, level)
                player?.let { runCatching { it.setVolume(level / 100f, level / 100f) } }
                if (step < steps) handler.postDelayed(this, 500L)
            }
        }
        rampRunnable = runnable
        handler.postDelayed(runnable, 500L)
    }

    private fun applyVolume(context: Context, level: Int) {
        runCatching {
            val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
            val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
            val index = (max * (level.coerceIn(0, 100) / 100f)).toInt().coerceIn(0, max)
            am.setStreamVolume(AudioManager.STREAM_MUSIC, index, 0)
        }
    }

    private fun systemVibrator(context: Context): Vibrator? = runCatching {
        if (Build.VERSION.SDK_INT >= 31) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }.getOrNull()

    /** 状态摘要，网页面板显示「现在到底有没有在响」。 */
    fun statusJson(): JSONObject = JSONObject()
        .put("ringing", activePlanId.isNotBlank())
        .put("planId", activePlanId)
}
