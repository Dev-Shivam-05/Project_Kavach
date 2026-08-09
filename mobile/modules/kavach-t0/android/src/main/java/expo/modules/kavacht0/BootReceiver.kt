package expo.modules.kavacht0

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * T0 · RESURRECTION
 *
 * The agent has to be running again before the user reaches the lock screen, not
 * after they unlock — a person who is unconscious at 3 a.m. never unlocks.
 *
 * Three entry points, all of them load-bearing:
 *
 *  · LOCKED_BOOT_COMPLETED — Direct Boot. Fires while /data/user is still
 *    credential-encrypted. This is the only one that gives T0 a pre-unlock life,
 *    and it only reaches us because this receiver and the service are both
 *    `directBootAware` (P-035).
 *
 *  · BOOT_COMPLETED — the fallback. Several OEM builds never send the locked
 *    variant to third-party apps; on those devices this is the only signal.
 *    Starting twice is harmless: the service is idempotent.
 *
 *  · MY_PACKAGE_REPLACED — an in-place update stops every service the app owns.
 *    Without this the agent stays dead until the next reboot, which on a phone
 *    that is never rebooted means "forever".
 *
 * ★ All three are documented exemptions from the Android 12+ background
 * foreground-service-start restriction, which is why the agent can legally be
 * started from here at all. Android 15 additionally narrows WHICH foreground
 * service types may be started from BOOT_COMPLETED — location and connectedDevice
 * are permitted, dataSync/camera/microphone/mediaPlayback are not. That
 * constraint is the reason the agent is typed the way it is.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
class BootReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action ?: return
    if (action !in HANDLED) return

    val now = System.currentTimeMillis()

    try {
      val snapshot = T0Config.snapshot(context)

      // F-04 four clocks: the gap between the last heartbeat and this boot is
      // exactly how long T0 was blind. Recording it here is the only chance —
      // after the JS layer starts, "uptime" tells you nothing about the outage.
      val blindMs = if (snapshot.lastHeartbeatAt > 0L) now - snapshot.lastHeartbeatAt else -1L
      T0Config.commitBlocking(
        context,
        mapOf(
          T0Config.KEY_LAST_BOOT_AT to now,
          KEY_LAST_BOOT_ACTION to action,
          KEY_LAST_BLIND_MS to blindMs
        )
      )

      // ★ Respect the user. `pauseMonitoring` and an explicit stop both clear
      // agentEnabled; resurrecting the agent anyway would make the pause switch a
      // lie, and a safety app that ignores its own off switch gets uninstalled
      // (P-006). The one exception is a device that has never been provisioned:
      // there is nothing to run, so we also do nothing.
      if (!snapshot.agentEnabled) {
        Log.i(TAG, "agent disabled by the user; not resurrecting after $action")
        return
      }

      KavachForegroundService.start(context)
    } catch (t: Throwable) {
      // A throw here is a permanently dead agent until the next boot. There is no
      // recovery path worth risking that for (ADR-018: fail OPEN).
      Log.e(TAG, "boot handling failed for $action", t)
    }
  }

  private companion object {
    const val TAG = "KavachT0/Boot"
    const val KEY_LAST_BOOT_ACTION = "lastBootAction"
    const val KEY_LAST_BLIND_MS = "lastBlindMs"

    val HANDLED = setOf(
      Intent.ACTION_LOCKED_BOOT_COMPLETED,
      Intent.ACTION_BOOT_COMPLETED,
      Intent.ACTION_MY_PACKAGE_REPLACED
    )
  }
}
