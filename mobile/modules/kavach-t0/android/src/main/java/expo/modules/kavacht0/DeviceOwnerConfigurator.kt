package expo.modules.kavacht0

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.app.admin.FactoryResetProtectionPolicy
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.UserManager
import android.util.Log
import java.security.MessageDigest
import java.util.Locale

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PRD §5.3 · THE DEVICE OWNER LOCKDOWN, IN TWO WAVES
 *
 * ★ WAVE 1 — ships now. Everything here is reversible from software:
 *     · permission auto-grant        (T0 must never lose SEND_SMS to a prompt)
 *     · uninstall block              (P-006 is about the app being *removed*)
 *     · DISALLOW_SAFE_BOOT           (safe mode is a phone with no Kavach on it)
 *     · DISALLOW_ADD_USER            (a second user is a Kavach-free phone,
 *                                     same SIM, same person, no agent)
 *     · Factory Reset Protection     (a wiped phone must still need a guardian)
 *
 * ★ WAVE 2 — only after a month of fleet stability. These are the ones you
 *   cannot take back from a device you can no longer reach:
 *     · DISALLOW_FACTORY_RESET
 *     · DISALLOW_DEBUGGING_FEATURES  ← APPLIED LAST, ALWAYS
 *
 *   The order is not stylistic. DISALLOW_DEBUGGING_FEATURES removes ADB. ADB is
 *   the last escape hatch on a device whose DPC has a bug: with it you can still
 *   `adb shell dpm remove-active-admin` and get the phone back. Without it, a
 *   crashing DPC leaves a phone that cannot be managed, cannot be reset (wave 2
 *   just disallowed that) and cannot be recovered except by a recovery-mode
 *   factory reset — which then walks straight into the Factory Reset Protection
 *   policy wave 1 installed. That is a brick, made of three of our own decisions.
 *
 * ★ AND THE RULE THAT MAKES ALL OF IT SAFE:
 *   `release()` — the guardian-authenticated `clearDeviceOwnerApp()` — ships
 *   BEFORE either wave. A fleet you can lock down but not release is a fleet of
 *   future bricks. Build the exit first; only then build the door.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
object DeviceOwnerConfigurator {

  const val WAVE_1 = 1
  const val WAVE_2 = 2

  private const val TAG = "KavachT0/DPC"

  /**
   * Wave 2 may not be applied until the device has carried wave 1 for a month.
   * "A month of fleet stability" is not a slogan — it is the minimum window in
   * which an OEM-specific DPC crash shows up in the field, and the last window in
   * which ADB can still fix it.
   */
  private const val WAVE_2_MIN_SOAK_MS = 30L * 24L * 60L * 60L * 1000L

  /**
   * Order matters: ACCESS_BACKGROUND_LOCATION can only be granted once a
   * foreground location permission is already held, even by a Device Owner.
   */
  private val T0_PERMISSIONS: List<Pair<String, Int>> = listOf(
    Manifest.permission.SEND_SMS to 1,
    Manifest.permission.READ_PHONE_STATE to 1,
    Manifest.permission.ACCESS_COARSE_LOCATION to 1,
    Manifest.permission.ACCESS_FINE_LOCATION to 1,
    Manifest.permission.ACCESS_BACKGROUND_LOCATION to Build.VERSION_CODES.Q,
    Manifest.permission.CAMERA to 1,
    Manifest.permission.RECORD_AUDIO to 1,
    Manifest.permission.ACTIVITY_RECOGNITION to Build.VERSION_CODES.Q,
    Manifest.permission.BLUETOOTH_ADVERTISE to Build.VERSION_CODES.S,
    Manifest.permission.BLUETOOTH_CONNECT to Build.VERSION_CODES.S,
    Manifest.permission.POST_NOTIFICATIONS to Build.VERSION_CODES.TIRAMISU
  )

  private val WAVE_1_RESTRICTIONS = listOf(
    UserManager.DISALLOW_SAFE_BOOT,
    UserManager.DISALLOW_ADD_USER
  )

  /** ★ DISALLOW_DEBUGGING_FEATURES is last in this list and must stay last. */
  private val WAVE_2_RESTRICTIONS = listOf(
    UserManager.DISALLOW_FACTORY_RESET,
    UserManager.DISALLOW_DEBUGGING_FEATURES
  )

  fun isDeviceOwner(context: Context): Boolean {
    val dpm = dpm(context) ?: return false
    return try {
      dpm.isDeviceOwnerApp(context.packageName)
    } catch (t: Throwable) {
      Log.w(TAG, "isDeviceOwnerApp threw", t)
      false
    }
  }

  fun applyWave(context: Context, wave: Int): Bundle {
    val applied = mutableListOf<String>()
    val skipped = mutableListOf<String>()
    val failed = mutableListOf<String>()

    val dpm = dpm(context)
    val owner = dpm != null && isDeviceOwner(context)
    if (dpm == null || !owner) {
      skipped += "not_device_owner"
      return report(wave, applied, skipped, failed, false)
    }

    val admin = KavachDeviceAdminReceiver.componentName(context)
    when (wave) {
      WAVE_1 -> applyWave1(context, dpm, admin, applied, skipped, failed)
      WAVE_2 -> applyWave2(context, dpm, admin, applied, skipped, failed)
      else -> skipped += "unknown_wave_$wave"
    }
    return report(wave, applied, skipped, failed, true)
  }

  // ── Wave 1 ──────────────────────────────────────────────────────────────────

  private fun applyWave1(
    context: Context,
    dpm: DevicePolicyManager,
    admin: ComponentName,
    applied: MutableList<String>,
    skipped: MutableList<String>,
    failed: MutableList<String>
  ) {
    // AUTO_GRANT covers permissions requested from now on. It does not
    // retroactively grant what the user already denied, which is why the explicit
    // per-permission pass below still runs.
    runStep("permission_policy_auto_grant", applied, failed) {
      dpm.setPermissionPolicy(admin, DevicePolicyManager.PERMISSION_POLICY_AUTO_GRANT)
    }

    val declared = declaredPermissions(context)
    for ((permission, minSdk) in T0_PERMISSIONS) {
      if (Build.VERSION.SDK_INT < minSdk) {
        skipped += "grant:$permission:not_on_api_${Build.VERSION.SDK_INT}"
        continue
      }
      if (permission !in declared) {
        // Granting a permission the manifest never requested is a silent no-op
        // that reads as success. Say it out loud instead.
        skipped += "grant:$permission:not_declared"
        continue
      }
      runStep("grant:$permission", applied, failed) {
        val ok = dpm.setPermissionGrantState(
          admin,
          context.packageName,
          permission,
          DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED
        )
        if (!ok) throw IllegalStateException("platform refused grant")
      }
    }

    runStep("uninstall_blocked", applied, failed) {
      dpm.setUninstallBlocked(admin, context.packageName, true)
    }

    for (restriction in WAVE_1_RESTRICTIONS) {
      runStep("restrict:$restriction", applied, failed) {
        dpm.addUserRestriction(admin, restriction)
      }
    }

    applyFrp(context, dpm, admin, applied, skipped, failed)

    T0Config.noteLong(context, T0Config.KEY_WAVE1_APPLIED_AT, System.currentTimeMillis())
  }

  /**
   * Factory Reset Protection ties a post-wipe device to named accounts. Enabling
   * it with an EMPTY account list is the classic way to brick a fleet: the phone
   * demands an account nobody can supply. So an empty list means "do not enable",
   * never "enable with no owner".
   */
  private fun applyFrp(
    context: Context,
    dpm: DevicePolicyManager,
    admin: ComponentName,
    applied: MutableList<String>,
    skipped: MutableList<String>,
    failed: MutableList<String>
  ) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      skipped += "frp:needs_api_30"
      return
    }
    val accounts = T0Config.snapshot(context).guardianFrpAccounts
    if (accounts.isEmpty()) {
      skipped += "frp:no_guardian_account_provisioned"
      return
    }
    runStep("frp_policy", applied, failed) { setFrpPolicy(dpm, admin, accounts) }
  }

  /**
   * Kept in its own method so ART only ever has to resolve
   * FactoryResetProtectionPolicy when this runs. Referencing an API-30 class from
   * inside a method that also runs on API 26 makes the verifier soft-fail the
   * whole method, which on some OEM runtimes turns into a hard reject.
   * `accounts == null` clears the policy.
   */
  private fun setFrpPolicy(dpm: DevicePolicyManager, admin: ComponentName, accounts: List<String>?) {
    val policy = accounts?.let {
      FactoryResetProtectionPolicy.Builder()
        .setFactoryResetProtectionAccounts(it)
        .setFactoryResetProtectionEnabled(true)
        .build()
    }
    dpm.setFactoryResetProtectionPolicy(admin, policy)
  }

  // ── Wave 2 ──────────────────────────────────────────────────────────────────

  private fun applyWave2(
    context: Context,
    dpm: DevicePolicyManager,
    admin: ComponentName,
    applied: MutableList<String>,
    skipped: MutableList<String>,
    failed: MutableList<String>
  ) {
    val snapshot = T0Config.snapshot(context)
    val now = System.currentTimeMillis()

    if (snapshot.wave1AppliedAt == 0L) {
      skipped += "wave2:wave1_never_applied"
      return
    }
    val soaked = now - snapshot.wave1AppliedAt
    if (soaked < WAVE_2_MIN_SOAK_MS) {
      skipped += "wave2:soak_incomplete_${soaked / 86_400_000L}d_of_30d"
      return
    }
    if (snapshot.wave2ApprovedAt == 0L) {
      // Time alone is not evidence. Somebody has to look at the crash dashboard
      // and say "this build is stable" — that decision is what stamps the key.
      skipped += "wave2:not_approved_by_operator"
      return
    }

    // ★ Strictly sequential, and DISALLOW_DEBUGGING_FEATURES is the final entry.
    // If any earlier restriction fails we stop: applying the ADB lockout on a
    // device where the rest of the lockdown misbehaved is how fleets die.
    for (restriction in WAVE_2_RESTRICTIONS) {
      val before = failed.size
      runStep("restrict:$restriction", applied, failed) {
        dpm.addUserRestriction(admin, restriction)
      }
      if (failed.size != before) {
        skipped += "wave2:aborted_before_${WAVE_2_RESTRICTIONS.last()}"
        return
      }
    }

    T0Config.noteLong(context, T0Config.KEY_WAVE2_APPLIED_AT, now)
  }

  // ── Release ─────────────────────────────────────────────────────────────────

  /**
   * ★ The escape hatch, and the first thing that shipped.
   *
   * Authenticated by a SHA-256 of a guardian secret provisioned alongside the
   * emergency numbers. If NO token was ever provisioned the release is ALLOWED:
   * a provisioning bug must never be the reason a family cannot get their own
   * phone back. Failing closed here would mean the safest possible code produces
   * the least recoverable device.
   */
  fun release(context: Context, guardianToken: String?): Boolean {
    val dpm = dpm(context) ?: return false
    if (!isDeviceOwner(context)) {
      // Nothing to release. Reported as success because the caller's goal —
      // "this phone is not under management" — is already true.
      return true
    }
    if (!guardianAuthorised(context, guardianToken)) {
      Log.w(TAG, "release refused: guardian token mismatch")
      return false
    }

    val admin = KavachDeviceAdminReceiver.componentName(context)

    // Unwind in reverse order, and unwind BEFORE clearing ownership: once we stop
    // being device owner we lose the authority to remove our own restrictions,
    // and any that survive would be unremovable by anyone.
    for (restriction in (WAVE_2_RESTRICTIONS + WAVE_1_RESTRICTIONS).asReversed()) {
      try {
        dpm.clearUserRestriction(admin, restriction)
      } catch (t: Throwable) {
        Log.w(TAG, "could not clear $restriction", t)
      }
    }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        setFrpPolicy(dpm, admin, null)
      }
    } catch (t: Throwable) {
      Log.w(TAG, "could not clear FRP policy", t)
    }
    try {
      dpm.setUninstallBlocked(admin, context.packageName, false)
    } catch (t: Throwable) {
      Log.w(TAG, "could not unblock uninstall", t)
    }
    try {
      dpm.setPermissionPolicy(admin, DevicePolicyManager.PERMISSION_POLICY_PROMPT)
    } catch (t: Throwable) {
      Log.w(TAG, "could not restore permission prompt policy", t)
    }

    return try {
      // Deprecated in the SDK because it is not meant for production DPCs, and
      // used here for exactly the reason it exists: it is the only call by which
      // a device owner can relinquish itself without wiping the user's data.
      @Suppress("DEPRECATION")
      dpm.clearDeviceOwnerApp(context.packageName)
      T0Config.commitBlocking(
        context,
        mapOf(
          T0Config.KEY_WAVE1_APPLIED_AT to 0L,
          T0Config.KEY_WAVE2_APPLIED_AT to 0L,
          T0Config.KEY_WAVE2_APPROVED_AT to 0L
        )
      )
      true
    } catch (t: Throwable) {
      Log.e(TAG, "clearDeviceOwnerApp failed", t)
      false
    }
  }

  private fun guardianAuthorised(context: Context, token: String?): Boolean {
    val expected = T0Config.snapshot(context).guardianReleaseTokenSha256 ?: return true
    val supplied = sha256Hex(token.orEmpty())
    // Constant-time: the release token is a low-entropy guardian secret and a
    // timing oracle on a 64-char hex string is a genuinely practical attack.
    return MessageDigest.isEqual(
      supplied.toByteArray(Charsets.US_ASCII),
      expected.lowercase(Locale.US).toByteArray(Charsets.US_ASCII)
    )
  }

  private fun sha256Hex(value: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
    return digest.joinToString("") { String.format(Locale.US, "%02x", it) }
  }

  // ── Plumbing ────────────────────────────────────────────────────────────────

  private fun dpm(context: Context): DevicePolicyManager? =
    context.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager

  @Suppress("DEPRECATION")
  private fun declaredPermissions(context: Context): Set<String> = try {
    context.packageManager
      .getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
      .requestedPermissions
      ?.toSet()
      .orEmpty()
  } catch (t: Throwable) {
    Log.w(TAG, "cannot read declared permissions", t)
    emptySet()
  }

  private inline fun runStep(
    label: String,
    applied: MutableList<String>,
    failed: MutableList<String>,
    block: () -> Unit
  ) {
    try {
      block()
      applied += label
    } catch (t: Throwable) {
      Log.w(TAG, "step failed: $label", t)
      failed += "$label:${t.javaClass.simpleName}"
    }
  }

  private fun report(
    wave: Int,
    applied: List<String>,
    skipped: List<String>,
    failed: List<String>,
    isDeviceOwner: Boolean
  ): Bundle = Bundle().apply {
    putInt("wave", wave)
    putStringArray("applied", applied.toTypedArray())
    putStringArray("skipped", skipped.toTypedArray())
    putStringArray("failed", failed.toTypedArray())
    putBoolean("isDeviceOwner", isDeviceOwner)
  }
}
