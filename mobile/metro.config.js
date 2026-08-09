// Metro bundler configuration.
//
// Deliberately the Expo default plus ONE narrow adjustment. Every knob turned
// here is a knob that can silently diverge from what `eas build` does on the
// build server, and a bundler that behaves differently in CI than on a laptop
// is how a release ships without the crypto module (ADR-002's "the survival
// path must not depend on cleverness" applies to the toolchain too).
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// The @noble/* packages (src/crypto — Ed25519 device identity, XChaCha20-Poly1305
// GroupBox sealing, HKDF stream keys) are `"type": "module"` ESM with an exports
// map whose subpaths are explicit `.js`/`.mjs` files, and their CommonJS mirrors
// are `.cjs`. Expo's default sourceExts already carries both, but this list is
// load-bearing rather than incidental: if a future SDK trims it, module
// resolution fails at *bundle* time with "Unable to resolve @noble/hashes/sha2.js"
// and the app has no signing key at all. Asserting the two extensions here makes
// that a config change someone has to make on purpose.
for (const ext of ['cjs', 'mjs']) {
  if (!config.resolver.sourceExts.includes(ext)) {
    config.resolver.sourceExts.push(ext);
  }
}

module.exports = config;
