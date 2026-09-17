// Babel configuration.
//
// Two things here are not boilerplate, and both fail LOUDLY at bundle time
// rather than at runtime, so they are worth the comments.
const path = require('path');

/**
 * Babel resolves a bare preset/plugin *name* relative to the directory holding
 * this file. That is fine with a fully hoisted node_modules and wrong with a
 * partially hoisted or pnpm-style one, where `babel-preset-expo` lives under
 * `node_modules/expo/node_modules/` and the lookup from the project root misses.
 * The failure mode is `Cannot find module 'babel-preset-expo'` at `expo start`
 * — the whole app, not one screen. Falling back to a lookup rooted at expo's own
 * package directory makes one config file correct under both layouts.
 *
 * Returns the bare name when neither lookup succeeds, so Babel raises its own
 * error naming the missing package instead of this file swallowing it.
 */
function resolveBabelModule(name, ...fallbackHosts) {
  try {
    return require.resolve(name);
  } catch {
    /* not hoisted to the project root — try the hosts below */
  }
  for (const host of fallbackHosts) {
    try {
      const hostDir = path.dirname(require.resolve(`${host}/package.json`));
      return require.resolve(name, { paths: [hostDir] });
    } catch {
      /* this host does not carry it either */
    }
  }
  return name;
}

module.exports = function (api) {
  api.cache(true);

  // ★ The Reanimated/Worklets plugin is NOT listed here on purpose. ★
  //
  // babel-preset-expo adds `react-native-worklets/plugin` itself whenever the
  // package resolves (`babel-preset-expo/build/configs/expo.js`, "Automatically
  // add worklets or reanimated plugin when package is installed"), and places
  // it last among its own plugins — which is where the worklet transform has
  // to run, after every other transform has rewritten the function bodies it
  // reads. `react-native-reanimated/plugin` is a two-line re-export of the same
  // module, so listing it here registered one transform twice and moved the
  // "must be last" decision to a file that cannot actually enforce it: Babel
  // runs a config's `plugins` BEFORE its presets' plugins, so nothing declared
  // here can ever run after the preset's copy. One owner, the preset. Pass
  // `{ worklets: false }` to the preset if that ownership ever has to move.
  return {
    presets: [resolveBabelModule('babel-preset-expo', 'expo')],
    plugins: [],
  };
};
