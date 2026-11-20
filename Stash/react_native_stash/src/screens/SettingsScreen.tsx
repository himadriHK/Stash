/**
 * Settings screen: appearance mode (System/Light/Dark), account identifiers,
 * log out, and the read-only configuration summary from appconfig.json.
 */
import React, { useCallback, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { AppButton } from '../components/AppButton';
import { NoteText, ScreenTitle } from '../components/FormText';
import { useToast } from '../components/ToastContext';
import { useAuth } from '../auth/AuthContext';
import { appConfig, identityApiBaseUrl, kafkaProxyUrl, kafkaRestUrl } from '../config/appConfig';
import { useTheme, type ThemeMode } from '../theme/ThemeContext';
import { FONT_FAMILY, fontSizes } from '../theme/typography';
import {
  clearErrorLogAsync,
  errorLogUri,
  readErrorLogTailAsync,
} from '../utils/errorLogger';
import { formatBytesAsMb } from '../utils/format';
import {
  getStorageAccessAsync,
  openStorageSettingsAsync,
  requestStorageAccessAsync,
  type StorageAccess,
} from '../utils/storagePermissions';

const MODES: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function SettingsRow({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.row, { borderBottomColor: colors.border }]}>
      <Text style={[styles.rowLabel, { color: colors.textMuted }]}>{label}</Text>
      <Text numberOfLines={2} style={[styles.rowValue, { color: colors.text }]}>
        {value}
      </Text>
    </View>
  );
}

function SectionTitle({ children }: { children: string }) {
  const { colors } = useTheme();
  return <Text style={[styles.sectionTitle, { color: colors.headline }]}>{children}</Text>;
}

export function SettingsScreen() {
  const { colors, mode, setMode } = useTheme();
  const { userId, deviceId, logout } = useAuth();
  const toast = useToast();
  const [errorLog, setErrorLog] = useState<string | null>(null);
  const [storageAccess, setStorageAccess] = useState<StorageAccess | null>(null);
  const logPath = errorLogUri();

  const refreshStorageAccess = useCallback(async () => {
    try {
      setStorageAccess(await getStorageAccessAsync());
    } catch {
      setStorageAccess(null);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refreshStorageAccess();
    }, [refreshStorageAccess]),
  );

  const onGrantStorage = useCallback(async () => {
    try {
      const access = await requestStorageAccessAsync();
      setStorageAccess(access);
      toast.show(
        access.state === 'granted' ? 'Storage access granted.' : access.detail,
        access.state === 'granted' ? undefined : { color: colors.error },
      );
    } catch (error) {
      toast.show(error instanceof Error ? error.message : String(error), { color: colors.error });
    }
  }, [toast, colors.error]);

  const onShowErrorLog = useCallback(async () => {
    if (errorLog !== null) {
      setErrorLog(null);
      return;
    }
    setErrorLog(await readErrorLogTailAsync());
  }, [errorLog]);

  const onClearErrorLog = useCallback(async () => {
    await clearErrorLogAsync();
    setErrorLog('');
    toast.show('Error log cleared.');
  }, [toast]);

  const onLogout = useCallback(async () => {
    try {
      await logout();
    } catch (error) {
      toast.show(error instanceof Error ? error.message : String(error), { color: colors.error });
    }
  }, [logout, toast, colors.error]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenTitle>Settings</ScreenTitle>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <SectionTitle>Appearance</SectionTitle>
        <View style={styles.modeRow}>
          {MODES.map((option) => {
            const active = mode === option.value;
            return (
              <Pressable
                key={option.value}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => setMode(option.value)}
                style={({ pressed }) => [
                  styles.modeChip,
                  {
                    backgroundColor: active ? colors.primarySolid : 'transparent',
                    borderColor: active ? colors.primarySolid : colors.border,
                  },
                  pressed ? styles.pressed : null,
                ]}
              >
                <Text
                  style={[
                    styles.modeLabel,
                    { color: active ? '#FFFFFF' : colors.text },
                  ]}
                >
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <SectionTitle>Account</SectionTitle>
        <SettingsRow label="User ID" value={userId || '—'} />
        <SettingsRow label="Device ID" value={deviceId || '—'} />

        <View style={styles.logoutButton}>
          <AppButton title="Log out" onPress={() => void onLogout()} testID="LogoutButton" />
        </View>

        <SectionTitle>Configuration</SectionTitle>
        <SettingsRow label="Identity API" value={identityApiBaseUrl() ?? 'Not configured'} />
        <SettingsRow label="Request timeout" value={`${appConfig.IdentityApiTimeoutSeconds}s`} />
        <SettingsRow label="Storage provider" value={appConfig.Storage.Provider} />
        <SettingsRow label="Upload batch size" value={String(appConfig.UploadSettings.BatchSize)} />
        <SettingsRow label="Maximum retries" value={String(appConfig.UploadSettings.MaxRetries)} />
        <SettingsRow
          label="Maximum file size"
          value={formatBytesAsMb(appConfig.UploadSettings.MaxFileSizeBytes)}
        />
        <SettingsRow
          label="Background upload"
          value={
            appConfig.BackgroundUpload.Enabled
              ? `Every ${appConfig.BackgroundUpload.IntervalMinutes} min`
              : 'Disabled'
          }
        />
        <SettingsRow
          label="Files per background run"
          value={
            appConfig.BackgroundUpload.MaxFilesPerRun <= 0
              ? 'Unlimited'
              : String(appConfig.BackgroundUpload.MaxFilesPerRun)
          }
        />
        <SettingsRow
          label={appConfig.Kafka.Proxy.Enabled && kafkaProxyUrl() ? 'Kafka proxy' : 'Kafka REST proxy'}
          value={
            (appConfig.Kafka.Proxy.Enabled && kafkaProxyUrl() ? kafkaProxyUrl() : kafkaRestUrl()) ??
            'Not configured'
          }
        />
        <SettingsRow label="Upload request topic" value={appConfig.Kafka.TopicUploadRequest} />
        <SettingsRow label="Upload response topic" value={appConfig.Kafka.TopicUploadResponse} />
        <SettingsRow label="Dead letter topic" value={appConfig.Kafka.TopicDeadLetter} />

        <SectionTitle>Diagnostics</SectionTitle>
        <SettingsRow
          label="Storage permission"
          value={storageAccess?.summary ?? 'Checking…'}
        />
        {storageAccess && storageAccess.state !== 'granted' && storageAccess.state !== 'unsupported' ? (
          <>
            <View style={styles.diagnosticsButtons}>
              <AppButton
                title="Grant storage access"
                onPress={() => void onGrantStorage()}
                testID="GrantStorageAccessButton"
              />
              <AppButton
                title="Open permission settings"
                variant="link"
                onPress={() => void openStorageSettingsAsync()}
                testID="OpenStorageSettingsButton"
              />
            </View>
            <NoteText style={styles.permissionNote}>{storageAccess.detail}</NoteText>
          </>
        ) : null}
        <SettingsRow label="Error log file" value={logPath ?? 'Not available on this platform'} />
        <View style={styles.diagnosticsButtons}>
          <AppButton
            title={errorLog === null ? 'Show error log' : 'Hide error log'}
            onPress={() => void onShowErrorLog()}
            testID="ShowErrorLogButton"
          />
          <AppButton
            title="Clear error log"
            variant="link"
            onPress={() => void onClearErrorLog()}
            testID="ClearErrorLogButton"
          />
        </View>
        {errorLog !== null ? (
          <ScrollView
            style={[styles.logBox, { borderColor: colors.border, backgroundColor: colors.card }]}
            nestedScrollEnabled
          >
            <Text selectable style={[styles.logText, { color: colors.text }]}>
              {errorLog.trim().length > 0 ? errorLog : 'No errors logged yet.'}
            </Text>
          </ScrollView>
        ) : null}

        <NoteText style={styles.footerNote}>
          Configuration comes from src/config/appconfig.json, with secrets supplied via EXPO_PUBLIC_* environment variables (.env).
        </NoteText>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 32,
  },
  sectionTitle: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.subHeadline * 0.8,
    marginTop: 20,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  modeRow: {
    flexDirection: 'row',
    marginHorizontal: 16,
    gap: 8,
  },
  modeChip: {
    flex: 1,
    minHeight: 44,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  modeLabel: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
  },
  pressed: {
    opacity: 0.8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    gap: 16,
  },
  rowLabel: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
    flexShrink: 1,
  },
  rowValue: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
    flexShrink: 2,
    textAlign: 'right',
  },
  logoutButton: {
    marginHorizontal: 16,
    marginTop: 16,
  },
  diagnosticsButtons: {
    marginHorizontal: 16,
    marginTop: 12,
    gap: 8,
  },
  logBox: {
    marginHorizontal: 16,
    marginTop: 12,
    maxHeight: 320,
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
  },
  logText: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 11,
  },
  permissionNote: {
    marginTop: 8,
    marginHorizontal: 16,
  },
  footerNote: {
    marginTop: 16,
    marginHorizontal: 16,
    textAlign: 'center',
  },
});
