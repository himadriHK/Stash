import { registerRootComponent } from 'expo';

// Registers the Expo background-task definition at module scope, before the
// native background runtime can launch the app and invoke the task.
import './src/tasks/stashBackgroundTasks';
import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);