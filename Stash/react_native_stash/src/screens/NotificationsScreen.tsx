/**
 * Notification Center (mockup 05-notifications.html).
 *
 * The feed is derived from the newest file rows (no inbox table, no mock data):
 * tabs filter by upload class, unread dots compare against the persisted
 * "marked all read" timestamp, failed items can be retried, and every item has
 * a details sheet. MEGA "storage full" placeholder entries are intentionally
 * absent because the app uses S3-compatible storage.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { ActionDialog } from '../components/ActionDialog';
import { EmptyState } from '../components/EmptyState';
import { useToast } from '../components/ToastContext';
import { fileRepository } from '../services/singletons';
import { uploadAndPublishAsync } from '../services/uploadActions';
import {
  buildNotificationItems,
  emptyCopy,
  filterNotificationItems,
  notificationFilters,
  type NotificationFilter,
  type NotificationItem,
} from '../services/notificationFeed';
import {
  getUiPreferencesAsync,
  markNotificationsSeenAsync,
} from '../services/uiPreferences';
import { UploadStatus, uploadStatusColor, uploadStatusIcon } from '../models/uploadStatus';
import { useTheme } from '../theme/ThemeContext';
import { FONT_FAMILY, fontSizes } from '../theme/typography';
import { formatDate, formatRelativeTime } from '../utils/format';

const FEED_LIMIT = 100;

export function NotificationsScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [filter, setFilter] = useState<NotificationFilter>('all');
  const [seenAt, setSeenAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<NotificationItem | null>(null);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    try {
      const [files, preferences] = await Promise.all([
        fileRepository.getRecentActivityAsync(FEED_LIMIT),
        getUiPreferencesAsync(),
      ]);
      setItems(buildNotificationItems(files));
      setSeenAt(preferences.notificationsSeenAt);
    } catch (error) {
      console.warn('Failed to load notifications.', error);
      setItems([]);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const visible = useMemo(
    () => (items ? filterNotificationItems(items, filter) : []),
    [items, filter],
  );

  const seenMs = seenAt ? new Date(seenAt).getTime() : 0;
  const unreadCount = useMemo(
    () =>
      (items ?? []).filter((item) => {
        const time = new Date(item.createdAt).getTime();
        return Number.isFinite(time) && time > seenMs;
      }).length,
    [items, seenMs],
  );

  const onMarkAllRead = useCallback(async () => {
    try {
      const next = await markNotificationsSeenAsync();
      setSeenAt(next.notificationsSeenAt);
    } catch (error) {
      toast.show(error instanceof Error ? error.message : String(error), { color: colors.error });
    }
  }, [toast, colors.error]);

  const onRetry = useCallback(
    async (item: NotificationItem) => {
      if (retrying) {
        return;
      }
      setRetrying(true);
      toast.show(`Retrying upload: ${item.file.fileName}`);
      try {
        const fresh = await fileRepository.getByIdAsync(item.file.id);
        if (!fresh) {
          await load();
          return;
        }
        const outcome = await uploadAndPublishAsync(fresh);
        toast.show(
          outcome.queued ? `Upload queued: ${fresh.fileName}` : outcome.error ?? 'Upload failed.',
          outcome.queued ? undefined : { color: colors.error },
        );
      } catch (error) {
        toast.show(error instanceof Error ? error.message : String(error), { color: colors.error });
      } finally {
        setRetrying(false);
        await load();
      }
    },
    [retrying, toast, colors.error, load],
  );

  const empty = emptyCopy[filter];
  const selectedNeedsRetry =
    selected?.file.status === UploadStatus.Failed ||
    selected?.file.status === UploadStatus.Retrying;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.tabBar, { borderBottomColor: colors.border }]}>
        {notificationFilters.map((option) => {
          const active = filter === option.value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => setFilter(option.value)}
              style={({ pressed }) => [
                styles.tab,
                {
                  borderBottomColor: active ? colors.primarySolid : 'transparent',
                },
                pressed ? styles.pressed : null,
              ]}
            >
              <Text style={[styles.tabLabel, { color: active ? colors.text : colors.textMuted }]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {items !== null && unreadCount > 0 ? (
        <View style={styles.statusRow}>
          <Text style={[styles.unreadLabel, { color: colors.textMuted }]}>
            {unreadCount} unread
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Mark all notifications read"
            onPress={() => void onMarkAllRead()}
            style={({ pressed }) => [styles.markRead, pressed ? styles.pressed : null]}
          >
            <Text style={[styles.markReadLabel, { color: colors.link }]}>Mark all read</Text>
          </Pressable>
        </View>
      ) : null}

      {items === null ? (
        <EmptyState icon="notifications-outline" title="Loading…" subtitle="" />
      ) : visible.length === 0 ? (
        <EmptyState icon="notifications-outline" title={empty.title} subtitle={empty.subtitle} />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primarySolid}
            />
          }
          renderItem={({ item }) => {
            const unread = new Date(item.createdAt).getTime() > seenMs;
            const statusColor = uploadStatusColor(item.file.status);
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${item.title}. ${item.subtitle}`}
                onPress={() => setSelected(item)}
                style={({ pressed }) => [
                  styles.item,
                  {
                    backgroundColor: unread ? colors.secondarySurface : colors.card,
                    borderBottomColor: colors.border,
                  },
                  pressed ? styles.pressed : null,
                ]}
              >
                <View style={[styles.iconWrap, { backgroundColor: `${statusColor}22` }]}>
                  <Ionicons
                    name={
                      uploadStatusIcon(item.file.status) as React.ComponentProps<
                        typeof Ionicons
                      >['name']
                    }
                    size={22}
                    color={statusColor}
                  />
                </View>
                <View style={styles.itemBody}>
                  <Text numberOfLines={1} style={[styles.itemTitle, { color: colors.text }]}>
                    {item.title}
                  </Text>
                  <Text numberOfLines={2} style={[styles.itemSubtitle, { color: colors.textMuted }]}>
                    {item.subtitle}
                  </Text>
                  <Text style={[styles.itemTime, { color: colors.textMuted }]}>
                    {formatRelativeTime(item.createdAt)}
                  </Text>
                </View>
                {unread ? <View style={[styles.dot, { backgroundColor: colors.error }]} /> : null}
              </Pressable>
            );
          }}
        />
      )}

      <ActionDialog
        visible={selected !== null}
        title={selected?.title ?? ''}
        message={
          selected
            ? [
                `File: ${selected.file.fileName}`,
                `Status: ${selected.file.status}`,
                `Recorded: ${formatDate(selected.createdAt)}`,
                ...(selected.file.errorMessage ? [`Error: ${selected.file.errorMessage}`] : []),
              ].join('\n')
            : ''
        }
        buttons={[
          ...(selectedNeedsRetry && selected
            ? [{ label: 'Retry upload', onPress: () => void onRetry(selected) }]
            : []),
          { label: 'Close', style: 'cancel' as const },
        ]}
        onClose={() => setSelected(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
  },
  tab: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 2,
  },
  tabLabel: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
  },
  pressed: {
    opacity: 0.7,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  unreadLabel: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.small,
  },
  markRead: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  markReadLabel: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.small,
  },
  listContent: {
    paddingBottom: 24,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 72,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemBody: {
    flex: 1,
    marginLeft: 12,
  },
  itemTitle: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
  },
  itemSubtitle: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.small,
    marginTop: 2,
  },
  itemTime: {
    fontFamily: FONT_FAMILY,
    fontSize: 11,
    marginTop: 4,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginLeft: 8,
  },
});
