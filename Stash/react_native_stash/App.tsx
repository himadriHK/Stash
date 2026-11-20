/**
 * Stash - React Native backup client.
 * Providers: fonts -> safe area -> theme -> auth -> toasts. The shell mounts
 * the root navigator plus the background services (15-minute upload pass and
 * Kafka response consumer) that follow the auth state.
 */
import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts, OpenSans_400Regular } from '@expo-google-fonts/open-sans';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext';
import { AuthProvider, useAuth } from './src/auth/AuthContext';
import { ToastProvider } from './src/components/ToastContext';
import { StoragePermissionGate } from './src/components/StoragePermissionGate';
import { RootNavigator } from './src/navigation/RootNavigator';
import { backgroundUploadScheduler, kafkaConsumer, megaService } from './src/services/singletons';
import { installGlobalErrorLogger } from './src/utils/errorLogger';

/** Starts/stops the scheduled upload pass and Kafka consumer with auth. */
function BackgroundServices() {
  const { status } = useAuth();

  useEffect(() => {
    if (status === 'authenticated') {
      backgroundUploadScheduler.schedule();
      kafkaConsumer.start();
      // Authenticate against MEGA in the background so the first transfer does
      // not pay for the login.
      void megaService.warmUpAsync();
      return () => {
        backgroundUploadScheduler.cancel();
        void kafkaConsumer.stop();
      };
    }
    backgroundUploadScheduler.cancel();
    void kafkaConsumer.stop();
    return undefined;
  }, [status]);

  return null;
}

function Shell() {
  const { dark, colors } = useTheme();
  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <RootNavigator />
      <BackgroundServices />
      {/* Asks for Android storage permissions on launch and explains blockers. */}
      <StoragePermissionGate />
      <StatusBar style={dark ? 'light' : 'dark'} />
    </View>
  );
}

export default function App() {
  const [fontsLoaded] = useFonts({ OpenSans_400Regular });

  // Route uncaught JS errors (device-only failures included) to the error log
  // file with their stack traces.
  useEffect(() => {
    installGlobalErrorLogger();
  }, []);

  if (!fontsLoaded) {
    return (
      <View style={[styles.root, styles.loading, { backgroundColor: '#FFFFFF' }]}>
        <ActivityIndicator size="large" color="#512BD4" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AuthProvider>
          <ToastProvider>
            <Shell />
          </ToastProvider>
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  loading: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
