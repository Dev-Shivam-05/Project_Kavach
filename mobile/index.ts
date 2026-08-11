/**
 * Entry point.
 *
 * ★ THE ORDER OF THESE TWO IMPORTS IS LOAD-BEARING (W10-b · 1.35e). ★
 * `expo-task-manager` loads this bundle in the background to deliver a push and
 * looks the task up by name the moment it finishes. ES modules evaluate in
 * source order, so `pushReceive` — which defines and registers the task in its
 * module scope — must be listed FIRST. Put it after the router entry, or inside
 * a screen, and the task is defined too late on exactly the launch that matters:
 * the one where the app was killed and a family is waiting for the phone to ring.
 *
 * expo-router registers the root component itself and builds the navigator from
 * the `app/` directory. Registering a component here as well — the
 * create-expo-app default — mounts THAT component instead of the router, and
 * every screen under app/ silently never renders.
 */
import './src/state/pushReceive';
import 'expo-router/entry';
