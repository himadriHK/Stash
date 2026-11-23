import { registerRootComponent } from 'expo';

// Initialize Sentry (if EXPO_PUBLIC_SENTRY_DSN is set) before any app code so
// profiling also covers app start. Safe no-op without a DSN, on web, and in
// Expo Go. Must stay the first import: module bodies run in import order.
import './src/services/sentry';

// Registers the Expo background-task definition at module scope, before the
// native background runtime can launch the app and invoke the task.
import './src/tasks/stashBackgroundTasks';
import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);