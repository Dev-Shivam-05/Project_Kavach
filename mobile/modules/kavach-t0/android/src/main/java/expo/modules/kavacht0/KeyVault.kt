package expo.modules.kavacht0

import android.app.KeyguardManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException
import android.util.Base64
import android.util.Log
import expo.modules.kotlin.exception.CodedException
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * KeyVault · THE SIGNING KEYS THAT NEVER ENTER THE JS HEAP (F-17)
 *
 * The emergency signing key is the thing that proves an SOS came from this
 * device. Held as base64 in a JS object it is readable by anything running in
 * that runtime — every dependency, every hot-reload payload, every heap dump.
 * Here the private half is generated inside the AndroidKeyStore and never
 * leaves it. This file exposes exactly three verbs — ensure, sign, publicKey —
 * plus a measurement, and there is deliberately NO export function.
 *
 * ★ THE EMERGENCY KEY IS NOT GATED ON THE USER (F-17, P-035) ★
 * `setUserAuthenticationRequired(false)` and `setUnlockedDeviceRequired(false)`
 * on the emergency alias, always, at every hardware tier. An unconscious person
 * cannot answer a lock screen, and a key that needs one is a key that refuses at
 * the only moment it is ever asked. The identity key is gated; the emergency key
 * is the reason this distinction exists.
 *
 * ★ EC P-256, NOT Ed25519 ★
 * Android Keystore gained Curve25519 at API 33. This module ships to API 26, and
 * the phones this product exists for are mid-range Android sold in India. So the
 * hardware key is EC P-256 / SHA256withECDSA while the JS fallback in
 * `src/crypto/index.ts` stays Ed25519. The signature algorithm is therefore a
 * property of the KEY, not of the protocol — see `src/crypto/hardware.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
object KeyVault {

  /**
   * The alias JS asks for. It is also what gets written into
   * `T0Config.KEY_SIGNING_KEY_ALIAS`, which is what `t0SigningAvailablePredawn()`
   * probes — until something writes it, that P-031 check can only ever be false.
   */
  const val ALIAS_EMERGENCY = "kavach_emergency_sign_v1"
  const val ALIAS_IDENTITY = "kavach_identity_sign_v1"

  private const val TAG = "KavachT0/KeyVault"
  private const val ANDROID_KEYSTORE = "AndroidKeyStore"
  private const val SIGNATURE_ALGORITHM = "SHA256withECDSA"
  private const val CURVE = "secp256r1"

  /**
   * How long identity signing stays usable after the user last authenticated.
   * Zero would mean a BiometricPrompt CryptoObject for every single signature,
   * and this module has no Activity to show one from.
   */
  private const val IDENTITY_AUTH_VALIDITY_S = 300

  const val LEVEL_STRONGBOX = "strongbox"
  const val LEVEL_TEE = "tee"
  const val LEVEL_SOFTWARE = "software"
  const val LEVEL_UNKNOWN = "unknown"

  // ── Public surface ──────────────────────────────────────────────────────────

  /**
   * Create the key if it is absent, then describe what the platform actually
   * gave us. An existing alias is NEVER regenerated: rotating the emergency key
   * would invalidate the public key the server has on file for this device, and
   * the first anyone would learn of it is a rejected SOS.
   */
  fun ensure(context: Context, alias: String): Bundle {
    val a = requireKnownAlias(alias)
    val store = keyStore()
    val existed = try {
      store.containsAlias(a)
    } catch (t: Throwable) {
      throw KeyVaultUnavailableException(t.message ?: "keystore alias lookup failed")
    }
    if (!existed) generate(context, a)

    val info = keyInfo(context, a)
    if (a == ALIAS_EMERGENCY && info.getBoolean(FIELD_PRESENT, false)) {
      // Only once the key really exists. Publishing an alias that resolves to
      // nothing would make the Direct Boot probe report a key it cannot use.
      runCatching {
        T0Config.prefs(context).edit()
          .putString(T0Config.KEY_SIGNING_KEY_ALIAS, a)
          .apply()
      }.onFailure { Log.w(TAG, "could not publish the T0 signing alias", it) }
    }
    return info
  }

  /**
   * Measured, not assumed. Every field below is read back off the key that
   * exists on this device — nothing here repeats what we asked for, except
   * `unlockedDeviceRequired` on platforms with no getter, and that case is
   * flagged rather than hidden (see [readUnlockedDeviceRequired]).
   */
  fun keyInfo(context: Context, alias: String): Bundle {
    val a = requireKnownAlias(alias)
    val prefs = runCatching { T0Config.prefs(context) }.getOrNull()
    val createdAt = prefs?.getLong(prefKey(a, PREF_CREATED_AT), 0L) ?: 0L

    val privateKey = try {
      keyStore().getKey(a, null) as? PrivateKey
    } catch (t: Throwable) {
      Log.w(TAG, "key $a unreadable", t)
      null
    }
    if (privateKey == null) {
      return Measured(a, present = false, level = LEVEL_UNKNOWN, createdAt = createdAt).toBundle()
    }

    val info = try {
      KeyFactory.getInstance(privateKey.algorithm, ANDROID_KEYSTORE)
        .getKeySpec(privateKey, KeyInfo::class.java)
    } catch (t: Throwable) {
      // The key exists and the platform will not describe it. Reporting
      // "unknown" understates a key that may well be in the TEE, and
      // understating is the only direction it is safe to be wrong in (P-031).
      Log.w(TAG, "key $a is not describable", t)
      return Measured(a, present = true, level = LEVEL_UNKNOWN, createdAt = createdAt).toBundle()
    }

    val strongBoxGranted = prefs?.getBoolean(prefKey(a, PREF_STRONGBOX_GRANTED), false) ?: false
    val unlockedRead = readUnlockedDeviceRequired(info)
    return Measured(
      alias = a,
      present = true,
      level = securityLevelOf(info, strongBoxGranted),
      userAuthRequired = info.isUserAuthenticationRequired,
      unlockedDeviceRequired = unlockedRead
        ?: (prefs?.getBoolean(prefKey(a, PREF_UNLOCKED_REQUIRED), false) ?: false),
      unlockedDeviceRequiredMeasured = unlockedRead != null,
      createdAt = createdAt
    ).toBundle()
  }

  /**
   * Sign `payloadBase64` with the private key held in the keystore. The bytes
   * signed are exactly the bytes the caller encoded; nothing is re-canonicalised
   * here, because the envelope's fixed-size body (F-01) is already final by the
   * time it reaches us.
   */
  fun sign(alias: String, payloadBase64: String): String {
    val a = requireKnownAlias(alias)
    val payload = try {
      Base64.decode(payloadBase64, Base64.NO_WRAP)
    } catch (t: Throwable) {
      throw KeyVaultSignException("payload was not base64")
    }
    if (payload.isEmpty()) throw KeyVaultSignException("refusing to sign an empty payload")

    val key = try {
      keyStore().getKey(a, null) as? PrivateKey
    } catch (t: Throwable) {
      throw KeyVaultSignException(t.message ?: "key $a unreadable")
    }
    if (key == null) throw KeyVaultSignException("no key under alias $a")

    return try {
      val signer = Signature.getInstance(SIGNATURE_ALGORITHM)
      signer.initSign(key)
      signer.update(payload)
      Base64.encodeToString(signer.sign(), Base64.NO_WRAP)
    } catch (t: UserNotAuthenticatedException) {
      // Only reachable for the identity key. The emergency key is generated
      // ungated precisely so this branch can never block an SOS (F-17).
      throw KeyVaultSignException("this key needs the lock screen answered first")
    } catch (t: KeyPermanentlyInvalidatedException) {
      throw KeyVaultSignException("the key was destroyed by a lock-screen or biometric change")
    } catch (t: Throwable) {
      throw KeyVaultSignException(t.message ?: "the keystore refused to sign")
    }
  }

  /**
   * X.509 SubjectPublicKeyInfo, base64. This is the ONLY key material that ever
   * crosses the bridge, and there is no counterpart that returns the private
   * half. Do not add one.
   */
  fun publicKey(alias: String): String {
    val a = requireKnownAlias(alias)
    val certificate = try {
      keyStore().getCertificate(a)
    } catch (t: Throwable) {
      throw KeyVaultUnavailableException(t.message ?: "certificate for $a unreadable")
    }
    if (certificate == null) throw KeyVaultUnavailableException("no key under alias $a")
    return Base64.encodeToString(certificate.publicKey.encoded, Base64.NO_WRAP)
  }

  // ── Generation ──────────────────────────────────────────────────────────────

  private data class Attempt(val strongBox: Boolean, val userAuth: Boolean)

  /**
   * StrongBox first, TEE second. Most mid-range phones have no StrongBox at all,
   * and a vault that refused to exist without one would leave exactly those
   * devices holding the JS-heap key this class exists to remove.
   */
  private fun generate(context: Context, alias: String) {
    var attempted = false
    for (attempt in attemptsFor(context, alias)) {
      // A refused attempt can leave a half-created alias behind, which the next
      // tier would collide with instead of replacing. Nothing is deleted before
      // the first try, so an existing key can never be destroyed on this path.
      if (attempted) runCatching { keyStore().deleteEntry(alias) }
      attempted = true
      if (tryGenerate(alias, attempt)) {
        recordGeneration(context, alias, attempt)
        return
      }
    }
    throw KeyVaultUnavailableException("this device refused to create key $alias")
  }

  private fun attemptsFor(context: Context, alias: String): List<Attempt> {
    val strongBoxOffered = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      try {
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
      } catch (t: Throwable) {
        Log.w(TAG, "StrongBox feature flag unreadable", t)
        false
      }
    } else {
      false
    }

    // ★ F-17. `userAuth` is false for the emergency alias at every tier, with no
    // fallback path that could ever set it true.
    val userAuth = alias == ALIAS_IDENTITY && hasSecureLockScreen(context)

    val out = mutableListOf<Attempt>()
    if (strongBoxOffered) out += Attempt(strongBox = true, userAuth = userAuth)
    out += Attempt(strongBox = false, userAuth = userAuth)
    if (userAuth) {
      // Some OEMs report a secure lock screen and then refuse to bind a key to
      // it (work-profile-managed credentials do this). An ungated identity key
      // is worth having; it is reported as ungated, which is the honest answer.
      out += Attempt(strongBox = false, userAuth = false)
    }
    return out
  }

  private fun tryGenerate(alias: String, attempt: Attempt): Boolean = try {
    val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
    generator.initialize(buildSpec(alias, attempt))
    generator.generateKeyPair()
    true
  } catch (t: Throwable) {
    // StrongBoxUnavailableException is API 28 and is far from the only thing
    // thrown here — OEM keystores raise ProviderException, IllegalStateException
    // and StrongBox timeouts for the same underlying "no, not like that". We
    // catch the shape rather than the class and drop to the next tier.
    Log.w(TAG, "key $alias refused (strongBox=${attempt.strongBox} userAuth=${attempt.userAuth})", t)
    false
  }

  private fun buildSpec(alias: String, attempt: Attempt): KeyGenParameterSpec {
    val builder = KeyGenParameterSpec.Builder(
      alias,
      KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
    )
      .setAlgorithmParameterSpec(ECGenParameterSpec(CURVE))
      .setDigests(KeyProperties.DIGEST_SHA256)
      .setUserAuthenticationRequired(attempt.userAuth)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      builder.setIsStrongBoxBacked(attempt.strongBox)
      // ★ P-035. Stated explicitly even though false is the default: the T0
      // process signs after LOCKED_BOOT_COMPLETED, before anyone has typed a
      // PIN. Below API 28 the flag does not exist and the restriction does not
      // either, so the property holds on those devices for free.
      builder.setUnlockedDeviceRequired(false)
    }

    if (attempt.userAuth) {
      // A routine fingerprint enrolment must not destroy the device identity.
      builder.setInvalidatedByBiometricEnrollment(false)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        builder.setUserAuthenticationParameters(
          IDENTITY_AUTH_VALIDITY_S,
          KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL
        )
      } else {
        @Suppress("DEPRECATION")
        builder.setUserAuthenticationValidityDurationSeconds(IDENTITY_AUTH_VALIDITY_S)
      }
    }
    return builder.build()
  }

  /**
   * What the platform accepted, written to device-protected storage. No key
   * material — flags only, exactly as the T0Config header requires — and it is
   * the only evidence available on API 28–30 that a StrongBox request was
   * honoured (see [securityLevelOf]).
   */
  private fun recordGeneration(context: Context, alias: String, attempt: Attempt) {
    runCatching {
      T0Config.prefs(context).edit()
        .putBoolean(prefKey(alias, PREF_STRONGBOX_GRANTED), attempt.strongBox)
        .putBoolean(prefKey(alias, PREF_UNLOCKED_REQUIRED), false)
        .putLong(prefKey(alias, PREF_CREATED_AT), System.currentTimeMillis())
        .apply()
    }.onFailure { Log.w(TAG, "generation record for $alias not written", it) }
  }

  // ── Measurement ─────────────────────────────────────────────────────────────

  private fun securityLevelOf(info: KeyInfo, strongBoxGranted: Boolean): String {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      return when (info.securityLevel) {
        KeyProperties.SECURITY_LEVEL_STRONGBOX -> LEVEL_STRONGBOX
        KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> LEVEL_TEE
        KeyProperties.SECURITY_LEVEL_SOFTWARE -> LEVEL_SOFTWARE
        // The platform vouches for secure hardware and will not say which kind.
        // We take the weaker of the two claims, never the flattering one.
        KeyProperties.SECURITY_LEVEL_UNKNOWN_SECURE -> LEVEL_TEE
        else -> LEVEL_UNKNOWN
      }
    }
    // API 28–30: KeyInfo can say "inside secure hardware" and cannot say WHICH.
    // A StrongBox generation that returned without throwing is the platform's
    // own receipt that it honoured the request, so the two facts together are
    // evidence. `isInsideSecureHardware` on its own is not, and must never be
    // read as StrongBox.
    @Suppress("DEPRECATION")
    val secure = info.isInsideSecureHardware
    return when {
      secure && strongBoxGranted -> LEVEL_STRONGBOX
      secure -> LEVEL_TEE
      else -> LEVEL_SOFTWARE
    }
  }

  /**
   * `KeyInfo` has no getter for the unlocked-device requirement on every API
   * level this module supports, so we read it reflectively where one exists and
   * return null where it does not — the caller then falls back to the value the
   * key was created with and flags the difference. A requested-but-unverified
   * property reported as verified is precisely the lie P-031 exists to prevent.
   */
  private fun readUnlockedDeviceRequired(info: KeyInfo): Boolean? = try {
    KeyInfo::class.java.getMethod("isUnlockedDeviceRequired").invoke(info) as? Boolean
  } catch (t: Throwable) {
    null
  }

  private data class Measured(
    val alias: String,
    val present: Boolean,
    val level: String,
    val userAuthRequired: Boolean = false,
    val unlockedDeviceRequired: Boolean = false,
    val unlockedDeviceRequiredMeasured: Boolean = false,
    val createdAt: Long = 0L
  )

  private fun Measured.toBundle(): Bundle {
    val out = Bundle()
    out.putString(FIELD_ALIAS, alias)
    out.putBoolean(FIELD_PRESENT, present)
    out.putBoolean(FIELD_STRONGBOX, level == LEVEL_STRONGBOX)
    out.putBoolean(FIELD_TEE, level == LEVEL_TEE)
    out.putBoolean(FIELD_USER_AUTH, userAuthRequired)
    out.putBoolean(FIELD_UNLOCKED_REQUIRED, unlockedDeviceRequired)
    out.putBoolean(FIELD_UNLOCKED_MEASURED, unlockedDeviceRequiredMeasured)
    out.putString(FIELD_LEVEL, level)
    // Double, not Long: the bridge hands this to a JS number either way, and a
    // Long past 2^53 would arrive silently rounded.
    out.putDouble(FIELD_CREATED_AT, createdAt.toDouble())
    return out
  }

  // ── Shared ──────────────────────────────────────────────────────────────────

  /**
   * Two aliases, and only two. Accepting an arbitrary alias would turn this
   * module into a general-purpose signing oracle that any JS in the runtime
   * could point at a key of its own choosing.
   */
  private fun requireKnownAlias(alias: String): String = when (alias) {
    ALIAS_EMERGENCY, ALIAS_IDENTITY -> alias
    else -> throw KeyVaultAliasException(alias)
  }

  private fun keyStore(): KeyStore = try {
    KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
  } catch (t: Throwable) {
    throw KeyVaultUnavailableException(t.message ?: "AndroidKeyStore did not load")
  }

  private fun hasSecureLockScreen(context: Context): Boolean = try {
    context.getSystemService(KeyguardManager::class.java)?.isDeviceSecure == true
  } catch (t: Throwable) {
    Log.w(TAG, "lock screen state unreadable", t)
    false
  }

  private fun prefKey(alias: String, field: String): String = "keyvault.$alias.$field"

  private const val PREF_STRONGBOX_GRANTED = "strongBoxGranted"
  private const val PREF_UNLOCKED_REQUIRED = "unlockedDeviceRequired"
  private const val PREF_CREATED_AT = "createdAt"

  private const val FIELD_ALIAS = "alias"
  private const val FIELD_PRESENT = "present"
  private const val FIELD_STRONGBOX = "strongBox"
  private const val FIELD_TEE = "tee"
  private const val FIELD_USER_AUTH = "userAuthRequired"
  private const val FIELD_UNLOCKED_REQUIRED = "unlockedDeviceRequired"
  private const val FIELD_UNLOCKED_MEASURED = "unlockedDeviceRequiredMeasured"
  private const val FIELD_LEVEL = "securityLevel"
  private const val FIELD_CREATED_AT = "createdAt"
}

// ══ Errors ════════════════════════════════════════════════════════════════════

class KeyVaultUnavailableException(reason: String) :
  CodedException("The Kavach key vault is unavailable: $reason")

class KeyVaultAliasException(alias: String) :
  CodedException("The Kavach key vault does not own the alias '$alias'.")

class KeyVaultSignException(reason: String) :
  CodedException("The Kavach key vault could not sign: $reason")
