package expo.modules.kavacht0

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.util.Log
import androidx.core.content.ContextCompat
import java.util.Calendar
import java.util.Locale

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * P-022 · THE FINAL BREATH
 *
 * The difference between "she stopped moving" and "her phone was switched off" is
 * the difference between a wellness check and a manhunt. ACTION_SHUTDOWN is the
 * last moment we can tell them apart, and it is the only broadcast that is sent
 * before the radios go down.
 *
 * ★ Everything here is SYNCHRONOUS. ★
 * `goAsync()` is the wrong tool: its PendingResult is serviced on a thread pool
 * that the system is in the middle of tearing down, and `apply()` on
 * SharedPreferences returns before a single byte is on disk. During shutdown
 * there is no "later" — only `commit()` and a direct binder call to the telephony
 * service are guaranteed to have happened by the time we return.
 *
 * ★ We do NOT wait for delivery acks. ★
 * `sendTextMessage` hands the SMS-SUBMIT to the telephony service and returns in
 * single-digit milliseconds; the ack would arrive seconds later, to a process
 * that no longer exists. A sentIntent here would buy nothing and cost the only
 * time we have.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
class ShutdownReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action ?: return
    if (action !in HANDLED) return

    val at = System.currentTimeMillis()
    val kind = if (action == Intent.ACTION_SHUTDOWN) KIND_SHUTDOWN else KIND_QUICKBOOT

    val snapshot = try {
      T0Config.snapshot(context)
    } catch (t: Throwable) {
      Log.e(TAG, "config unreadable during shutdown", t)
      null
    }

    val batteryPct = readBatteryPct(context)

    // Breadcrumb first, always. Even with no incident open and no SIM, the next
    // boot must be able to prove the phone was powered off deliberately rather
    // than that the agent was killed — the two look identical from the server.
    val result = if (snapshot != null && snapshot.incidentActive) {
      sendFinalBreath(context, snapshot, at, batteryPct)
    } else {
      RESULT_NO_INCIDENT
    }

    T0Config.commitBlocking(
      context,
      mapOf(
        T0Config.KEY_LAST_SHUTDOWN_AT to at,
        T0Config.KEY_LAST_SHUTDOWN_KIND to kind,
        T0Config.KEY_LAST_BATTERY_PCT to batteryPct,
        T0Config.KEY_FINAL_BREATH_AT to at,
        T0Config.KEY_FINAL_BREATH_RESULT to result
      )
    )
  }

  private fun sendFinalBreath(
    context: Context,
    snapshot: T0Snapshot,
    at: Long,
    batteryPct: Int
  ): String {
    if (snapshot.emergencyNumbers.isEmpty()) {
      // Nothing provisioned. We deliberately do NOT invent a recipient: an SMS to
      // 112 that says "a phone was switched off" wastes a real emergency operator's
      // time and teaches them to ignore us (P-006 applied to the responder, not
      // the user). The breadcrumb still lands and the next boot reports the gap.
      return RESULT_NO_RECIPIENTS
    }
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS)
      != PackageManager.PERMISSION_GRANTED
    ) {
      return RESULT_NO_PERMISSION
    }

    val body = buildPacket(snapshot, at, batteryPct)
    val targets = T0Sms.orderedSubscriptions(context, snapshot.preferredSubscriptionId)
    var dispatched = 0

    // Every SIM, exactly as in a normal incident (P-033). Balance cannot be
    // queried programmatically, so "which SIM has credit" is unanswerable; the
    // only correct move is to try all of them. Each call is one binder round trip.
    for (target in targets) {
      val manager = T0Sms.smsManagerFor(context, target.subscriptionId) ?: continue
      for (number in snapshot.emergencyNumbers) {
        try {
          manager.sendTextMessage(number, null, body, null, null)
          dispatched++
        } catch (t: Throwable) {
          Log.w(TAG, "final breath refused on sub ${target.subscriptionId}", t)
        }
      }
    }

    return if (dispatched > 0) "$RESULT_SENT:$dispatched" else RESULT_ALL_REFUSED
  }

  /**
   * ≤160 ASCII characters, single GSM-7 segment. A concatenated SMS is delivered
   * as two independent messages that can arrive out of order, minutes apart, or
   * not at all — during a power-off there is no retry, so the packet must fit in
   * one part or it is worse than nothing.
   */
  private fun buildPacket(snapshot: T0Snapshot, at: Long, batteryPct: Int): String {
    val id = snapshot.incidentId8.ifBlank { "--------" }
    val clock = Calendar.getInstance().apply { timeInMillis = at }
    val hhmm = String.format(
      Locale.US,
      "%02d:%02d",
      clock.get(Calendar.HOUR_OF_DAY),
      clock.get(Calendar.MINUTE)
    )

    val where = if (snapshot.lastLat != null && snapshot.lastLon != null) {
      val accuracy = snapshot.lastAccuracyM?.let { " +-${it.toInt()}m" }.orEmpty()
      val ageMin = if (snapshot.lastLocationAt > 0L) {
        " (${((at - snapshot.lastLocationAt) / 60000L).coerceAtLeast(0L)}m old)"
      } else {
        ""
      }
      String.format(Locale.US, " Last %.5f,%.5f%s%s", snapshot.lastLat, snapshot.lastLon, accuracy, ageMin)
    } else {
      " No location."
    }

    val battery = if (batteryPct in 0..100) " Bat $batteryPct%." else ""

    val raw = "KAVACH $id: phone POWERING OFF while alert open at $hhmm.$where$battery"
    return raw.toAscii().take(160)
  }

  /**
   * Anything outside 7-bit ASCII forces the whole message into UCS-2, which cuts
   * the single-segment budget from 160 characters to 70. A Devanagari place name
   * arriving from the policy snapshot must not silently halve the packet.
   */
  private fun String.toAscii(): String =
    buildString(length) {
      for (ch in this@toAscii) {
        append(if (ch.code in 32..126) ch else ' ')
      }
    }

  private fun readBatteryPct(context: Context): Int {
    val battery = try {
      context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    } catch (t: Throwable) {
      Log.w(TAG, "battery unreadable during shutdown", t)
      null
    } ?: return -1
    val level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
    val scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
    if (level < 0 || scale <= 0) return -1
    return (level * 100) / scale
  }

  private companion object {
    const val TAG = "KavachT0/Final"

    const val KIND_SHUTDOWN = "shutdown"
    const val KIND_QUICKBOOT = "quickboot_poweroff"

    const val RESULT_SENT = "sent"
    const val RESULT_NO_INCIDENT = "no_incident"
    const val RESULT_NO_RECIPIENTS = "no_recipients_provisioned"
    const val RESULT_NO_PERMISSION = "send_sms_denied"
    const val RESULT_ALL_REFUSED = "all_sims_refused"

    val HANDLED = setOf(
      Intent.ACTION_SHUTDOWN,
      "android.intent.action.QUICKBOOT_POWEROFF",
      "com.htc.intent.action.QUICKBOOT_POWEROFF"
    )
  }
}
