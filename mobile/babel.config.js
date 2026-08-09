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

/** True when `name` can actually be loaded from somewhere on disk. */
function isResolvable(name, ...fallbackHosts) {
  return path.isAbsolute(resolveBabelModule(name, ...fallbackHosts));
}

module.exports = function (api) {
  api.cache(true);

  const plugins = [];

  // ★ MUST BE LAST. ★
  //
  // The Reanimated/Worklets plugin rewrites worklet function bodies, and it has
  // to see the output of every other transform to do that. Anything appended
  // after it silently produces animations that run on the JS thread — which on
  // this app means the panic screen's countdown stutters exactly when the phone
  // is busiest.
  //
  // Reanimated 4 moved the transform into `react-native-worklets` and now only
  // re-exports it; `react-native-reanimated/plugin` is a two-line shim over
  // `require('react-native-worklets/plugin')`. react-native-worklets is a
  // *required* peer of react-native-reanimated@4 and is not always materialised
  // by installs run with --legacy-peer-deps. Guarding the entry means a missing
  // optional install degrades to "no worklet transform" instead of hard-crashing
  // the bundler before a single screen renders — and `npm i react-native-worklets`
  // restores it with no edit here.
  if (isResolvable('react-native-worklets/plugin', 'react-native-reanimated')) {
    plugins.push('react-native-reanimated/plugin');
  }

  return {
    presets: [resolveBabelModule('babel-preset-expo', 'expo')],
    plugins,
  };
};
