/**
 * Settings screen: appearance mode (System/Light/Dark), account identifiers,
 * log out, and the read-only configuration summary from appconfig.json.
 */
import React, { useCallback, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import * as Application from 'expo-application';
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
import { formatBytesAsMb, formatDate, formatFileSize, formatRelativeTime } from '../utils/format';
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
import type { FileSummary } from '../data/fileRepository';
import {
  backgroundUploadService,
  backgroundUploadScheduler,
  fileRepository,
} from '../services/singletons';
import {
  getUiPreferencesAsync,
  setAutoUploadAsync,
  setBackupVideosAsync,
  type UiPreferences,
} from '../services/uiPreferences';

const MODES: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const SettingsRow = React.memo(function SettingsRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.row, { borderBottomColor: colors.border }]}>
      <Text style={[styles.rowLabel, { color: colors.textMuted }]}>{label}</Text>
      <Text numberOfLines={2} style={[styles.rowValue, { color: colors.text }]}>
        {value}
      </Text>
    </View>
  );
});

const SectionTitle = React.memo(function SectionTitle({ children }: { children: string }) {
  const { colors } = useTheme();
  return <Text style={[styles.sectionTitle, { color: colors.headline }]}>{children}</Text>;
});

const StatCard = React.memo(function StatCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.statValue, { color: colors.text }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.textMuted }]}>{label}</Text>
    </View>
  );
});

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

interface BackupStatusSectionProps {
  summary: FileSummary | null;
  syncing: boolean;
  onSyncNow: () => void;
}

/**
 * Split out and memoized so diagnostics/preference/storage updates do not
 * re-render the backup cards. Re-renders only when the summary or sync state
 * changes.
 */
const BackupStatusSection = React.memo(function BackupStatusSection({
  summary,
  syncing,
  onSyncNow,
}: BackupStatusSectionProps) {
  return (
    <>
      <SectionTitle>Backup Status</SectionTitle>
      <View style={styles.statsGrid}>
        <StatCard label="Total Files" value={summary ? String(summary.totalFiles) : '—'} />
        <StatCard
          label="Total Size"
          value={summary ? formatFileSize(summary.totalBytes) : '—'}
        />
        <StatCard
          label="Pending Upload"
          value={summary ? String(summary.pendingCount) : '—'}
        />
        <StatCard
          label="Last Sync"
          value={summary ? formatRelativeTime(summary.lastActivityAt) : '—'}
        />
      </View>
      <SettingsRow
        label="Storage status"
        value={
          appConfig.Storage.S3.Bucket && appConfig.Storage.S3.AccessKeyId
            ? 'Configured'
            : 'Not configured'
        }
      />
      <View style={styles.diagnosticsButtons}>
        <AppButton
          title={syncing ? 'Syncing…' : 'Sync now'}
          onPress={onSyncNow}
          disabled={syncing}
          testID="SyncNowButton"
        />
      </View>
      <NoteText style={styles.permissionNote}>
        Runs the same scan, dedup, upload and publish pass as pulling to refresh.
      </NoteText>
    </>
  );
});

interface PreferencesSectionProps {
  preferences: UiPreferences | null;
  onToggleAutoUpload: (enabled: boolean) => void;
  onToggleBackupVideos: (enabled: boolean) => void;
}

const PreferencesSection = React.memo(function PreferencesSection({
  preferences,
  onToggleAutoUpload,
  onToggleBackupVideos,
}: PreferencesSectionProps) {
  const { colors } = useTheme();
  return (
    <>
      <SectionTitle>Preferences</SectionTitle>
      <View style={[styles.switchRow, { borderBottomColor: colors.border }]}>
        <View style={styles.switchBody}>
          <Text style={[styles.switchLabel, { color: colors.text }]}>Auto-upload</Text>
          <Text style={[styles.switchHint, { color: colors.textMuted }]}>
            Automatically back up new files every{' '}
            {appConfig.BackgroundUpload.IntervalMinutes} minutes while the app is open.
          </Text>
        </View>
        <Switch
          value={preferences?.autoUpload ?? appConfig.BackgroundUpload.Enabled}
          onValueChange={onToggleAutoUpload}
          trackColor={{ true: colors.switchTrackOn, false: colors.switchTrackOff }}
          thumbColor={colors.switchThumb}
          accessibilityLabel="Auto-upload"
        />
      </View>
      <View style={[styles.switchRow, { borderBottomColor: colors.border }]}>
        <View style={styles.switchBody}>
          <Text style={[styles.switchLabel, { color: colors.text }]}>Backup videos</Text>
          <Text style={[styles.switchHint, { color: colors.textMuted }]}>
            Include videos in the automatic upload pass. Manual uploads are unaffected.
          </Text>
        </View>
        <Switch
          value={preferences?.backupVideos ?? true}
          onValueChange={onToggleBackupVideos}
          trackColor={{ true: colors.switchTrackOn, false: colors.switchTrackOff }}
          thumbColor={colors.switchThumb}
          accessibilityLabel="Backup videos"
        />
      </View>
      <NoteText style={styles.permissionNote}>
        Wi-Fi-only uploads and thumbnail quality from the design mockups are not part of this
        build: the app has no network-info module or thumbnail pipeline.
      </NoteText>
    </>
  );
});

interface DiagnosticsSectionProps {
  diagnostics: DiagnosticsSnapshot | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

const DiagnosticsSection = React.memo(function DiagnosticsSection({
  diagnostics,
  loading,
  error,
  onRefresh,
}: DiagnosticsSectionProps) {
  const { colors } = useTheme();
  return (
    <>
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
          title={loading ? 'Refreshing…' : 'Refresh diagnostics'}
          onPress={onRefresh}
          disabled={loading}
          testID="RefreshDiagnosticsButton"
        />
      </View>
      {error ? (
        <NoteText style={[styles.permissionNote, { color: colors.error }]}>
          {`Diagnostics unavailable: ${error}`}
        </NoteText>
      ) : null}
    </>
  );
});

interface StorageSectionProps {
  storageAccess: StorageAccess | null;
  errorLog: string | null;
  onGrantStorage: () => void;
  onOpenStorageSettings: () => void;
  onShowErrorLog: () => void;
  onClearErrorLog: () => void;
}

const StorageSection = React.memo(function StorageSection({
  storageAccess,
  errorLog,
  onGrantStorage,
  onOpenStorageSettings,
  onShowErrorLog,
  onClearErrorLog,
}: StorageSectionProps) {
  const { colors } = useTheme();
  const logPath = errorLogUri();
  return (
    <>
      <NoteText style={styles.permissionNote}>
        Storage access below applies to manually entered file paths only. Folders added with the
        system picker use per-folder grants and do not need these broad permissions.
      </NoteText>
      <SettingsRow
        label="Legacy path storage access"
        value={storageAccess?.summary ?? 'Checking…'}
      />
      {storageAccess &&
      storageAccess.state !== 'granted' &&
      storageAccess.state !== 'unsupported' ? (
        <>
          <View style={styles.diagnosticsButtons}>
            <AppButton
              title="Grant legacy path access"
              onPress={onGrantStorage}
              testID="GrantStorageAccessButton"
            />
            <AppButton
              title="Open permission settings"
              variant="link"
              onPress={onOpenStorageSettings}
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
          onPress={onShowErrorLog}
          testID="ShowErrorLogButton"
        />
        <AppButton
          title="Clear error log"
          variant="link"
          onPress={onClearErrorLog}
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
    </>
  );
});

export function SettingsScreen() {
  const { colors, mode, setMode } = useTheme();
  const { userId, deviceId, logout } = useAuth();
  const toast = useToast();
  const [errorLog, setErrorLog] = useState<string | null>(null);
  const [storageAccess, setStorageAccess] = useState<StorageAccess | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [summary, setSummary] = useState<FileSummary | null>(null);
  const [preferences, setPreferences] = useState<UiPreferences | null>(null);
  const [syncing, setSyncing] = useState(false);
  const appVersion = Application.nativeApplicationVersion ?? '1.0.0';
  const buildVersion = Application.nativeBuildVersion;

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

  const refreshSummary = useCallback(async () => {
    try {
      setSummary(await fileRepository.getSummaryAsync());
    } catch (error) {
      console.warn('Failed to load the backup summary.', error);
    }
  }, []);

  const refreshPreferences = useCallback(async () => {
    try {
      setPreferences(await getUiPreferencesAsync());
    } catch (error) {
      console.warn('Failed to load UI preferences.', error);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refreshStorageAccess();
      void refreshDiagnostics();
      void refreshSummary();
      void refreshPreferences();
    }, [refreshStorageAccess, refreshDiagnostics, refreshSummary, refreshPreferences]),
  );

  const onToggleAutoUpload = useCallback(
    async (enabled: boolean) => {
      try {
        const next = await setAutoUploadAsync(enabled);
        setPreferences(next);
        backgroundUploadScheduler.setEnabled(enabled);
        toast.show(enabled ? 'Auto-upload enabled' : 'Auto-upload disabled');
      } catch (error) {
        toast.show(error instanceof Error ? error.message : String(error), { color: colors.error });
      }
    },
    [toast, colors.error],
  );

  const onToggleBackupVideos = useCallback(
    async (enabled: boolean) => {
      try {
        const next = await setBackupVideosAsync(enabled);
        setPreferences(next);
        toast.show(enabled ? 'Videos included in automatic backup' : 'Videos excluded from automatic backup');
      } catch (error) {
        toast.show(error instanceof Error ? error.message : String(error), { color: colors.error });
      }
    },
    [toast, colors.error],
  );

  const onSyncNow = useCallback(async () => {
    if (syncing) {
      return;
    }
    setSyncing(true);
    try {
      const result = await backgroundUploadService.runOnceAsync();
      toast.show(
        result.success
          ? `Upload pass: ${result.scanned} scanned, ${result.discovered} new, ${result.uploaded} uploaded`
          : result.error ?? 'Background upload pass failed.',
        result.success ? undefined : { color: colors.error },
      );
      await refreshSummary();
      await refreshDiagnostics();
    } catch (error) {
      toast.show(error instanceof Error ? error.message : String(error), { color: colors.error });
    } finally {
      setSyncing(false);
    }
  }, [syncing, toast, colors.error, refreshSummary, refreshDiagnostics]);

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

        <BackupStatusSection summary={summary} syncing={syncing} onSyncNow={onSyncNow} />

        <PreferencesSection
          preferences={preferences}
          onToggleAutoUpload={onToggleAutoUpload}
          onToggleBackupVideos={onToggleBackupVideos}
        />

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

        <DiagnosticsSection
          diagnostics={diagnostics}
          loading={diagnosticsLoading}
          error={diagnosticsError}
          onRefresh={refreshDiagnostics}
        />

        <StorageSection
          storageAccess={storageAccess}
          errorLog={errorLog}
          onGrantStorage={onGrantStorage}
          onOpenStorageSettings={openStorageSettingsAsync}
          onShowErrorLog={onShowErrorLog}
          onClearErrorLog={onClearErrorLog}
        />

        <SectionTitle>About</SectionTitle>
        <SettingsRow label="Application" value="Stash (React Native / Expo)" />
        <SettingsRow
          label="Version"
          value={`${appVersion}${buildVersion ? ` (build ${buildVersion})` : ''}`}
        />
        <SettingsRow label="Storage" value={`${appConfig.Storage.Provider} compatible`} />

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
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  statCard: {
    flexGrow: 1,
    flexBasis: '47%',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 10,
    alignItems: 'center',
  },
  statValue: {
    fontFamily: FONT_FAMILY,
    fontSize: 20,
  },
  statLabel: {
    fontFamily: FONT_FAMILY,
    fontSize: 11,
    marginTop: 2,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    gap: 12,
  },
  switchBody: {
    flex: 1,
  },
  switchLabel: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
  },
  switchHint: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.small,
    marginTop: 2,
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
