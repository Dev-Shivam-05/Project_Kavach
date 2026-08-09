/**
 * Entry point.
 *
 * expo-router registers the root component itself and builds the navigator from
 * the `app/` directory. Registering a component here as well — the
 * create-expo-app default — mounts THAT component instead of the router, and
 * every screen under app/ silently never renders.
 */
import 'expo-router/entry';
