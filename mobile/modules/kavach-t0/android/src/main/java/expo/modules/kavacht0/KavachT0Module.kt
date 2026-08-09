package expo.modules.kavacht0

import android.Manifest
import android.app.Activity
import android.app.ActivityManager
import android.app.AlarmManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.AdvertisingSet
import android.bluetooth.le.AdvertisingSetCallback
import android.bluetooth.le.AdvertisingSetParameters
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelUuid
import android.os.PowerManager
import android.provider.Settings
import android.security.keystore.KeyInfo
import android.telephony.SmsManager
import android.telephony.SubscriptionManager
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.security.KeyFactory
import java.security.KeyStore
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * KavachT0 · THE NATIVE TIER-0 PLANE (ADR-015)
 *
 * The JS bridge in `src/t0/native.ts` degrades every one of these calls when this
 * module is absent, which is what makes Expo Go usable. What it CANNOT do without
 * us is the part that matters at 3 a.m.: send an SMS with no user tap, on every
 * SIM, from a locked screen, with the app force-stopped.
 *
 * Function names and signatures here are load-bearing — they are matched by name
 * against the `KavachT0Module` interface in native.ts. Renaming one silently
 * degrades the app to the composer-needs-a-tap fallback instead of failing loudly.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
class KavachT0Module : Module() {

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  /** SMS fan-out blocks on delivery acks; it must never occupy the module queue. */
  private var smsExecutor: ExecutorService? = null
  private var auxThread: HandlerThread? = null
  private var auxHandler: Handler? = null

  private var torchCameraId: String? = null
  private var legacyAdvertiseCallback: AdvertiseCallback? = null
  private var extendedAdvertiseCallback: AdvertisingSetCallback? = null
  private val requestCodes = AtomicInteger(1)

  override fun definition() = ModuleDefinition {
    Name("KavachT0")

    OnCreate {
      smsExecutor = Executors.newSingleThreadExecutor { r -> Thread(r, "kavach-t0-sms") }
      // One auxiliary looper for the proximity read and the BLE TTL stop. Both
      // are short callbacks that must not run on the JS thread or on the module
      // queue that sendSmsDirect is already blocking.
      val thread = HandlerThread("kavach-t0-aux").also { it.start() }
      auxThread = thread
      auxHandler = Handler(thread.looper)
    }

    OnDestroy {
      // Leaving the torch on or an advertisement running after the JS context
      // dies is the kind of battery burn that gets a safety app uninstalled.
      runCatching { applyTorch(false) }
      runCatching { stopAdvertising() }
      smsExecutor?.shutdownNow()
      smsExecutor = null
      auxThread?.quitSafely()
      auxThread = null
      auxHandler = null
    }

    // ── P-033 · multi-SIM silent SMS ──────────────────────────────────────────
    AsyncFunction("sendSmsDirect") { numbers: List<String>, body: String, promise: Promise ->
      val executor = smsExecutor
      if (executor == null) {
        promise.reject(T0NotReadyException())
        return@AsyncFunction
      }
      val ctx = context.applicationContext
      executor.execute {
        try {
          promise.resolve(dispatchSms(ctx, numbers, body))
        } catch (t: Throwable) {
          promise.reject(SmsDispatchException(t))
        }
      }
    }

    AsyncFunction("setTorch") { on: Boolean -> applyTorch(on) }

    AsyncFunction("getAlarmVolume") {
      val audio = audioManager()
      Bundle().apply {
        putInt("current", audio.getStreamVolume(AudioManager.STREAM_ALARM))
        putInt("max", audio.getStreamMaxVolume(AudioManager.STREAM_ALARM))
      }
    }

    AsyncFunction("setAlarmVolume") { level: Double -> applyAlarmVolume(level) }

    AsyncFunction("isDeviceOwner") { DeviceOwnerConfigurator.isDeviceOwner(context) }

    AsyncFunction("checkPermissions") { collectPermissions() }

    AsyncFunction("startForegroundAgent") { options: ForegroundAgentOptions ->
      // Provision first, start second. The agent reads its configuration from
      // device-protected storage on startup (P-035); writing after the start
      // would race the very first pulse.
      T0Config.writeProvisioning(context, options)
      KavachForegroundService.start(context)
    }

    AsyncFunction("stopForegroundAgent") {
      T0Config.noteBool(context, T0Config.KEY_AGENT_ENABLED, false)
      KavachForegroundService.stop(context)
    }

    AsyncFunction("getProximityCm") { promise: Promise -> readProximity(promise) }

    AsyncFunction("bleAdvertise") { payloadBase64: String, ttlMs: Double, promise: Promise ->
      startAdvertising(payloadBase64, ttlMs.toLong(), promise)
    }

    AsyncFunction("bleStopAdvertise") { stopAdvertising() }

    AsyncFunction("openOemSettings") { intent: String -> openOemSettings(intent) }

    AsyncFunction("applyDeviceOwnerPolicy") { wave: Int ->
      DeviceOwnerConfigurator.applyWave(context, wave)
    }

    AsyncFunction("releaseDeviceOwner") { guardianToken: String ->
      DeviceOwnerConfigurator.release(context, guardianToken)
    }

    // ── F-17 · signing keys the JS runtime cannot read ────────────────────────
    // Key generation with StrongBox can take a second or two on some chipsets,
    // which is why all four are Async: they run on the module queue, never on
    // the JS thread. `src/crypto/hardware.ts` treats a rejection here as
    // "no hardware key" and drops to the software key rather than failing.

    AsyncFunction("keyVaultEnsure") { alias: String -> KeyVault.ensure(context, alias) }

    AsyncFunction("keyVaultInfo") { alias: String -> KeyVault.keyInfo(context, alias) }

    AsyncFunction("keyVaultSign") { alias: String, payloadBase64: String ->
      KeyVault.sign(alias, payloadBase64)
    }

    AsyncFunction("keyVaultPublicKey") { alias: String -> KeyVault.publicKey(alias) }
  }

  // ══ SMS ═══════════════════════════════════════════════════════════════════════

  /**
   * ★ Sends on EVERY active SIM, simultaneously, always.
   *
   * Android exposes no API for prepaid balance, signal-per-SIM history, or
   * whether the operator has barred outgoing SMS. There is therefore no honest
   * way to pick "the SIM that will work" — the only correct algorithm is to try
   * all of them and let whichever one has credit win. At ₹0.40 a message, the
   * cost of being wrong about which SIM works is the entire point of the product.
   *
   * The attempt ORDER still matters even though we send on all of them: it is the
   * order the modem services the requests in, so the guardian's preferred SIM gets
   * the radio first, then the system default, then everything else (P-033).
   */
  private fun dispatchSms(ctx: Context, numbers: List<String>, body: String): Bundle {
    val recipients = numbers
      .map { raw -> raw.filter { it.isDigit() || it == '+' } }
      .filter { it.length >= MIN_DIALABLE_LENGTH }
      .distinct()

    if (recipients.isEmpty()) {
      return smsResult(emptyList(), emptyList(), emptyList(), emptyList(), false)
    }

    if (!granted(ctx, Manifest.permission.SEND_SMS)) {
      // Every recipient fails, and we say exactly why. A silent zero-send here
      // would show up in the incident log as "SMS attempted" and nobody would
      // ever learn the permission was missing (P-031).
      val detail = recipients.map { simBundle(-1, -1, "", it, STATUS_SKIPPED, "SEND_SMS not granted") }
      return smsResult(emptyList(), recipients, detail, emptyList(), false)
    }

    val preferred = try {
      T0Config.snapshot(ctx).preferredSubscriptionId
    } catch (t: Throwable) {
      Log.w(TAG, "preferred SIM unreadable", t)
      -1
    }
    val targets = T0Sms.orderedSubscriptions(ctx, preferred)

    // Pass 1: build the plan. divideMessage is pure, so we can learn the exact
    // number of acks to expect before a single message leaves the device.
    val plans = mutableListOf<SmsPlan>()
    val upfrontFailures = mutableListOf<Bundle>()
    for (target in targets) {
      val manager = T0Sms.smsManagerFor(ctx, target.subscriptionId)
      if (manager == null) {
        for (number in recipients) {
          upfrontFailures += simBundle(
            target.subscriptionId, target.slotIndex, target.carrier, number,
            STATUS_ERROR, "no SmsManager for this subscription"
          )
        }
        continue
      }
      for (number in recipients) {
        val parts = try {
          manager.divideMessage(body) ?: arrayListOf(body)
        } catch (t: Throwable) {
          Log.w(TAG, "divideMessage failed", t)
          arrayListOf(body)
        }
        plans += SmsPlan(target, manager, number, parts, "${target.subscriptionId}#$number")
      }
    }

    if (plans.isEmpty()) {
      return smsResult(emptyList(), recipients, upfrontFailures, targets.map { it.subscriptionId }, false)
    }

    val expectedAcks = plans.sumOf { it.parts.size }
    val latch = CountDownLatch(expectedAcks)
    val outcomes = ConcurrentHashMap<String, Int>()
    val action = "${ctx.packageName}.$SENT_ACTION_SUFFIX"

    val receiver = object : BroadcastReceiver() {
      override fun onReceive(received: Context?, intent: Intent?) {
        val token = intent?.getStringExtra(EXTRA_TOKEN) ?: return
        val code = resultCode
        // Keep the FIRST failure rather than the last success: one failed part of
        // a concatenated message means the recipient did not get the message.
        outcomes.compute(token) { _, previous ->
          if (previous != null && previous != Activity.RESULT_OK) previous else code
        }
        latch.countDown()
      }
    }

    ContextCompat.registerReceiver(
      ctx, receiver, IntentFilter(action), ContextCompat.RECEIVER_NOT_EXPORTED
    )

    val dispatchErrors = ConcurrentHashMap<String, String>()
    try {
      // Pass 2: fire. Every send is a binder call that returns in milliseconds;
      // the acks arrive on the main thread while this worker waits on the latch.
      for (plan in plans) {
        val sentIntents = ArrayList<PendingIntent>(plan.parts.size)
        repeat(plan.parts.size) { sentIntents += sentPendingIntent(ctx, action, plan.token) }
        try {
          if (plan.parts.size == 1) {
            plan.manager.sendTextMessage(plan.number, null, plan.parts[0], sentIntents[0], null)
          } else {
            plan.manager.sendMultipartTextMessage(
              plan.number, null, plan.parts, sentIntents, null
            )
          }
        } catch (t: Throwable) {
          dispatchErrors[plan.token] = t.javaClass.simpleName + ": " + (t.message ?: "refused")
          // The acks for this plan will never arrive; release their latch slots
          // or we would wait the full timeout for a send that never happened.
          repeat(plan.parts.size) { latch.countDown() }
        }
      }

      // Resolves the instant every ack is in. The timeout only bites when a SIM
      // has no service and the modem silently holds the request — reporting that
      // as `pending` rather than `error` is the honest reading (see SimSendStatus).
      latch.await(SMS_ACK_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    } finally {
      try {
        ctx.unregisterReceiver(receiver)
      } catch (t: Throwable) {
        Log.w(TAG, "sms receiver already unregistered", t)
      }
    }

    // Pass 3: score.
    val perSim = mutableListOf<Bundle>()
    perSim += upfrontFailures
    val okNumbers = mutableSetOf<String>()
    val pendingNumbers = mutableSetOf<String>()

    for (plan in plans) {
      val dispatchError = dispatchErrors[plan.token]
      val code = outcomes[plan.token]
      val (status, detail) = when {
        dispatchError != null -> STATUS_ERROR to dispatchError
        code == null -> STATUS_PENDING to "no ack within ${SMS_ACK_TIMEOUT_MS / 1000}s"
        code == Activity.RESULT_OK -> STATUS_OK to "accepted by the network"
        else -> STATUS_ERROR to describeSmsResult(code)
      }
      when (status) {
        STATUS_OK -> okNumbers += plan.number
        STATUS_PENDING -> pendingNumbers += plan.number
      }
      perSim += simBundle(
        plan.target.subscriptionId, plan.target.slotIndex, plan.target.carrier,
        plan.number, status, detail
      )
    }

    // A recipient counts as reached if ANY SIM acked, or if a SIM accepted the
    // message and simply has not acked yet. Only a recipient that every SIM
    // explicitly rejected is a failure worth escalating over.
    val sent = recipients.filter { it in okNumbers || it in pendingNumbers }
    val failed = recipients.filterNot { it in sent }

    return smsResult(
      sent, failed, perSim, targets.map { it.subscriptionId },
      plans.any { it.parts.size > 1 }
    )
  }

  /**
   * FLAG_IMMUTABLE on purpose. The telephony framework only needs to set the
   * broadcast's RESULT CODE, which immutability does not block; what it would be
   * able to do with a mutable PendingIntent is rewrite the target of an intent
   * that carries our incident token. We trade the optional "errorCode" extra for
   * not handing out a rewritable intent, and map the result code instead.
   */
  private fun sentPendingIntent(ctx: Context, action: String, token: String): PendingIntent {
    val intent = Intent(action)
      .setPackage(ctx.packageName)
      .putExtra(EXTRA_TOKEN, token)
    return PendingIntent.getBroadcast(
      ctx,
      requestCodes.getAndIncrement(),
      intent,
      PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun describeSmsResult(code: Int): String = when (code) {
    SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "generic failure (often: no balance)"
    SmsManager.RESULT_ERROR_RADIO_OFF -> "radio off / airplane mode"
    SmsManager.RESULT_ERROR_NULL_PDU -> "null PDU"
    SmsManager.RESULT_ERROR_NO_SERVICE -> "no service on this SIM"
    SmsManager.RESULT_ERROR_LIMIT_EXCEEDED -> "SMS rate limit exceeded"
    SmsManager.RESULT_ERROR_FDN_CHECK_FAILURE -> "blocked by fixed dialling numbers"
    SmsManager.RESULT_ERROR_SHORT_CODE_NOT_ALLOWED -> "short code not allowed"
    SmsManager.RESULT_ERROR_SHORT_CODE_NEVER_ALLOWED -> "short code never allowed"
    SmsManager.RESULT_RADIO_NOT_AVAILABLE -> "radio not available"
    else -> "result code $code"
  }

  private fun simBundle(
    subscriptionId: Int,
    slotIndex: Int,
    carrier: String,
    recipient: String,
    status: String,
    detail: String
  ): Bundle = Bundle().apply {
    putInt("subscriptionId", subscriptionId)
    putInt("slotIndex", slotIndex)
    putString("carrier", carrier)
    putString("recipient", recipient)
    putString("status", status)
    putString("detail", detail)
  }

  private fun smsResult(
    sent: List<String>,
    failed: List<String>,
    perSim: List<Bundle>,
    attemptOrder: List<Int>,
    multipart: Boolean
  ): Bundle = Bundle().apply {
    putStringArray("sent", sent.toTypedArray())
    putStringArray("failed", failed.toTypedArray())
    putParcelableArray("perSim", perSim.toTypedArray())
    putIntArray("attemptOrder", attemptOrder.toIntArray())
    putBoolean("multipart", multipart)
  }

  // ══ Torch ═════════════════════════════════════════════════════════════════════

  /**
   * `CameraManager.setTorchMode` rather than a CameraView: it needs no CAMERA
   * permission, no preview surface, and no Activity — so the strobe keeps running
   * with the screen off, which is the only state it is ever actually used in.
   */
  private fun applyTorch(on: Boolean) {
    val manager = context.getSystemService(Context.CAMERA_SERVICE) as? CameraManager
      ?: throw TorchUnavailableException("no camera service")
    val id = torchCameraId ?: manager.cameraIdList.firstOrNull { candidate ->
      manager.getCameraCharacteristics(candidate)
        .get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
    } ?: throw TorchUnavailableException("no camera on this device has a flash")
    torchCameraId = id
    try {
      manager.setTorchMode(id, on)
    } catch (t: Throwable) {
      // Thrown when another app holds the camera. The torch is a comfort signal,
      // never a transport, so the caller is entitled to a clear error rather than
      // a silent success.
      throw TorchUnavailableException(t.message ?: "torch refused by the camera service")
    }
  }

  // ══ Alarm volume ══════════════════════════════════════════════════════════════

  private fun audioManager(): AudioManager =
    context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
      ?: throw T0NotReadyException()

  private fun applyAlarmVolume(level: Double) {
    val audio = audioManager()
    val max = audio.getStreamMaxVolume(AudioManager.STREAM_ALARM)
    val target = Math.round(level).toInt().coerceIn(0, max)
    try {
      // FLAG 0: no UI slider, no beep. An incident alarm must not announce itself
      // with a volume-change chime before the actual siren.
      audio.setStreamVolume(AudioManager.STREAM_ALARM, target, 0)
    } catch (t: Throwable) {
      // Do Not Disturb caps STREAM_ALARM and refuses writes above the cap unless
      // notification-policy access is granted. That is P-031 check 5, and the
      // caller needs to know the volume did not move.
      throw AlarmVolumeRefusedException(t.message ?: "denied by Do Not Disturb policy")
    }
  }

  // ══ P-031 · the checks with no JS API ═════════════════════════════════════════

  private fun collectPermissions(): Bundle {
    val ctx = context.applicationContext
    return Bundle().apply {
      putBoolean("batteryOptimisationExempt", batteryOptimisationExempt(ctx))
      putBoolean("notBackgroundRestricted", notBackgroundRestricted(ctx))
      putBoolean("exactAlarmsPermitted", exactAlarmsPermitted(ctx))
      putBoolean("notificationsEnabled", notificationsEnabled(ctx))
      putBoolean("dndBypassGranted", dndBypassGranted(ctx))
      putBoolean("bgLocationGranted", bgLocationGranted(ctx))
      putBoolean("autoRevokeDisabled", autoRevokeDisabled(ctx))
      putBoolean("t0SigningAvailablePredawn", t0SigningAvailablePredawn(ctx))
    }
  }

  private fun batteryOptimisationExempt(ctx: Context): Boolean {
    val power = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
    return try {
      power.isIgnoringBatteryOptimizations(ctx.packageName)
    } catch (t: Throwable) {
      Log.w(TAG, "battery optimisation state unreadable", t)
      false
    }
  }

  /**
   * "Background restricted" is the setting a user reaches by long-pressing the
   * app and choosing Restrict. It is separate from battery optimisation, it is
   * far more lethal to a foreground service, and there is no JS API for it at all.
   */
  private fun notBackgroundRestricted(ctx: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return true
    val activity = ctx.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return true
    return try {
      !activity.isBackgroundRestricted
    } catch (t: Throwable) {
      Log.w(TAG, "background restriction unreadable", t)
      true
    }
  }

  private fun exactAlarmsPermitted(ctx: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
    val alarms = ctx.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return false
    return try {
      alarms.canScheduleExactAlarms()
    } catch (t: Throwable) {
      Log.w(TAG, "exact alarm state unreadable", t)
      false
    }
  }

  /**
   * Both the app-level toggle and the T0 channel. A user who left notifications
   * on but muted our channel has, from the OS's point of view, silenced the
   * foreground service notification — and Android will then kill the service.
   */
  private fun notificationsEnabled(ctx: Context): Boolean {
    val notifications = ctx.getSystemService(NotificationManager::class.java) ?: return false
    return try {
      if (!notifications.areNotificationsEnabled()) return false
      val channel = notifications.getNotificationChannel(T0_CHANNEL_ID) ?: return true
      channel.importance != NotificationManager.IMPORTANCE_NONE
    } catch (t: Throwable) {
      Log.w(TAG, "notification state unreadable", t)
      false
    }
  }

  private fun dndBypassGranted(ctx: Context): Boolean {
    val notifications = ctx.getSystemService(NotificationManager::class.java) ?: return false
    return try {
      notifications.isNotificationPolicyAccessGranted
    } catch (t: Throwable) {
      Log.w(TAG, "DND policy state unreadable", t)
      false
    }
  }

  private fun bgLocationGranted(ctx: Context): Boolean =
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      // Before API 29 foreground location IS background location.
      granted(ctx, Manifest.permission.ACCESS_FINE_LOCATION) ||
        granted(ctx, Manifest.permission.ACCESS_COARSE_LOCATION)
    } else {
      granted(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
    }

  /**
   * Android revokes permissions from apps that have not been opened for a few
   * months. A guardian's phone that quietly loses SEND_SMS because nothing went
   * wrong for a season is the most insidious failure mode T0 has.
   */
  private fun autoRevokeDisabled(ctx: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return true
    return try {
      ctx.packageManager.isAutoRevokeWhitelisted
    } catch (t: Throwable) {
      Log.w(TAG, "auto-revoke state unreadable", t)
      false
    }
  }

  /**
   * F-17. Two things must both hold for T0 to be able to sign an emergency
   * payload before the phone has ever been unlocked:
   *
   *  1. the pre-unlock config exists in device-protected storage, so we know
   *     WHICH key to use and WHO to send to (P-035); and
   *  2. that key does not require user authentication — a key gated on the lock
   *     screen is, by definition, unusable before the lock screen is answered.
   *
   * Anything less and the honest answer is false, even though the key exists.
   */
  private fun t0SigningAvailablePredawn(ctx: Context): Boolean {
    val alias = try {
      T0Config.snapshot(ctx).signingKeyAlias
    } catch (t: Throwable) {
      Log.w(TAG, "pre-unlock config unreadable", t)
      null
    } ?: return false

    return try {
      val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
      val entry = keyStore.getEntry(alias, null) as? KeyStore.PrivateKeyEntry ?: return false
      val factory = KeyFactory.getInstance(entry.privateKey.algorithm, ANDROID_KEYSTORE)
      val info = factory.getKeySpec(entry.privateKey, KeyInfo::class.java)
      !info.isUserAuthenticationRequired
    } catch (t: Throwable) {
      Log.w(TAG, "T0 signing key unusable", t)
      false
    }
  }

  // ══ Proximity ═════════════════════════════════════════════════════════════════

  /**
   * P-056: expo-sensors exposes no proximity sensor on Android, and "the phone is
   * in a pocket or against a face" is what separates a real fall from a phone
   * sliding off a table.
   *
   * Most Android proximity sensors are binary — they report either 0 cm or their
   * maximum range — so the value is a near/far signal, not a distance. We return
   * it raw and let the caller decide.
   */
  private fun readProximity(promise: Promise) {
    val sensors = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
    val sensor = sensors?.getDefaultSensor(Sensor.TYPE_PROXIMITY)
    val handler = auxHandler
    if (sensors == null || sensor == null || handler == null) {
      promise.reject(ProximityUnavailableException())
      return
    }

    // `settled` makes resolve/reject mutually exclusive: the timeout runs on the
    // same looper the sensor delivers on, but a sample already in flight would
    // otherwise settle an already-rejected promise and crash in production.
    val settled = AtomicBoolean(false)
    val registered = AtomicReference<SensorEventListener?>(null)

    val timeout = Runnable {
      if (settled.compareAndSet(false, true)) {
        registered.get()?.let { sensors.unregisterListener(it) }
        promise.reject(ProximityUnavailableException())
      }
    }

    val listener = object : SensorEventListener {
      override fun onSensorChanged(event: SensorEvent) {
        val value = event.values.firstOrNull() ?: return
        if (settled.compareAndSet(false, true)) {
          handler.removeCallbacks(timeout)
          sensors.unregisterListener(this)
          promise.resolve(value.toDouble())
        }
      }

      override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
    }
    registered.set(listener)

    // SENSOR_DELAY_FASTEST: we want the first sample and then we are gone. The
    // sensor stays powered for milliseconds, not for the life of the incident.
    sensors.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_FASTEST, handler)
    handler.postDelayed(timeout, PROXIMITY_TIMEOUT_MS)
  }

  // ══ BLE distress beacon (§4.4 L1 · PEER_ONLY) ════════════════════════════════

  /**
   * At degradation level PEER_ONLY there is no cell, no Wi-Fi and no SMS — only
   * whoever is within a few tens of metres. A non-connectable advertisement is
   * the right shape for that: it needs no pairing, no permission from the peer,
   * and any Kavach install in range can hear it without an association.
   *
   * Legacy advertising has a hard 31-byte AD budget. We spend it on manufacturer
   * data under company identifier 0xFFFF — the identifier the Bluetooth SIG
   * reserves for exactly this, unregistered use — which leaves 21 usable bytes
   * once flags and TX power are paid for. A payload larger than that needs
   * extended advertising, which is API 26+ and absent on plenty of budget
   * chipsets, so we ask before assuming it.
   */
  private fun startAdvertising(payloadBase64: String, ttlMs: Long, promise: Promise) {
    val payload = try {
      Base64.decode(payloadBase64, Base64.NO_WRAP)
    } catch (t: Throwable) {
      promise.resolve(false)
      return
    }
    if (payload.isEmpty()) {
      promise.resolve(false)
      return
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
      !granted(context, Manifest.permission.BLUETOOTH_ADVERTISE)
    ) {
      promise.resolve(false)
      return
    }

    val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    val adapter = manager?.adapter
    // BluetoothAdapter.isEnabled() gained a BLUETOOTH_CONNECT requirement in
    // API 31 and throws SecurityException without it — on a permission we do not
    // strictly need, since advertising only needs BLUETOOTH_ADVERTISE.
    val bluetoothOn = try {
      adapter?.isEnabled == true
    } catch (t: Throwable) {
      Log.w(TAG, "adapter state unreadable", t)
      false
    }
    if (adapter == null || !bluetoothOn) {
      promise.resolve(false)
      return
    }
    val advertiser = try {
      adapter.bluetoothLeAdvertiser
    } catch (t: Throwable) {
      null
    }
    if (advertiser == null) {
      promise.resolve(false)
      return
    }

    stopAdvertising()
    val settled = AtomicBoolean(false)

    val started = if (payload.size <= LEGACY_PAYLOAD_BUDGET) {
      startLegacyAdvertising(advertiser, payload, ttlMs, settled, promise)
    } else if (adapter.isLeExtendedAdvertisingSupported) {
      startExtendedAdvertising(advertiser, payload, ttlMs, settled, promise)
    } else {
      false
    }

    if (!started && settled.compareAndSet(false, true)) {
      promise.resolve(false)
    }
  }

  private fun startLegacyAdvertising(
    advertiser: BluetoothLeAdvertiser,
    payload: ByteArray,
    ttlMs: Long,
    settled: AtomicBoolean,
    promise: Promise
  ): Boolean {
    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
      // Non-connectable: a stranger's phone must never be able to open a GATT
      // session against a device whose owner is already in trouble.
      .setConnectable(false)
      // The controller caps this at 180 s; the handler below enforces the rest.
      .setTimeout(ttlMs.coerceIn(0L, MAX_CONTROLLER_TIMEOUT_MS).toInt())
      .build()

    val data = AdvertiseData.Builder()
      // The device name is the owner's real name on most phones. It is never
      // going into a broadcast that anyone within 40 m can read (P-042).
      .setIncludeDeviceName(false)
      .setIncludeTxPowerLevel(true)
      .addManufacturerData(UNASSIGNED_COMPANY_ID, payload)
      .build()

    val callback = object : AdvertiseCallback() {
      override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
        if (settled.compareAndSet(false, true)) promise.resolve(true)
      }

      override fun onStartFailure(errorCode: Int) {
        Log.w(TAG, "legacy advertise failed: $errorCode")
        if (settled.compareAndSet(false, true)) promise.resolve(false)
      }
    }

    return try {
      advertiser.startAdvertising(settings, data, callback)
      legacyAdvertiseCallback = callback
      scheduleAdvertiseStop(ttlMs)
      true
    } catch (t: Throwable) {
      Log.w(TAG, "legacy advertise refused", t)
      false
    }
  }

  private fun startExtendedAdvertising(
    advertiser: BluetoothLeAdvertiser,
    payload: ByteArray,
    ttlMs: Long,
    settled: AtomicBoolean,
    promise: Promise
  ): Boolean {
    val parameters = AdvertisingSetParameters.Builder()
      .setLegacyMode(false)
      .setConnectable(false)
      .setScannable(false)
      .setInterval(AdvertisingSetParameters.INTERVAL_LOW)
      .setTxPowerLevel(AdvertisingSetParameters.TX_POWER_HIGH)
      // 1M on both legs. PHY_LE_2M is faster but is not universally supported
      // even on chipsets that do support extended advertising, and an
      // IllegalArgumentException here would cost us the only transport left at
      // degradation level PEER_ONLY.
      .setPrimaryPhy(BluetoothDevice.PHY_LE_1M)
      .setSecondaryPhy(BluetoothDevice.PHY_LE_1M)
      .build()

    val data = AdvertiseData.Builder()
      .setIncludeDeviceName(false)
      .addServiceData(ParcelUuid(KAVACH_SERVICE_UUID), payload)
      .build()

    val callback = object : AdvertisingSetCallback() {
      override fun onAdvertisingSetStarted(set: AdvertisingSet?, txPower: Int, status: Int) {
        val ok = status == AdvertisingSetCallback.ADVERTISE_SUCCESS
        if (!ok) Log.w(TAG, "extended advertise failed: $status")
        if (settled.compareAndSet(false, true)) promise.resolve(ok)
      }
    }

    return try {
      advertiser.startAdvertisingSet(parameters, data, null, null, null, callback)
      extendedAdvertiseCallback = callback
      scheduleAdvertiseStop(ttlMs)
      true
    } catch (t: Throwable) {
      Log.w(TAG, "extended advertise refused", t)
      false
    }
  }

  /**
   * The TTL is enforced here as well as in the controller because
   * `AdvertiseSettings.setTimeout` maxes out at 180 s, and a distress beacon that
   * outlives its incident is a privacy leak with a battery cost attached.
   */
  private fun scheduleAdvertiseStop(ttlMs: Long) {
    if (ttlMs <= 0L) return
    auxHandler?.postDelayed({ runCatching { stopAdvertising() } }, ttlMs)
  }

  private fun stopAdvertising() {
    val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    val advertiser = try {
      manager?.adapter?.bluetoothLeAdvertiser
    } catch (t: Throwable) {
      null
    }
    legacyAdvertiseCallback?.let { callback ->
      runCatching { advertiser?.stopAdvertising(callback) }
      legacyAdvertiseCallback = null
    }
    extendedAdvertiseCallback?.let { callback ->
      runCatching { advertiser?.stopAdvertisingSet(callback) }
      extendedAdvertiseCallback = null
    }
  }

  // ══ OEM battery settings (PRD Appendix B) ════════════════════════════════════

  /**
   * Accepts either an action string ("android.settings.…") or a
   * "package/class" component. The Appendix B components are undocumented,
   * unexported on some builds and renamed between OEM versions, so `false` here
   * is a normal outcome and means "fall back to the illustrated guide", never
   * "this device is fine".
   */
  @Suppress("DEPRECATION")
  private fun openOemSettings(spec: String): Boolean {
    val trimmed = spec.trim()
    if (trimmed.isEmpty()) return false

    val intent = if (trimmed.contains('/')) {
      val pkg = trimmed.substringBefore('/')
      val rawClass = trimmed.substringAfter('/')
      val cls = if (rawClass.startsWith('.')) pkg + rawClass else rawClass
      Intent().setComponent(ComponentName(pkg, cls))
    } else {
      Intent(trimmed).apply {
        // These three refuse to resolve without a package: URI, and silently open
        // the wrong screen if given one they do not expect.
        if (trimmed in PACKAGE_SCOPED_ACTIONS) {
          data = Uri.fromParts("package", context.packageName, null)
        }
      }
    }

    val activity = appContext.currentActivity
    if (activity == null) {
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    val launcher = activity ?: context

    return try {
      if (context.packageManager.resolveActivity(intent, 0) == null) return false
      launcher.startActivity(intent)
      true
    } catch (t: Throwable) {
      Log.w(TAG, "cannot open $trimmed", t)
      false
    }
  }

  // ══ Shared ════════════════════════════════════════════════════════════════════

  private fun granted(ctx: Context, permission: String): Boolean =
    ContextCompat.checkSelfPermission(ctx, permission) == PackageManager.PERMISSION_GRANTED

  private companion object {
    const val TAG = "KavachT0/Module"
    const val ANDROID_KEYSTORE = "AndroidKeyStore"
    const val T0_CHANNEL_ID = "kavach_t0_agent"

    const val SENT_ACTION_SUFFIX = "KAVACH_T0_SMS_SENT"
    const val EXTRA_TOKEN = "kavachT0Token"
    const val SMS_ACK_TIMEOUT_MS = 10_000L
    const val MIN_DIALABLE_LENGTH = 3

    const val STATUS_OK = "ok"
    const val STATUS_ERROR = "error"
    const val STATUS_PENDING = "pending"
    const val STATUS_SKIPPED = "skipped"

    const val PROXIMITY_TIMEOUT_MS = 2_000L

    /**
     * 31-byte AD budget − 3 (flags) − 3 (TX power) − 2 (length+type)
     * − 2 (company id) = 21. Over-running it fails with
     * ADVERTISE_FAILED_DATA_TOO_LARGE, so the budget is computed, not guessed.
     */
    const val LEGACY_PAYLOAD_BUDGET = 21
    const val UNASSIGNED_COMPANY_ID = 0xFFFF
    const val MAX_CONTROLLER_TIMEOUT_MS = 180_000L
    val KAVACH_SERVICE_UUID: UUID = UUID.fromString("6b617661-6368-4b56-4348-543000000001")

    val PACKAGE_SCOPED_ACTIONS = setOf(
      Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
      Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
      "android.settings.REQUEST_SCHEDULE_EXACT_ALARM",
      "android.settings.APP_NOTIFICATION_SETTINGS"
    )
  }
}

// ══ Records ═══════════════════════════════════════════════════════════════════

/**
 * Only `title`, `body` and `incidentActive` are sent by today's JS bridge. The
 * rest are the P-035 pre-unlock provisioning payload; every one is nullable so
 * that a caller which omits them LEAVES THE STORED VALUE ALONE rather than
 * clearing it (see T0Config.writeProvisioning).
 */
data class ForegroundAgentOptions(
  @Field val title: String = "",
  @Field val body: String = "",
  @Field val incidentActive: Boolean = false,
  @Field val incidentId8: String? = null,
  @Field val emergencyNumbers: List<String>? = null,
  @Field val policySnapshotJson: String? = null,
  @Field val signingKeyAlias: String? = null,
  @Field val peerFingerprints: List<String>? = null,
  @Field val preferredSubscriptionId: Int? = null,
  @Field val guardianReleaseTokenSha256: String? = null,
  @Field val guardianFrpAccounts: List<String>? = null,
  @Field val lastKnownLat: Double? = null,
  @Field val lastKnownLon: Double? = null,
  @Field val lastKnownAccuracyM: Double? = null,
  @Field val lastKnownAt: Double? = null
) : Record

// ══ SIM plumbing, shared with ShutdownReceiver ════════════════════════════════

data class SimTarget(
  val subscriptionId: Int,
  val slotIndex: Int,
  val carrier: String
)

class SmsPlan(
  val target: SimTarget,
  val manager: SmsManager,
  val number: String,
  val parts: ArrayList<String>,
  val token: String
)

/**
 * P-033 lives here so that the incident path and the Final Breath path (P-022)
 * enumerate SIMs by exactly the same rules. A shutdown that reached a different
 * set of SIMs than the incident did would be impossible to debug from a log.
 */
object T0Sms {
  private const val TAG = "KavachT0/SIM"

  /**
   * Deliberately a local literal rather than SubscriptionManager's own constant:
   * that field has moved in and out of the public SDK between releases, and a T0
   * build must not fail to compile — or worse, link — over a diagnostic sentinel.
   */
  private const val NO_SUBSCRIPTION = -1

  /**
   * Attempt order: the guardian's preferred SIM, then the system default SMS
   * subscription, then everything else in slot order. Duplicates collapse, so a
   * single-SIM phone produces exactly one target.
   */
  fun orderedSubscriptions(context: Context, preferredSubscriptionId: Int): List<SimTarget> {
    val active = activeSubscriptions(context)
    if (active.isEmpty()) {
      // Either READ_PHONE_STATE was refused or the device never populates the
      // subscription list. The default SmsManager is still a real send, so we
      // return one anonymous target rather than giving up.
      return listOf(SimTarget(NO_SUBSCRIPTION, -1, ""))
    }

    val defaultSubId = try {
      SmsManager.getDefaultSmsSubscriptionId()
    } catch (t: Throwable) {
      Log.w(TAG, "default SMS subscription unreadable", t)
      NO_SUBSCRIPTION
    }

    val ordered = LinkedHashMap<Int, SimTarget>()
    active.firstOrNull { it.subscriptionId == preferredSubscriptionId }?.let {
      ordered[it.subscriptionId] = it
    }
    active.firstOrNull { it.subscriptionId == defaultSubId }?.let {
      if (!ordered.containsKey(it.subscriptionId)) ordered[it.subscriptionId] = it
    }
    for (target in active.sortedBy { it.slotIndex }) {
      if (!ordered.containsKey(target.subscriptionId)) ordered[target.subscriptionId] = target
    }
    return ordered.values.toList()
  }

  @Suppress("DEPRECATION")
  fun smsManagerFor(context: Context, subscriptionId: Int): SmsManager? = try {
    when {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
        val base = context.getSystemService(SmsManager::class.java)
        if (subscriptionId >= 0) base?.createForSubscriptionId(subscriptionId) else base
      }
      subscriptionId >= 0 -> SmsManager.getSmsManagerForSubscriptionId(subscriptionId)
      else -> SmsManager.getDefault()
    }
  } catch (t: Throwable) {
    Log.w(TAG, "no SmsManager for subscription $subscriptionId", t)
    null
  }

  private fun activeSubscriptions(context: Context): List<SimTarget> {
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE)
      != PackageManager.PERMISSION_GRANTED
    ) {
      return emptyList()
    }
    val subscriptions = context.getSystemService(SubscriptionManager::class.java) ?: return emptyList()
    return try {
      subscriptions.activeSubscriptionInfoList?.map { info ->
        SimTarget(
          subscriptionId = info.subscriptionId,
          slotIndex = info.simSlotIndex,
          carrier = info.carrierName?.toString().orEmpty()
        )
      }.orEmpty()
    } catch (t: Throwable) {
      Log.w(TAG, "subscription list unreadable", t)
      emptyList()
    }
  }
}

// ══ Errors ════════════════════════════════════════════════════════════════════

class T0NotReadyException :
  CodedException("The Kavach T0 native plane is not initialised.")

class SmsDispatchException(cause: Throwable) :
  CodedException("Multi-SIM SMS dispatch failed: ${cause.message}", cause)

class TorchUnavailableException(reason: String) :
  CodedException("Torch unavailable: $reason")

class AlarmVolumeRefusedException(reason: String) :
  CodedException("Alarm volume refused: $reason")

class ProximityUnavailableException :
  CodedException("This device reported no proximity reading.")
