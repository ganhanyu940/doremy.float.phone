package app.floatphone.shell

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * 意图的原生侧存储（1.0.38）。
 *
 * 为什么原生要自己存一份：闹钟响的时候网页可能完全不在（App 在后台被冻结、
 * 甚至进程已被回收）。那时判定"该不该锁"必须靠本地这份快照，
 * 不能回网页问——问不到。
 *
 * 数据流是单向的：**网页写入 → 原生读取**。
 * 原生只在结算后回写一个 outcome（结果说明），不改意图本身的状态机，
 * 状态机仍由网页那份负责（lib/intent-lock/storage.ts）。
 * 这样两边不会互相打架：谁改状态、谁只读，约定清楚。
 *
 * 键用意图 id（与网页侧 id 一致），值是一条 JSON。
 */
object IntentStore {

    private const val PREFS = "native_intent_lock"
    private const val KEY_RECORDS = "records"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** 网页下发：把当前所有待执行的意图整份同步过来（覆盖式，最不易出错）。 */
    fun sync(context: Context, recordsJson: String): Boolean = runCatching {
        val parsed = JSONArray(recordsJson)
        val kept = JSONArray()
        for (i in 0 until parsed.length()) {
            val item = parsed.optJSONObject(i) ?: continue
            if (item.optString("id").isBlank()) continue
            kept.put(item)
        }
        prefs(context).edit().putString(KEY_RECORDS, kept.toString()).apply()
        true
    }.getOrDefault(false)

    /** 取一条还没结算的意图（找不到返回 null）。 */
    fun findPending(context: Context, intentId: String): JSONObject? = runCatching {
        val raw = prefs(context).getString(KEY_RECORDS, "[]") ?: "[]"
        val array = JSONArray(raw)
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            if (item.optString("id") == intentId) return@runCatching item
        }
        null
    }.getOrNull()

    /**
     * 记下结算结果。
     *
     * 同时把这条从待执行列表里摘掉：闹钟虽然只响一次，但取消/重排时
     * 可能留下幽灵条目，摘掉最省心。
     */
    fun markOutcome(context: Context, intentId: String, message: String) {
        runCatching {
            val raw = prefs(context).getString(KEY_RECORDS, "[]") ?: "[]"
            val array = JSONArray(raw)
            val kept = JSONArray()
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                if (item.optString("id") == intentId) continue
                kept.put(item)
            }
            prefs(context).edit()
                .putString(KEY_RECORDS, kept.toString())
                .putString("lastOutcome_$intentId", message.take(200))
                .putLong("lastOutcomeAt_$intentId", System.currentTimeMillis())
                .apply()
        }
    }

    /** 读回某条意图的结算结果（网页面板显示用）。 */
    fun outcomeOf(context: Context, intentId: String): String =
        prefs(context).getString("lastOutcome_$intentId", "").orEmpty()

    /** 清掉所有待执行意图（用户关掉整个功能时），并取消已排的检查闹钟。 */
    fun clear(context: Context) {
        runCatching {
            val raw = prefs(context).getString(KEY_RECORDS, "[]") ?: "[]"
            val array = JSONArray(raw)
            for (i in 0 until array.length()) {
                val id = array.optJSONObject(i)?.optString("id").orEmpty()
                if (id.isNotBlank()) IntentScheduler.cancel(context, id)
            }
            prefs(context).edit().putString(KEY_RECORDS, "[]").apply()
        }
    }

    /** 开机后重排尚未结算的意图检查闹钟。 */
    fun rescheduleAfterBoot(context: Context) {
        runCatching {
            val raw = prefs(context).getString(KEY_RECORDS, "[]") ?: "[]"
            val array = JSONArray(raw)
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                val id = item.optString("id")
                val checkAt = item.optLong("checkAt", 0L)
                if (id.isNotBlank() && checkAt > 0L) {
                    IntentScheduler.schedule(context, id, checkAt)
                }
            }
        }
    }
}
