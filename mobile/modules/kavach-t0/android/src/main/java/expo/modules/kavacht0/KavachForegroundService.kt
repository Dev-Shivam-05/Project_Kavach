package expo.modules.kavacht0

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * T0 · THE AGENT
 *
 * Runs in the `:t0` process (see AndroidManifest.xml for why) and is Direct Boot
 * aware, so it is alive minutes before the phone is first unlocked.
 *
 * Everything it needs in that window lives in device-protected storage (P-035):
 * emergency numbers, the policy snapshot, the signing key alias, peer
 * fingerprints and the last known location. It must not touch credential-
 * protected storage — SQLite, SecureStore, AsyncStorage — until
 * ACTION_USER_UNLOCKED arrives, because those reads throw before first unlock and
 * an exception here means no agent at all.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
class KavachForegroundService : Service() {

  private lateinit var dps: Context
  private var worker: HandlerThread? = null
  private var handler: Handler? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var incidentActive = false
  private var locationActive = false
  private var startedForeground = false

  /**
   * Direct Boot hand-off. The agent starts locked; when the user finally unlocks,
   * the credential-protected plane becomes readable and the JS side can take over
   * the incident. We register this at runtime rather than in the manifest because
   * ACTION_USER_UNLOCKED is only guaranteed to reach runtime-registered receivers.
   */
  private val unlockReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action != Intent.ACTION_USER_UNLOCKED) return
      T0Config.noteLong(dps, T0Config.KEY_LAST_UNLOCK_AT, System.currentTimeMillis())
      // The notification text is provisioned from JS; after unlock it may have
      // changed while we were locked, so re-read and repost rather than assume.
      refreshNotification()
    }
  }

  @Suppress("OVERRIDE_DEPRECATION", "DEPRECATION")
  private val locationListener = object : LocationListener {
    override fun onLocationChanged(location: Location) {
      T0Config.noteLocation(
        dps,
        location.latitude,
        location.longitude,
        location.accuracy.toDouble(),
        System.currentTimeMillis()
      )
    }

    // These three gained default implementations only in API 30. Kotlin does not
    // synthesise bridges for Java default methods, so omitting them would be an
    // AbstractMethodError on every API 26–29 device.
    override fun onProviderEnabled(provider: String) = Unit
    override fun onProviderDisabled(provider: String) = Unit
    override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) = Unit
  }

  private val tick = object : Runnable {
    override fun run() {
      try {
        pulse()
      } catch (t: Throwable) {
        // ADR-018: T0 fails OPEN. A pulse that throws must not end the agent.
        Log.w(TAG, "pulse failed", t)
      }
      handler?.postDelayed(this, if (incidentActive) INCIDENT_TICK_MS else IDLE_TICK_MS)
    }
  }

  override fun onCreate() {
    super.onCreate()
    dps = applicationContext.createDeviceProtectedStorageContext()
    createChannel()

    val thread = HandlerThread("kavach-t0-agent").also { it.start() }
    worker = thread
    handler = Handler(thread.looper)

    ContextCompat.registerReceiver(
      this,
      unlockReceiver,
      IntentFilter(Intent.ACTION_USER_UNLOCKED),
      ContextCompat.RECEIVER_NOT_EXPORTED
    )
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // A null intent means the system restarted us after killing the process.
    // The answer to "should I be running?" lives in device-protected storage,
    // never in the intent, precisely so that this path works.
    if (intent?.action == ACTION_STOP) {
      T0Config.noteBool(dps, T0Config.KEY_AGENT_ENABLED, false)
      shutdownAgent()
      return START_NOT_STICKY
    }

    // Anything that is not an explicit STOP means "run". We never bail out before
    // calling startForeground: the system started us with startForegroundService
    // and adds its own crash on top of ours if we die without answering it.
    val snapshot = T0Config.snapshot(dps)
    T0Config.noteBool(dps, T0Config.KEY_AGENT_ENABLED, true)
    incidentActive = snapshot.incidentActive

    if (!promoteToForeground(snapshot)) {
      // Android 14+ refuses a foreground service whose declared types are not
      // backed by granted permissions. Say so in the diagnostics record instead
      // of dying silently — P-031 exists so the user learns this from the app.
      T0Config.noteString(dps, T0Config.KEY_AGENT_BLOCKED_REASON, BLOCKED_NO_FGS_TYPE)
      stopSelf()
      return START_NOT_STICKY
    }
    T0Config.noteString(dps, T0Config.KEY_AGENT_BLOCKED_REASON, "")

    handler?.removeCallbacks(tick)
    handler?.post(tick)

    // START_STICKY: if the OOM killer takes the whole :t0 process, we want it back.
    return START_STICKY
  }

  override fun onDestroy() {
    T0Config.noteLong(dps, T0Config.KEY_AGENT_STOPPED_AT, System.currentTimeMillis())
    shutdownAgent()
    try {
      unregisterReceiver(unlockReceiver)
    } catch (t: Throwable) {
      Log.w(TAG, "unlock receiver already gone", t)
    }
    worker?.quitSafely()
    worker = null
    handler = null
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  // ── The pulse ───────────────────────────────────────────────────────────────

  /**
   * One heartbeat. Three jobs, all of which have to survive a locked device:
   *  1. stamp liveness so BootReceiver can measure how long T0 was dead (F-04);
   *  2. keep a location fix warm during an incident so the Final Breath packet
   *     (P-022) has coordinates even if the phone dies a second from now;
   *  3. keep the persistent notification honest about what is happening (P-066).
   */
  private fun pulse() {
    val snapshot = T0Config.snapshot(dps)
    val wasIncident = incidentActive
    incidentActive = snapshot.incidentActive

    T0Config.noteHeartbeat(dps, System.currentTimeMillis(), readBatteryPct())

    if (incidentActive) {
      holdWakeLock()
      startLocationUpdates()
    } else {
      releaseWakeLock()
      stopLocationUpdates()
    }

    // Reposting an unchanged notification every minute wakes the shade animator
    // for nothing, so only repost when the state the user can see has changed.
    if (wasIncident != incidentActive) {
      refreshNotification()
    }
  }

  private fun readBatteryPct(): Int {
    // ACTION_BATTERY_CHANGED is a sticky broadcast and is readable before unlock.
    val battery = try {
      registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    } catch (t: Throwable) {
      Log.w(TAG, "battery unreadable", t)
      null
    } ?: return -1
    val level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
    val scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
    if (level < 0 || scale <= 0) return -1
    return (level * 100) / scale
  }

  // ── Foreground promotion ────────────────────────────────────────────────────

  private fun promoteToForeground(snapshot: T0Snapshot): Boolean {
    val notification = buildNotification(snapshot)
    val types = allowedForegroundTypes()

    return try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, types)
      startedForeground = true
      true
    } catch (t: Throwable) {
      // Android 14+ rejects a foreground service whose type is not backed by a
      // granted permission, and rejects type 0 outright. We attempt the call
      // regardless so the platform sees an answer to its startForegroundService
      // contract; only then is stopping safe.
      Log.e(TAG, "startForeground rejected (types=$types)", t)
      false
    }
  }

  /**
   * The manifest declares `location|connectedDevice`; Android 14+ requires that
   * every type passed here be backed by a granted permission at the moment of the
   * call. Declaring both and then starting with a subset is legal — starting with
   * a type you cannot back is a SecurityException.
   */
  private fun allowedForegroundTypes(): Int {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return 0
    var types = 0
    if (granted(Manifest.permission.ACCESS_FINE_LOCATION) ||
      granted(Manifest.permission.ACCESS_COARSE_LOCATION)
    ) {
      types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
    }
    val bleOk = Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
      granted(Manifest.permission.BLUETOOTH_ADVERTISE) ||
      granted(Manifest.permission.BLUETOOTH_CONNECT)
    if (bleOk) {
      types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
    }
    return types
  }

  private fun buildNotification(snapshot: T0Snapshot): Notification {
    val title = snapshot.notifTitle.ifBlank { DEFAULT_TITLE }
    val body = when {
      snapshot.incidentActive -> snapshot.notifBody.ifBlank { DEFAULT_BODY_INCIDENT }
      else -> snapshot.notifBody.ifBlank { DEFAULT_BODY_IDLE }
    }

    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = launch?.let {
      PendingIntent.getActivity(
        this,
        0,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    }

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.kavach_t0_status)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setOngoing(true)
      .setShowWhen(false)
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      // P-066: the persistent notification is a statement of fact, not an alarm.
      // VISIBILITY_PUBLIC keeps that statement readable on the lock screen, which
      // is where a first responder will actually look.
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setForegroundServiceBehavior(
        if (snapshot.incidentActive) {
          NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE
        } else {
          NotificationCompat.FOREGROUND_SERVICE_DEFERRED
        }
      )
      .apply { contentIntent?.let { setContentIntent(it) } }
      .build()
  }

  private fun refreshNotification() {
    if (!startedForeground) return
    val manager = getSystemService(NotificationManager::class.java) ?: return
    try {
      manager.notify(NOTIFICATION_ID, buildNotification(T0Config.snapshot(dps)))
    } catch (t: Throwable) {
      Log.w(TAG, "notify failed", t)
    }
  }

  private fun createChannel() {
    val manager = getSystemService(NotificationManager::class.java) ?: return
    // IMPORTANCE_LOW: no sound, no heads-up. The agent's own notification must
    // never be the thing that wakes someone up — only an incident may do that.
    val channel = NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW)
    channel.description = CHANNEL_DESCRIPTION
    channel.setShowBadge(false)
    channel.enableVibration(false)
    channel.setSound(null, null)
    try {
      manager.createNotificationChannel(channel)
    } catch (t: Throwable) {
      Log.w(TAG, "channel creation failed", t)
    }
  }

  // ── Wake lock ───────────────────────────────────────────────────────────────

  /**
   * Re-acquired on every incident pulse with a bounded timeout instead of taken
   * once and held forever. An unbounded partial wake lock that outlives a crash
   * flattens the battery in a few hours, and a phone that is dead by evening
   * cannot answer the next incident (P-006 — an uninstalled app protects nobody).
   */
  private fun holdWakeLock() {
    val pm = getSystemService(PowerManager::class.java) ?: return
    val lock = wakeLock ?: pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG).also {
      it.setReferenceCounted(false)
      wakeLock = it
    }
    try {
      lock.acquire(WAKE_LOCK_TIMEOUT_MS)
    } catch (t: Throwable) {
      Log.w(TAG, "wake lock refused", t)
    }
  }

  private fun releaseWakeLock() {
    val lock = wakeLock ?: return
    try {
      if (lock.isHeld) lock.release()
    } catch (t: Throwable) {
      Log.w(TAG, "wake lock release failed", t)
    }
  }

  // ── Location ────────────────────────────────────────────────────────────────

  private fun startLocationUpdates() {
    if (locationActive) return
    if (!granted(Manifest.permission.ACCESS_FINE_LOCATION) &&
      !granted(Manifest.permission.ACCESS_COARSE_LOCATION)
    ) {
      return
    }
    val lm = getSystemService(LocationManager::class.java) ?: return
    val looper = worker?.looper ?: return

    // Both providers, deliberately. GPS is the only one that works in a field with
    // no cell coverage; network is the only one that works indoors. During an
    // incident the battery cost of running both is irrelevant.
    var any = false
    for (provider in arrayOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
      try {
        if (!lm.isProviderEnabled(provider)) continue
        lm.requestLocationUpdates(provider, LOCATION_INTERVAL_MS, LOCATION_MIN_DIST_M, locationListener, looper)
        any = true
      } catch (t: Throwable) {
        Log.w(TAG, "provider $provider unavailable", t)
      }
    }
    locationActive = any
  }

  private fun stopLocationUpdates() {
    if (!locationActive) return
    val lm = getSystemService(LocationManager::class.java)
    try {
      lm?.removeUpdates(locationListener)
    } catch (t: Throwable) {
      Log.w(TAG, "removeUpdates failed", t)
    }
    locationActive = false
  }

  // ── Teardown ────────────────────────────────────────────────────────────────

  private fun shutdownAgent() {
    handler?.removeCallbacks(tick)
    stopLocationUpdates()
    releaseWakeLock()
    if (startedForeground) {
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
      startedForeground = false
    }
    stopSelf()
  }

  private fun granted(permission: String): Boolean =
    ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

  companion object {
    const val ACTION_START = "expo.modules.kavacht0.action.START_AGENT"
    const val ACTION_STOP = "expo.modules.kavacht0.action.STOP_AGENT"

    private const val TAG = "KavachT0/Agent"
    private const val CHANNEL_ID = "kavach_t0_agent"
    private const val CHANNEL_NAME = "Safety agent"
    private const val CHANNEL_DESCRIPTION =
      "Shows that Kavach is watching. Required by Android for a service that keeps running."
    private const val NOTIFICATION_ID = 0x7A0

    private const val DEFAULT_TITLE = "Kavach is on"
    private const val DEFAULT_BODY_IDLE = "Watching quietly. Nothing is wrong."
    private const val DEFAULT_BODY_INCIDENT = "An incident is open. Keeping your location fresh."

    private const val BLOCKED_NO_FGS_TYPE = "no_foreground_service_type_permitted"

    private const val IDLE_TICK_MS = 60_000L
    private const val INCIDENT_TICK_MS = 10_000L
    private const val WAKE_LOCK_TAG = "kavach:t0-incident"
    private const val WAKE_LOCK_TIMEOUT_MS = 15L * 60L * 1000L
    private const val LOCATION_INTERVAL_MS = 5_000L
    private const val LOCATION_MIN_DIST_M = 10f

    /** Idempotent: safe to call from JS, from BootReceiver, and from a restart. */
    fun start(context: Context) {
      val intent = Intent(context, KavachForegroundService::class.java).setAction(ACTION_START)
      try {
        ContextCompat.startForegroundService(context, intent)
      } catch (t: Throwable) {
        // Android 12+ throws ForegroundServiceStartNotAllowedException if we are
        // in the background without an exemption. BOOT_COMPLETED and
        // LOCKED_BOOT_COMPLETED are exempt, which is why those are our entry points.
        Log.e(TAG, "cannot start agent", t)
      }
    }

    fun stop(context: Context) {
      val intent = Intent(context, KavachForegroundService::class.java).setAction(ACTION_STOP)
      try {
        context.startService(intent)
      } catch (t: Throwable) {
        Log.w(TAG, "cannot deliver stop", t)
      }
    }
  }
}

/**
 * Everything T0 knows, frozen at one instant. Read from device-protected storage,
 * so every field here is available before first unlock (P-035).
 */
data class T0Snapshot(
  val agentEnabled: Boolean,
  val notifTitle: String,
  val notifBody: String,
  val incidentActive: Boolean,
  val incidentId8: String,
  val emergencyNumbers: List<String>,
  val policySnapshotJson: String,
  val signingKeyAlias: String?,
  val peerFingerprints: List<String>,
  val preferredSubscriptionId: Int,
  val guardianReleaseTokenSha256: String?,
  val guardianFrpAccounts: List<String>,
  val lastLat: Double?,
  val lastLon: Double?,
  val lastAccuracyM: Double?,
  val lastLocationAt: Long,
  val lastHeartbeatAt: Long,
  val lastBatteryPct: Int,
  val firstProvisionedAt: Long,
  val wave1AppliedAt: Long,
  val wave2ApprovedAt: Long,
  val wave2AppliedAt: Long
)

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * P-035 · THE PRE-UNLOCK CONFIG
 *
 * A single SharedPreferences file inside `createDeviceProtectedStorageContext()`.
 * That directory is encrypted with a device key rather than the user's credential,
 * so it is readable from the instant the kernel boots — which is the entire point.
 *
 * ★ It is therefore NOT protected by the user's PIN. Nothing secret goes in here:
 * emergency phone numbers, a key ALIAS (never key material), peer fingerprints and
 * a coarse last-known location. The signing key itself stays in the AndroidKeyStore
 * where the TEE holds it.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
object T0Config {
  private const val PREFS = "kavach_t0"
  private const val TAG = "KavachT0/Config"

  const val KEY_AGENT_ENABLED = "agentEnabled"
  const val KEY_AGENT_BLOCKED_REASON = "agentBlockedReason"
  const val KEY_AGENT_STOPPED_AT = "agentStoppedAt"
  const val KEY_LAST_UNLOCK_AT = "lastUnlockAt"
  const val KEY_LAST_HEARTBEAT_AT = "lastHeartbeatAt"
  const val KEY_LAST_BATTERY_PCT = "lastBatteryPct"
  const val KEY_INCIDENT_ACTIVE = "incidentActive"
  const val KEY_INCIDENT_ID8 = "incidentId8"
  const val KEY_NOTIF_TITLE = "notifTitle"
  const val KEY_NOTIF_BODY = "notifBody"
  const val KEY_EMERGENCY_NUMBERS = "emergencyNumbers"
  const val KEY_POLICY_SNAPSHOT = "policySnapshotJson"
  const val KEY_SIGNING_KEY_ALIAS = "signingKeyAlias"
  const val KEY_PEER_FINGERPRINTS = "peerFingerprints"
  const val KEY_PREFERRED_SUB_ID = "preferredSubscriptionId"
  const val KEY_GUARDIAN_RELEASE_SHA = "guardianReleaseTokenSha256"
  const val KEY_GUARDIAN_FRP_ACCOUNTS = "guardianFrpAccounts"
  const val KEY_LAST_LAT = "lastLat"
  const val KEY_LAST_LON = "lastLon"
  const val KEY_LAST_ACC_M = "lastAccuracyM"
  const val KEY_LAST_LOC_AT = "lastLocationAt"
  const val KEY_FIRST_PROVISIONED_AT = "firstProvisionedAt"
  const val KEY_WAVE1_APPLIED_AT = "wave1AppliedAt"
  const val KEY_WAVE2_APPROVED_AT = "wave2ApprovedAt"
  const val KEY_WAVE2_APPLIED_AT = "wave2AppliedAt"
  const val KEY_LAST_BOOT_AT = "lastBootAt"
  const val KEY_LAST_SHUTDOWN_AT = "lastShutdownAt"
  const val KEY_LAST_SHUTDOWN_KIND = "lastShutdownKind"
  const val KEY_FINAL_BREATH_AT = "finalBreathAt"
  const val KEY_FINAL_BREATH_RESULT = "finalBreathResult"

  /**
   * Always resolves the device-protected variant, even when handed the ordinary
   * context. Getting this wrong is invisible until 3 a.m. on a locked phone.
   */
  fun prefs(context: Context): SharedPreferences {
    val protectedContext =
      if (context.isDeviceProtectedStorage) context else context.createDeviceProtectedStorageContext()
    return protectedContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  }

  fun snapshot(context: Context): T0Snapshot {
    val p = prefs(context)
    return T0Snapshot(
      agentEnabled = p.getBoolean(KEY_AGENT_ENABLED, false),
      notifTitle = p.getString(KEY_NOTIF_TITLE, "").orEmpty(),
      notifBody = p.getString(KEY_NOTIF_BODY, "").orEmpty(),
      incidentActive = p.getBoolean(KEY_INCIDENT_ACTIVE, false),
      incidentId8 = p.getString(KEY_INCIDENT_ID8, "").orEmpty(),
      emergencyNumbers = splitCsv(p.getString(KEY_EMERGENCY_NUMBERS, "")),
      policySnapshotJson = p.getString(KEY_POLICY_SNAPSHOT, "").orEmpty(),
      signingKeyAlias = p.getString(KEY_SIGNING_KEY_ALIAS, null)?.takeIf { it.isNotBlank() },
      peerFingerprints = splitCsv(p.getString(KEY_PEER_FINGERPRINTS, "")),
      preferredSubscriptionId = p.getInt(KEY_PREFERRED_SUB_ID, -1),
      guardianReleaseTokenSha256 = p.getString(KEY_GUARDIAN_RELEASE_SHA, null)?.takeIf { it.isNotBlank() },
      guardianFrpAccounts = splitCsv(p.getString(KEY_GUARDIAN_FRP_ACCOUNTS, "")),
      lastLat = p.getString(KEY_LAST_LAT, null)?.toDoubleOrNull(),
      lastLon = p.getString(KEY_LAST_LON, null)?.toDoubleOrNull(),
      lastAccuracyM = p.getString(KEY_LAST_ACC_M, null)?.toDoubleOrNull(),
      lastLocationAt = p.getLong(KEY_LAST_LOC_AT, 0L),
      lastHeartbeatAt = p.getLong(KEY_LAST_HEARTBEAT_AT, 0L),
      lastBatteryPct = p.getInt(KEY_LAST_BATTERY_PCT, -1),
      firstProvisionedAt = p.getLong(KEY_FIRST_PROVISIONED_AT, 0L),
      wave1AppliedAt = p.getLong(KEY_WAVE1_APPLIED_AT, 0L),
      wave2ApprovedAt = p.getLong(KEY_WAVE2_APPROVED_AT, 0L),
      wave2AppliedAt = p.getLong(KEY_WAVE2_APPLIED_AT, 0L)
    )
  }

  /**
   * Copies whatever JS chose to provision into the pre-unlock plane. Absent
   * fields are LEFT ALONE rather than cleared: `startForegroundAgent` is called
   * on every app launch with only title/body/incidentActive, and wiping the
   * emergency numbers on each launch would empty T0 exactly when it matters.
   */
  fun writeProvisioning(context: Context, options: ForegroundAgentOptions) {
    val p = prefs(context)
    val e = p.edit()
    e.putString(KEY_NOTIF_TITLE, options.title)
    e.putString(KEY_NOTIF_BODY, options.body)
    e.putBoolean(KEY_INCIDENT_ACTIVE, options.incidentActive)
    options.incidentId8?.let { e.putString(KEY_INCIDENT_ID8, it) }
    options.emergencyNumbers?.let { e.putString(KEY_EMERGENCY_NUMBERS, joinCsv(it)) }
    options.policySnapshotJson?.let { e.putString(KEY_POLICY_SNAPSHOT, it) }
    options.signingKeyAlias?.let { e.putString(KEY_SIGNING_KEY_ALIAS, it) }
    options.peerFingerprints?.let { e.putString(KEY_PEER_FINGERPRINTS, joinCsv(it)) }
    options.preferredSubscriptionId?.let { e.putInt(KEY_PREFERRED_SUB_ID, it) }
    options.guardianReleaseTokenSha256?.let { e.putString(KEY_GUARDIAN_RELEASE_SHA, it.lowercase()) }
    options.guardianFrpAccounts?.let { e.putString(KEY_GUARDIAN_FRP_ACCOUNTS, joinCsv(it)) }
    options.lastKnownLat?.let { e.putString(KEY_LAST_LAT, it.toString()) }
    options.lastKnownLon?.let { e.putString(KEY_LAST_LON, it.toString()) }
    options.lastKnownAccuracyM?.let { e.putString(KEY_LAST_ACC_M, it.toString()) }
    options.lastKnownAt?.let { e.putLong(KEY_LAST_LOC_AT, it.toLong()) }
    if (p.getLong(KEY_FIRST_PROVISIONED_AT, 0L) == 0L) {
      e.putLong(KEY_FIRST_PROVISIONED_AT, System.currentTimeMillis())
    }
    e.apply()
  }

  fun noteHeartbeat(context: Context, at: Long, batteryPct: Int) {
    prefs(context).edit()
      .putLong(KEY_LAST_HEARTBEAT_AT, at)
      .putInt(KEY_LAST_BATTERY_PCT, batteryPct)
      .apply()
  }

  fun noteLocation(context: Context, lat: Double, lon: Double, accuracyM: Double, at: Long) {
    prefs(context).edit()
      .putString(KEY_LAST_LAT, lat.toString())
      .putString(KEY_LAST_LON, lon.toString())
      .putString(KEY_LAST_ACC_M, accuracyM.toString())
      .putLong(KEY_LAST_LOC_AT, at)
      .apply()
  }

  fun noteBool(context: Context, key: String, value: Boolean) {
    prefs(context).edit().putBoolean(key, value).apply()
  }

  fun noteLong(context: Context, key: String, value: Long) {
    prefs(context).edit().putLong(key, value).apply()
  }

  fun noteString(context: Context, key: String, value: String) {
    prefs(context).edit().putString(key, value).apply()
  }

  /**
   * The only synchronous writer. Used exclusively by ShutdownReceiver (P-022):
   * `apply()` returns before the bytes hit the disk, and during ACTION_SHUTDOWN
   * there is no "later" in which the background write could complete.
   */
  fun commitBlocking(context: Context, values: Map<String, Any?>): Boolean {
    val e = prefs(context).edit()
    for ((key, value) in values) {
      when (value) {
        is Boolean -> e.putBoolean(key, value)
        is Int -> e.putInt(key, value)
        is Long -> e.putLong(key, value)
        is String -> e.putString(key, value)
        null -> e.remove(key)
        else -> e.putString(key, value.toString())
      }
    }
    return try {
      e.commit()
    } catch (t: Throwable) {
      Log.e(TAG, "final commit failed", t)
      false
    }
  }

  private fun splitCsv(raw: String?): List<String> =
    raw.orEmpty().split(',').map { it.trim() }.filter { it.isNotEmpty() }

  private fun joinCsv(values: List<String>): String =
    values.map { it.trim() }.filter { it.isNotEmpty() }.joinToString(",")
}
