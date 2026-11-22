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
import { appConfig, identityApiBaseUrl, kafkaProxyUrl } from '../config/appConfig';
import { useTheme, type ThemeMode } from '../theme/ThemeContext';
import { FONT_FAMILY, fontSizes } from '../theme/typography';
import {
  clearErrorLogAsync,
  errorLogUri,
  readErrorLogTailAsync,
} from '../utils/errorLogger';
import { formatBytesAsMb, formatDate } from '../utils/format';
import {
  collectDiagnosticsAsync,
  type DiagnosticsSnapshot,
  type RecentFileEvent,
  type StatusCount,
} from '../services/diagnosticsService';
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

function countFor(entries: StatusCount[], status: string): number {
  return entries.find((entry) => entry.status.toLowerCase() === status.toLowerCase())?.count ?? 0;
}

function filesSummary(snapshot: DiagnosticsSnapshot): string {
  if (snapshot.totalFiles === 0) {
    return 'No files';
  }
  return snapshot.files.map((entry) => `${entry.status}: ${entry.count}`).join(' · ');
}

function outboxSummary(snapshot: DiagnosticsSnapshot): string {
  const total = snapshot.outbox.reduce((sum, entry) => sum + entry.count, 0);
  if (total === 0) {
    return 'No outbox rows';
  }
  return ['pending', 'sending', 'sent', 'dead']
    .map((status) => `${status}: ${countFor(snapshot.outbox, status)}`)
    .join(' · ');
}

function lastPassSummary(snapshot: DiagnosticsSnapshot): string {
  if (!snapshot.lastPass) {
    return 'Not run yet';
  }
  const { at, result } = snapshot.lastPass;
  return `${formatDate(at)} · uploaded ${result.uploaded}, queued ${result.queued}, failed ${result.failed}`;
}

function lastFlushSummary(snapshot: DiagnosticsSnapshot): string {
  if (!snapshot.lastOutboxFlush) {
    return 'Not run yet';
  }
  const { at, result } = snapshot.lastOutboxFlush;
  return `${formatDate(at)} · sent ${result.sent}, retried ${result.retried}, dead ${result.dead}`;
}

function eventLine(event: RecentFileEvent): string {
  const transition =
    event.fromStatus && event.toStatus
      ? `${event.fromStatus}→${event.toStatus}`
      : event.fromStatus || event.toStatus || '—';
  const parts = [formatDate(event.createdAt), event.event, transition];
  if (event.errorCode) {
    parts.push(event.errorCode);
  }
  return parts.join('  ');
}

export function SettingsScreen() {
  const { colors, mode, setMode } = useTheme();
  const { userId, deviceId, logout } = useAuth();
  const toast = useToast();
  const [errorLog, setErrorLog] = useState<string | null>(null);
  const [storageAccess, setStorageAccess] = useState<StorageAccess | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const logPath = errorLogUri();

  const refreshStorageAccess = useCallback(async () => {
    try {
      setStorageAccess(await getStorageAccessAsync());
    } catch {
      setStorageAccess(null);
    }
  }, []);

  const refreshDiagnostics = useCallback(async () => {
    setDiagnosticsLoading(true);
    try {
      const snapshot = await collectDiagnosticsAsync();
      setDiagnostics(snapshot);
      setDiagnosticsError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDiagnosticsError(message);
      toast.show(message, { color: colors.error });
    } finally {
      setDiagnosticsLoading(false);
    }
  }, [toast, colors.error]);

  useFocusEffect(
    useCallback(() => {
      void refreshStorageAccess();
      void refreshDiagnostics();
    }, [refreshStorageAccess, refreshDiagnostics]),
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
        <SettingsRow
          label="Storage bucket"
          value={appConfig.Storage.S3.Bucket || 'Not configured'}
        />
        <SettingsRow label="Storage region" value={appConfig.Storage.S3.Region || '—'} />
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
        <SettingsRow label="Kafka proxy" value={kafkaProxyUrl() ?? 'Not configured'} />
        <SettingsRow label="Upload request topic" value={appConfig.Kafka.TopicUploadRequest} />
        <SettingsRow label="Upload response topic" value={appConfig.Kafka.TopicUploadResponse} />
        <SettingsRow label="Dead letter topic" value={appConfig.Kafka.TopicDeadLetter} />

        <SectionTitle>Diagnostics</SectionTitle>
        <SettingsRow
          label="Files by status"
          value={diagnostics ? filesSummary(diagnostics) : '—'}
        />
        <SettingsRow
          label="Stuck uploads"
          value={diagnostics ? String(diagnostics.stuckUploading) : '—'}
        />
        <SettingsRow
          label="Stuck processing"
          value={diagnostics ? String(diagnostics.stuckProcessing) : '—'}
        />
        <SettingsRow label="Outbox" value={diagnostics ? outboxSummary(diagnostics) : '—'} />
        <SettingsRow
          label="Hash cache entries"
          value={diagnostics ? String(diagnostics.hashCacheEntries) : '—'}
        />
        <SettingsRow
          label="Processed responses"
          value={diagnostics ? String(diagnostics.processedMessages) : '—'}
        />
        <SettingsRow
          label="Last background pass"
          value={diagnostics ? lastPassSummary(diagnostics) : '—'}
        />
        <SettingsRow
          label="Last outbox flush"
          value={diagnostics ? lastFlushSummary(diagnostics) : '—'}
        />
        <SettingsRow
          label="Last Kafka response"
          value={
            diagnostics
              ? diagnostics.lastConsumerRecordAt
                ? formatDate(diagnostics.lastConsumerRecordAt)
                : 'None'
              : '—'
          }
        />
        <View style={styles.eventBlock}>
          <Text style={[styles.rowLabel, { color: colors.textMuted }]}>Recent file events</Text>
          <Text selectable style={[styles.eventText, { color: colors.text }]}>
            {diagnostics
              ? diagnostics.recentEvents.length > 0
                ? diagnostics.recentEvents.map(eventLine).join('\n')
                : 'None'
              : '—'}
          </Text>
        </View>
        <View style={styles.diagnosticsButtons}>
          <AppButton
            title={diagnosticsLoading ? 'Refreshing…' : 'Refresh diagnostics'}
            onPress={() => void refreshDiagnostics()}
            disabled={diagnosticsLoading}
            testID="RefreshDiagnosticsButton"
          />
        </View>
        {diagnosticsError ? (
          <NoteText style={[styles.permissionNote, { color: colors.error }]}>
            {`Diagnostics unavailable: ${diagnosticsError}`}
          </NoteText>
        ) : null}
        <NoteText style={styles.permissionNote}>
          Storage access below applies to manually entered file paths only. Folders added with the
          system picker use per-folder grants and do not need these broad permissions.
        </NoteText>
        <SettingsRow
          label="Legacy path storage access"
          value={storageAccess?.summary ?? 'Checking…'}
        />
        {storageAccess && storageAccess.state !== 'granted' && storageAccess.state !== 'unsupported' ? (
          <>
            <View style={styles.diagnosticsButtons}>
              <AppButton
                title="Grant legacy path access"
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
  eventBlock: {
    marginHorizontal: 16,
    marginTop: 12,
    gap: 4,
  },
  eventText: {
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
