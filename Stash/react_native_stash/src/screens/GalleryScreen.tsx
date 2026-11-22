/**
 * Gallery screen (mockup 02-gallery.html): three-column media grid with filter
 * chips, search, pending-sync badge, selection mode (share/remove/done),
 * notification and settings entry points, pull-to-refresh and an add-folder FAB.
 *
 * Tiles use the stored thumbnail map or the local file URI; this client does not
 * generate thumbnails, so unsupported/unreadable sources fall back to a status
 * icon. Removing an item deletes only the Stash record, never the device file.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type ListRenderItem,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ActionDialog } from '../components/ActionDialog';
import { EmptyState } from '../components/EmptyState';
import { MediaTile } from '../components/MediaTile';
import { SyncBanner } from '../components/SyncBanner';
import { useToast } from '../components/ToastContext';
import { useAuth } from '../auth/AuthContext';
import type { RootStackParamList } from '../navigation/types';
import { backgroundUploadService, fileRepository } from '../services/singletons';
import { uploadAndPublishAsync } from '../services/uploadActions';
import { isFavorite, loadFavoritesAsync, toggleFavoriteAsync } from '../services/favoritesStore';
import type { FileEntity } from '../models/fileEntity';
import type { FileSummary } from '../data/fileRepository';
import { UploadStatus } from '../models/uploadStatus';
import { useTheme } from '../theme/ThemeContext';
import { FONT_FAMILY, fontSizes } from '../theme/typography';
import { formatDate, formatFileSize } from '../utils/format';

type Props = NativeStackNavigationProp<RootStackParamList>;
type GalleryFilter = 'all' | 'photos' | 'videos' | 'favorites';

const PAGE_SIZE = 60;

/** Columns and tile metrics must match the styles below for `getItemLayout`. */
const NUM_COLUMNS = 3;
const GRID_PADDING = 12;
const TILE_WIDTH_FRACTION = 0.315;
const TILE_MARGIN_BOTTOM = 10;

const keyExtractor = (item: FileEntity) => item.id;

const FILTERS: { value: GalleryFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'photos', label: 'Photos' },
  { value: 'videos', label: 'Videos' },
  { value: 'favorites', label: 'Favorites' },
];

export function GalleryScreen() {
  const { colors } = useTheme();
  const { status } = useAuth();
  const toast = useToast();
  const navigation = useNavigation<Props>();
  const { width: windowWidth } = useWindowDimensions();

  const [files, setFiles] = useState<FileEntity[] | null>(null);
  const [summary, setSummary] = useState<FileSummary | null>(null);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<GalleryFilter>('all');
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [menuFile, setMenuFile] = useState<FileEntity | null>(null);
  const [detailsFile, setDetailsFile] = useState<FileEntity | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const filesRef = useRef<FileEntity[] | null>(null);
  const loadingMoreRef = useRef(false);
  const hasMoreRef = useRef(true);
  const passRef = useRef(false);

  const loadPage = useCallback(async (reset: boolean) => {
    if (!reset && (loadingMoreRef.current || !hasMoreRef.current)) {
      return;
    }
    if (!reset) {
      loadingMoreRef.current = true;
      setLoadingMore(true);
    }
    const offset = reset ? 0 : filesRef.current?.length ?? 0;
    try {
      const page = await fileRepository.getPageAsync(PAGE_SIZE, offset);
      setFiles((current) => {
        let next: FileEntity[];
        if (reset || !current) {
          next = page;
        } else {
          const seen = new Set(current.map((item) => item.id));
          next = [...current, ...page.filter((item) => !seen.has(item.id))];
        }
        filesRef.current = next;
        return next;
      });
      hasMoreRef.current = page.length === PAGE_SIZE;
      setHasMore(hasMoreRef.current);
    } catch (error) {
      console.warn('Failed to load the gallery.', error);
      if (reset) {
        filesRef.current = [];
        setFiles([]);
      }
    } finally {
      if (!reset) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, []);

  const refreshSummary = useCallback(async () => {
    try {
      setSummary(await fileRepository.getSummaryAsync());
    } catch (error) {
      console.warn('Failed to load the file summary.', error);
    }
  }, []);

  const refreshFavorites = useCallback(async () => {
    setFavorites(await loadFavoritesAsync());
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadPage(true);
      void refreshSummary();
      void refreshFavorites();
    }, [loadPage, refreshSummary, refreshFavorites]),
  );

  /**
   * Reloads the grid, then starts the upload pass without awaiting it. The pass
   * walks every discovered file, so awaiting it inside the refresh gesture would
   * leave the grid unresponsive for minutes; progress is shown in the sync row.
   */
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadPage(true);
      await refreshSummary();
    } finally {
      setRefreshing(false);
    }

    if (status !== 'authenticated' || passRef.current) {
      return;
    }

    passRef.current = true;
    try {
      const result = await backgroundUploadService.runOnceAsync();
      if (result.alreadyRunning) {
        // Another pass (scheduled or started elsewhere) owns the pipeline.
        return;
      }
      toast.show(
        result.success
          ? `Upload pass: ${result.scanned} scanned, ${result.discovered} new, ${result.uploaded} uploaded`
          : result.error ?? 'Background upload pass failed.',
        result.success ? undefined : { color: colors.error },
      );
    } catch (error) {
      toast.show(error instanceof Error ? error.message : String(error), { color: colors.error });
    } finally {
      passRef.current = false;
      await loadPage(true);
      await refreshSummary();
    }
  }, [status, toast, colors.error, loadPage, refreshSummary]);

  const filtered = useMemo(() => {
    let list = files ?? [];
    const query = searchText.trim().toLowerCase();
    if (query) {
      list = list.filter((file) => file.fileName.toLowerCase().includes(query));
    }
    if (filter === 'photos') {
      list = list.filter((file) => file.mimeType.toLowerCase().startsWith('image/'));
    } else if (filter === 'videos') {
      list = list.filter((file) => file.mimeType.toLowerCase().startsWith('video/'));
    } else if (filter === 'favorites') {
      list = list.filter((file) => isFavorite(favorites, file));
    }
    return list;
  }, [files, filter, searchText, favorites]);

  const tileSize = useMemo(
    () => Math.max(0, (windowWidth - GRID_PADDING * 2) * TILE_WIDTH_FRACTION),
    [windowWidth],
  );

  const getItemLayout = useCallback(
    (_data: ArrayLike<FileEntity> | null | undefined, index: number) => {
      const length = tileSize + TILE_MARGIN_BOTTOM;
      return { length, offset: length * Math.floor(index / NUM_COLUMNS), index };
    },
    [tileSize],
  );

  const selectionMode = selection.size > 0;

  const toggleSelected = useCallback((id: string) => {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelection(new Set()), []);

  const onTilePress = useCallback(
    (file: FileEntity) => {
      if (selectionMode) {
        toggleSelected(file.id);
      } else {
        setMenuFile(file);
      }
    },
    [selectionMode, toggleSelected],
  );

  const onTileLongPress = useCallback(
    (file: FileEntity) => {
      toggleSelected(file.id);
    },
    [toggleSelected],
  );

  /**
   * Memoized so the FlatList can skip re-rendering its rows when only unrelated
   * screen state changes (for example the sync banner's progress ticks). It is
   * recreated when selection or favorites change, which is exactly when the
   * tiles need to re-read those values.
   */
  const renderItem = useCallback<ListRenderItem<FileEntity>>(
    ({ item }) => (
      <View style={styles.tileWrap}>
        <MediaTile
          file={item}
          selected={selection.has(item.id)}
          favorite={isFavorite(favorites, item)}
          onPress={onTilePress}
          onLongPress={onTileLongPress}
        />
      </View>
    ),
    [selection, favorites, onTilePress, onTileLongPress],
  );

  const onToggleFavorite = useCallback(
    async (file: FileEntity) => {
      try {
        const next = await toggleFavoriteAsync(file);
        setFavorites(next);
        toast.show(isFavorite(next, file) ? 'Added to favorites' : 'Removed from favorites');
      } catch (error) {
        toast.show(error instanceof Error ? error.message : String(error), { color: colors.error });
      }
    },
    [toast, colors.error],
  );

  const onRetry = useCallback(
    async (file: FileEntity) => {
      if (retrying) {
        return;
      }
      setRetrying(true);
      toast.show(`Retrying upload: ${file.fileName}`);
      try {
        const fresh = await fileRepository.getByIdAsync(file.id);
        if (!fresh) {
          await loadPage(true);
          return;
        }
        const outcome = await uploadAndPublishAsync(fresh);
        toast.show(
          outcome.queued ? `Upload queued: ${file.fileName}` : outcome.error ?? 'Upload failed.',
          outcome.queued ? undefined : { color: colors.error },
        );
      } catch (error) {
        toast.show(error instanceof Error ? error.message : String(error), { color: colors.error });
      } finally {
        setRetrying(false);
        await loadPage(true);
        await refreshSummary();
      }
    },
    [retrying, toast, colors.error, loadPage, refreshSummary],
  );

  const onShareSelected = useCallback(async () => {
    const selected = (files ?? []).filter((file) => selection.has(file.id));
    if (selected.length === 0) {
      return;
    }
    try {
      await Share.share({
        title: `Stash · ${selected.length} selected`,
        message: selected.map((file) => file.filePath).join('\n'),
      });
    } catch {
      toast.show('Sharing is not available on this platform.', { color: colors.error });
    }
  }, [files, selection, toast, colors.error]);

  const onRemoveSelected = useCallback(async () => {
    const ids = [...selection];
    try {
      const removed = await fileRepository.deleteManyAsync(ids);
      setSelection(new Set());
      toast.show(`${removed} item${removed === 1 ? '' : 's'} removed from Stash`);
      await loadPage(true);
      await refreshSummary();
    } catch (error) {
      toast.show(error instanceof Error ? error.message : String(error), { color: colors.error });
    }
  }, [selection, toast, colors.error, loadPage, refreshSummary]);

  const menuNeedsRetry =
    menuFile?.status === UploadStatus.Failed || menuFile?.status === UploadStatus.Retrying;
  const menuIsFavorite = menuFile ? isFavorite(favorites, menuFile) : false;

  const pending = summary?.pendingCount ?? 0;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View style={styles.titleRow}>
          <Text style={[styles.title, { color: colors.headline }]}>Stash</Text>
          {pending > 0 ? (
            <View style={[styles.pendingBadge, { backgroundColor: colors.primarySolid }]}>
              <Text style={styles.pendingBadgeLabel}>{pending}</Text>
            </View>
          ) : null}
        </View>
        <View style={styles.headerActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Search"
            hitSlop={8}
            onPress={() => {
              setSearchVisible((current) => !current);
              setSearchText('');
            }}
            style={({ pressed }) => [styles.iconButton, pressed ? styles.pressed : null]}
          >
            <Ionicons name="search" size={22} color={colors.text} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Notifications"
            hitSlop={8}
            onPress={() => navigation.navigate('Notifications')}
            style={({ pressed }) => [styles.iconButton, pressed ? styles.pressed : null]}
          >
            <Ionicons name="notifications-outline" size={22} color={colors.text} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Settings"
            hitSlop={8}
            onPress={() => navigation.navigate('Main', { screen: 'Settings' })}
            style={({ pressed }) => [styles.iconButton, pressed ? styles.pressed : null]}
          >
            <Ionicons name="settings-outline" size={22} color={colors.text} />
          </Pressable>
        </View>
      </View>

      <SyncBanner />

      {searchVisible ? (
        <TextInput
          value={searchText}
          onChangeText={setSearchText}
          placeholder="Search files"
          placeholderTextColor={colors.placeholder}
          selectionColor={colors.primarySolid}
          autoCapitalize="none"
          autoCorrect={false}
          style={[
            styles.searchInput,
            { color: colors.inputText, borderColor: colors.border, backgroundColor: colors.card },
          ]}
        />
      ) : null}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterBar}
        style={[styles.filterScroll, { borderBottomColor: colors.border }]}
      >
        {FILTERS.map((option) => {
          const active = filter === option.value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => setFilter(option.value)}
              style={({ pressed }) => [
                styles.filterChip,
                {
                  backgroundColor: active ? colors.primarySolid : colors.card,
                  borderColor: active ? colors.primarySolid : colors.border,
                },
                pressed ? styles.pressed : null,
              ]}
            >
              <Text style={[styles.filterLabel, { color: active ? '#FFFFFF' : colors.textMuted }]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {files === null ? (
        <EmptyState icon="images-outline" title="Loading…" subtitle="" />
      ) : files.length === 0 ? (
        <EmptyState
          icon="images-outline"
          title="No memories yet"
          subtitle="Add a folder to start backing up your photos and videos automatically."
          buttonLabel="Add Folder"
          onButtonPress={() => navigation.navigate('Main', { screen: 'Folders' })}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="filter-outline"
          title="Nothing matches"
          subtitle={
            filter === 'favorites'
              ? 'Open a file’s menu and choose “Add to favorites” to see it here.'
              : 'Try a different filter or search term.'
          }
        />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={keyExtractor}
          numColumns={NUM_COLUMNS}
          renderItem={renderItem}
          getItemLayout={getItemLayout}
          columnWrapperStyle={styles.gridRow}
          contentContainerStyle={styles.gridContent}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
          onEndReached={() => {
            if (hasMore) {
              void loadPage(false);
            }
          }}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            loadingMore ? (
              <ActivityIndicator style={styles.footer} color={colors.primarySolid} />
            ) : undefined
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primarySolid}
            />
          }
        />
      )}

      {selectionMode ? (
        <View
          style={[
            styles.selectionBar,
            { backgroundColor: colors.card, borderTopColor: colors.border },
          ]}
        >
          <Text style={[styles.selectionCount, { color: colors.text }]}>
            {selection.size} selected
          </Text>
          <View style={styles.selectionActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Share selected"
              onPress={() => void onShareSelected()}
              style={({ pressed }) => [styles.selectionAction, pressed ? styles.pressed : null]}
            >
              <Ionicons name="share-outline" size={18} color={colors.link} />
              <Text style={[styles.selectionActionLabel, { color: colors.link }]}>Share</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Remove selected"
              onPress={() => setConfirmRemove(true)}
              style={({ pressed }) => [styles.selectionAction, pressed ? styles.pressed : null]}
            >
              <Ionicons name="trash-outline" size={18} color={colors.error} />
              <Text style={[styles.selectionActionLabel, { color: colors.error }]}>Remove</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Done selecting"
              onPress={clearSelection}
              style={({ pressed }) => [
                styles.doneButton,
                { backgroundColor: colors.primarySolid },
                pressed ? styles.pressed : null,
              ]}
            >
              <Text style={styles.doneLabel}>Done</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add folder"
          onPress={() => navigation.navigate('Main', { screen: 'Folders' })}
          style={({ pressed }) => [
            styles.fab,
            { backgroundColor: colors.primarySolid },
            pressed ? styles.pressed : null,
          ]}
        >
          <Ionicons name="add" size={28} color="#FFFFFF" />
        </Pressable>
      )}

      <ActionDialog
        visible={menuFile !== null}
        title={menuFile?.fileName ?? ''}
        message={menuFile ? `${formatFileSize(menuFile.fileSize)} · ${menuFile.mimeType}` : ''}
        buttons={[
          { label: 'Details', onPress: () => setDetailsFile(menuFile) },
          {
            label: menuIsFavorite ? 'Remove from favorites' : 'Add to favorites',
            onPress: () => menuFile && void onToggleFavorite(menuFile),
          },
          ...(menuNeedsRetry && menuFile
            ? [{ label: 'Retry upload', onPress: () => void onRetry(menuFile) }]
            : []),
          {
            label: 'Remove from Stash',
            style: 'destructive' as const,
            onPress: () => {
              if (menuFile) {
                setSelection(new Set([menuFile.id]));
                setConfirmRemove(true);
              }
            },
          },
          { label: 'Close', style: 'cancel' as const },
        ]}
        onClose={() => setMenuFile(null)}
      />

      <ActionDialog
        visible={detailsFile !== null}
        title={detailsFile?.fileName ?? ''}
        message={
          detailsFile
            ? [
                `Path: ${detailsFile.filePath}`,
                `Size: ${formatFileSize(detailsFile.fileSize)}`,
                `Status: ${detailsFile.status}`,
                `MIME type: ${detailsFile.mimeType}`,
                `Content hash: ${detailsFile.contentHash}`,
                `Discovered: ${formatDate(detailsFile.discoveredAt)}`,
                ...(detailsFile.errorMessage ? [`Error: ${detailsFile.errorMessage}`] : []),
              ].join('\n')
            : ''
        }
        buttons={[{ label: 'Close', style: 'cancel' as const }]}
        onClose={() => setDetailsFile(null)}
      />

      <ActionDialog
        visible={confirmRemove}
        title={`Remove ${selection.size} item${selection.size === 1 ? '' : 's'}?`}
        message="This removes the record from Stash. Photos and videos on your device are not deleted."
        buttons={[
          {
            label: 'Remove',
            style: 'destructive' as const,
            onPress: () => void onRemoveSelected(),
          },
          { label: 'Cancel', style: 'cancel' as const },
        ]}
        onClose={() => setConfirmRemove(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontFamily: FONT_FAMILY,
    fontSize: 28,
  },
  pendingBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingBadgeLabel: {
    color: '#FFFFFF',
    fontFamily: FONT_FAMILY,
    fontSize: 11,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  iconButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.7,
  },
  searchInput: {
    marginHorizontal: 16,
    marginBottom: 8,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
  },
  filterScroll: {
    borderBottomWidth: 1,
    flexGrow: 0,
  },
  filterBar: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  filterChip: {
    minHeight: 32,
    paddingHorizontal: 14,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterLabel: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.small,
  },
  gridContent: {
    padding: GRID_PADDING,
    paddingBottom: 96,
  },
  gridRow: {
    justifyContent: 'space-between',
  },
  tileWrap: {
    width: '31.5%',
    marginBottom: 10,
  },
  footer: {
    paddingVertical: 16,
  },
  selectionBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    minHeight: 64,
    borderTopWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  selectionCount: {
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
  },
  selectionActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  selectionAction: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 48,
    gap: 2,
  },
  selectionActionLabel: {
    fontFamily: FONT_FAMILY,
    fontSize: 10,
  },
  doneButton: {
    minHeight: 40,
    borderRadius: 8,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneLabel: {
    color: '#FFFFFF',
    fontFamily: FONT_FAMILY,
    fontSize: fontSizes.body,
  },
  fab: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
});
