package expo.modules.kavacht0

import android.app.admin.DeviceAdminReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ADR-015 · THE DEVICE POLICY CONTROLLER
 *
 * Being Device Owner is what takes OEM battery managers, force-stop and uninstall
 * off the table — the three things that silently kill T0 on the exact devices
 * this product exists for.
 *
 * The receiver itself holds almost no policy: see res/xml/kavach_device_admin.xml
 * for why `<uses-policies>` is deliberately empty, and DeviceOwnerConfigurator for
 * the two-wave rollout of the restrictions that matter.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
class KavachDeviceAdminReceiver : DeviceAdminReceiver() {

  override fun onEnabled(context: Context, intent: Intent) {
    super.onEnabled(context, intent)
    T0Config.noteLong(context, KEY_ADMIN_ENABLED_AT, System.currentTimeMillis())
    Log.i(TAG, "device admin enabled")
  }

  /**
   * Shown by the system when someone tries to strip our admin rights. It is
   * intentionally a plain statement of consequence, not a plea: the guardian is
   * allowed to do this, and the release path exists precisely so they can.
   *
   * Hardcoded English because a DeviceAdminReceiver runs outside the JS runtime
   * and cannot reach the i18n table in src/i18n. Anything it says must therefore
   * be short enough to be understandable at a glance regardless of locale.
   */
  override fun onDisableRequested(context: Context, intent: Intent): CharSequence =
    "Turning this off stops Kavach from surviving force-stop, battery savers and " +
      "uninstall. Emergency SMS and the always-on agent may stop working."

  override fun onDisabled(context: Context, intent: Intent) {
    super.onDisabled(context, intent)
    T0Config.noteLong(context, KEY_ADMIN_DISABLED_AT, System.currentTimeMillis())
    // Every wave-1/wave-2 restriction dies with our admin status. Clearing the
    // stamps means a later re-provision starts the 30-day wave-2 soak again from
    // zero instead of inheriting credit it never earned.
    T0Config.commitBlocking(
      context,
      mapOf(
        T0Config.KEY_WAVE1_APPLIED_AT to 0L,
        T0Config.KEY_WAVE2_APPLIED_AT to 0L,
        T0Config.KEY_WAVE2_APPROVED_AT to 0L
      )
    )
    Log.w(TAG, "device admin disabled; T0 hardening is gone")
  }

  /**
   * Fires the moment provisioning completes — before the user ever opens the app.
   * Wave 1 only (PRD §5.3): permission auto-grant, uninstall block, safe-boot and
   * add-user restrictions, FRP. Wave 2 is never applied here; it needs a month of
   * fleet stability first, and this callback runs on day zero by definition.
   */
  override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
    super.onProfileProvisioningComplete(context, intent)
    try {
      val result = DeviceOwnerConfigurator.applyWave(context, DeviceOwnerConfigurator.WAVE_1)
      Log.i(TAG, "wave 1 at provisioning: $result")
    } catch (t: Throwable) {
      // A DPC that crashes during provisioning leaves a half-configured device
      // owner and no UI to fix it from. Log and let the app retry later.
      Log.e(TAG, "wave 1 failed at provisioning", t)
    }
  }

  companion object {
    private const val TAG = "KavachT0/Admin"
    const val KEY_ADMIN_ENABLED_AT = "adminEnabledAt"
    const val KEY_ADMIN_DISABLED_AT = "adminDisabledAt"

    fun componentName(context: Context): ComponentName =
      ComponentName(context.applicationContext, KavachDeviceAdminReceiver::class.java)
  }
}
