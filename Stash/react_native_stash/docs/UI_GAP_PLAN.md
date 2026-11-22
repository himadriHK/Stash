# Stash React Native — UI Gap Plan

**Created:** 2026-11-22
**Scope:** Bring the React Native (Expo) client's UI up to the reviewed HTML mockups in
`../Design/Mockups/`, adding the screens and elements the app is missing and excluding
everything that describes the retired MEGA storage setup.
**Tracker:** [UI_GAP_PROGRESS.md](./UI_GAP_PROGRESS.md)

---

## 1. Sources of truth

| Source | Use |
| --- | --- |
| `../Design/Mockups/01-login.html` | Login screen reference |
| `../Design/Mockups/02-gallery.html` | **Gallery screen reference (missing)** |
| `../Design/Mockups/03-settings.html` | Settings sections and rows |
| `../Design/Mockups/04-folders.html` | Folder list, add-folder form, folder details |
| `../Design/Mockups/05-notifications.html` | **Notification Center reference (missing)** |
| `../Design/Mockups/06-register.html` | Register screen reference |
| `../Design/STASH_DESIGN_SYSTEM.md` | Specs for 9.1–9.5 (gallery, settings, folders, notifications) |
| `src/theme/colors.ts`, `src/theme/typography.ts` | App's actual design tokens |
| `docs/ARCHITECTURE.md`, `docs/IMPLEMENTATION_PLAN.md` | Data model and service contracts |

The mockups use a blue palette, Inter, and Lucide icons. This app intentionally keeps its
existing MAUI-derived identity — `#512BD4` primary, Open Sans, Ionicons, light/dark themes —
so every new screen is built from the app's existing tokens and components rather than
copying the mockup CSS. Structure, information architecture and interactions follow the
mockups; colour/typography follow the app.

---

## 2. Current state vs. mockups

### 2.1 Screen-level gaps

| Mockup screen | RN today | Gap |
| --- | --- | --- |
| 01 Login | `LoginScreen` (email, password, device ID, sign in, create account) | No logo mark, no "or" divider, no legal footer. Minor polish, legal copy has no destination in this repo. |
| 02 Gallery | **Does not exist.** `FilesScreen` is a paginated status list, not a media grid. | Entire screen missing: grid, filters, search, selection, share/delete, sync badge, notification entry point. |
| 03 Settings | `SettingsScreen` (appearance, account, configuration, diagnostics) | Missing Backup Status stats + Sync now, Preferences toggles, About block. Mega rows must be excluded. |
| 04 Folders | `FoldersScreen` + `FolderRow` + `AddFolderDialog` | Missing folder details (last scanned, patterns, subfolder toggle); add form has no include/exclude pattern editor or subfolder choice. |
| 05 Notifications | **Does not exist.** | Entire screen missing: tabs, per-status items, unread state, retry, mark-all-read. |
| 06 Register | `RegisterScreen` (email, password, confirm, device ID) | Same minor auth polish as Login. |

### 2.2 Element-level gaps

**Gallery (mockup 9.2)**

- 3-column square thumbnail grid (5–7 columns on wider screens).
- Status badge per tile (Synced / Uploading / Failed / Pending) with status colour.
- Video play overlay.
- Filter chips: All / Photos / Videos / Favorites.
- Search (header icon → search field filtering by file name).
- Pending-sync badge in the header.
- Selection mode: long press starts, tap toggles, check overlay, bottom action bar
  with count, Share, Remove and Done; FAB hidden while selecting.
- Empty state with "Add Folder" CTA; filtered-empty variant.
- FAB to add a folder; pull-to-refresh runs the background pass.
- Notification entry point (bell) → Notification Center.

**Settings (mockup 9.3)**

- Backup Status: Total files, Total size, Pending upload, Last sync stat cards; storage
  provider status row; **Sync now** action.
- Preferences: Auto-upload and Backup videos toggles.
- About: app version and build line.
- Excluded: Email row (the auth model exposes user/device IDs only), Mega.io status,
  Mega.io email, "Delete all backups (Mega.io)", thumbnail-cache rows.

**Folders (mockup 9.4)**

- Row metadata: last scanned, include/exclude counts, subfolder behaviour.
- Folder details dialog: path, enabled state, last scanned, include patterns, exclude
  patterns, include-subfolders switch, Scan now, Delete.
- Add-folder form: include patterns, exclude patterns, include subfolders.

**Notifications (mockup 9.5)**

- Tabs: All / Uploads / Errors / Synced.
- Item icon + title + subtitle + relative time, colour by status.
- Unread dot for items newer than the last "mark all read" timestamp.
- Tap failed → retry upload; tap any item → details.
- Empty state per tab.
- Mark all read (mockup's "Clear all", expressed as read-state rather than destructive
  deletion of the local audit trail).

---

## 3. Excluded MEGA items

These mockup elements describe the retired MEGA backend and are deliberately **not**
implemented:

| Element | Reason |
| --- | --- |
| Settings → Backup Status → "Mega.io Status: Connected" | Storage is S3-compatible (`Storage.Provider=S3`); no Mega client exists. |
| Settings → Storage → "Mega.io Email" | No Mega account is linked. |
| Settings → Danger Zone → "Delete all backups (Mega.io)" | Would call `MegaStorageProvider.DeleteFileAsync`; no equivalent, and remote bulk deletion is out of scope. |
| Notifications mock item "Storage Full — Mega.io nearly at capacity" | Placeholder mock data tied to Mega. |
| Mock copy that says "Built with .NET 10 MAUI" in About | This client is React Native/Expo. |

The S3 configuration already shown under Settings → Configuration is kept as the storage
truth; the new Backup Status section shows provider/bucket readiness instead.

---

## 4. Implementation plan

### 4.1 New data/services (small, additive)

1. **`src/services/uiPreferences.ts`** — persisted UI preferences in the existing
   `utils/storage` (SecureStore native / localStorage web):
   - `autoUpload` (default `appConfig.BackgroundUpload.Enabled`)
   - `backupVideos` (default true)
   - `notificationsSeenAt` (ISO timestamp, default epoch)
   Exposes `getUiPreferencesAsync`, `setAutoUploadAsync`, `setBackupVideosAsync`,
   `markNotificationsSeenAsync`.
2. **`src/services/favoritesStore.ts`** — local favorite set keyed by `contentHash`
   (JSON array in `utils/storage`), with an in-memory cache and `toggleFavoriteAsync`.
   Favorites are a client-side view; SQLite schema is unchanged.
3. **`src/services/notificationFeed.ts`** — derives notification items from recent file
   rows (`fileRepository.getRecentActivityAsync`) with a stable status→kind mapping.
   No new tables, no synthetic mock data.
4. **`src/data/fileRepository.ts`** — two additive read queries:
   - `getSummaryAsync()` → total files, total bytes, pending count, latest activity.
   - `getRecentActivityAsync(limit)` → newest rows for the notification feed.
5. **`src/services/backgroundUploadScheduler.ts`** — add `setEnabled(boolean)` so the
   Auto-upload preference can start/stop the pass immediately.
6. **`src/services/backgroundUploadService.ts`** — skip `video/*` candidates when
   `backupVideos` is off (manual uploads are unaffected).
7. **`src/utils/format.ts`** — `formatRelativeTime` for notification timestamps.

### 4.2 Navigation

- `MainTabParamList` gains `Gallery`; `RootStackParamList` gains `Notifications`.
- `MainTabs` gets Gallery as the **first** tab (grid icon), keeping Files, Upload, Folders,
  Settings and About unchanged.
- `Notifications` is a native-stack screen (header with back), reachable from the Gallery
  bell. It is registered inside the authenticated branch only.

### 4.3 Gallery screen

`src/screens/GalleryScreen.tsx` + `src/components/MediaTile.tsx`.

- Loads pages of 60 via `fileRepository.getPageAsync`, infinite scroll, pull-to-refresh
  runs `backgroundUploadService.runOnceAsync()` then reloads.
- Header: "Stash", pending badge (`getSummaryAsync().pendingCount`), search toggle,
  notifications bell, settings gear.
- Filter chips (All / Photos / Videos / Favorites) and a search field.
- `FlatList` with `numColumns={3}`, square tiles, image source preference:
  first thumbnail variant → local `filePath` for images; videos get a play overlay;
  failed loads fall back to an icon tile.
- Tap: in selection mode toggles; otherwise opens an action dialog
  (Details / Add or remove favorite / Retry for failed / Remove).
- Long press enters selection; bottom bar with count, Share (`Share.share`),
  Remove (confirmation; removes the Stash record, never the device file) and Done.
  FAB opens Folders; FAB is hidden during selection.
- Empty states: no media at all (Add Folder CTA) and no match for the active filter.

### 4.4 Notification Center

`src/screens/NotificationsScreen.tsx`.

- Loads `getRecentActivityAsync(100)` on focus/pull-to-refresh.
- Tabs filter by kind: Uploads (uploading/uploaded/processing/pending), Errors (failed),
  Synced (completed/deduplicated).
- Unread dots compare item timestamps with the persisted `notificationsSeenAt`;
  "Mark all read" writes the current time.
- Press → details dialog, with Retry upload for failed items.
- Per-tab empty states; no Mega "storage full" mock entry.

### 4.5 Settings additions

`src/screens/SettingsScreen.tsx`.

- **Backup Status** (after Account): four stat cards from `getSummaryAsync` — total files,
  total size, pending uploads, last sync — plus S3 readiness row and **Sync now**.
- **Preferences**: Auto-upload switch (persists + scheduler `setEnabled`), Backup videos
  switch (persists; background pass honours it). A caption states that Wi-Fi-only and
  thumbnail-quality options from the mockup are not part of this build (no network module
  / no thumbnail pipeline).
- **About**: app name, version (app.json), build (expo-application when available),
  framework line. Existing About tab stays.
- Existing Configuration/Diagnostics content is preserved. Mega rows are not added.
- Destructive "Reset database" is **deferred** (needs migration-aware reset + backup UX)
  and documented rather than implemented as a half-safe button.

### 4.6 Folders additions

- `AddFolderDialog`: include-pattern field (prefilled with the 14 defaults), exclude-pattern
  field, include-subfolders switch; `onAdd` receives `{ includePatterns, excludePatterns,
  includeSubfolders }`.
- `FoldersScreen`: persists those options through `createFolderConfig`; opens a new
  `FolderDetailsDialog` instead of the plain action sheet, keeping Scan now / Delete.
- `FolderDetailsDialog`: path, enabled, last scanned, include/exclude pattern lists,
  include-subfolders switch (persists immediately), Scan now, Delete, Close.
- `FolderRow`: adds last-scanned line and include/exclude/subfolder meta line.

### 4.7 Auth screens

Mockup logo/divider/legal-footer polish is **deferred**: the app already has the complete
functional form, and the mockup's Terms/Privacy links have no URLs or pages in this
repository. Adding non-navigating legal links would be worse than omitting them. This is
recorded in the tracker as a deliberate exclusion, not an oversight.

---

## 5. File inventory

### New

| File | Purpose |
| --- | --- |
| `src/screens/GalleryScreen.tsx` | Gallery grid screen |
| `src/screens/NotificationsScreen.tsx` | Notification Center |
| `src/components/MediaTile.tsx` | Square thumbnail/status tile |
| `src/components/FolderDetailsDialog.tsx` | Folder detail sheet |
| `src/services/uiPreferences.ts` | Persisted UI preferences |
| `src/services/favoritesStore.ts` | Local favorites |
| `src/services/notificationFeed.ts` | File rows → notifications |

### Modified

| File | Change |
| --- | --- |
| `src/navigation/types.ts` | Gallery tab, Notifications stack route |
| `src/navigation/MainTabs.tsx` | Gallery tab |
| `src/navigation/RootNavigator.tsx` | Notifications screen |
| `App.tsx` | Apply Auto-upload preference at auth |
| `src/data/fileRepository.ts` | Summary + recent activity queries |
| `src/services/backgroundUploadScheduler.ts` | `setEnabled` |
| `src/services/backgroundUploadService.ts` | Video preference filter |
| `src/screens/SettingsScreen.tsx` | Backup status, preferences, about |
| `src/screens/FoldersScreen.tsx` | Details dialog, add options |
| `src/components/AddFolderDialog.tsx` | Pattern editor, subfolders |
| `src/components/FolderRow.tsx` | Last scan, patterns/subfolder meta |
| `src/utils/format.ts` | Relative time |
| `README.md` | Screens list |

---

## 6. Verification

- `npx tsc --noEmit` (project typecheck) must pass with no new errors.
- `npx expo export --platform web` is **not** run by default (slow); typecheck plus a
  focused review of the changed screens is the acceptance gate for this pass.
- Manual checks the user can perform: open Gallery, switch filters, long-press to select,
  open Notifications from the bell, toggle preferences, open folder details.
- Not verified in this pass: native photo rendering on device, share sheet behaviour on
  iOS/Android, visual appearance in light/dark on a physical device.

## 7. Risks and constraints

- Thumbnails are not generated by the app; tiles use the stored thumbnail map or the local
  file URI and fall back to an icon. Video frames are never decoded.
- Favorites live in secure storage, not SQLite, so they are per-install and not synced.
- Notification items are derived from current file rows, so the list reflects the latest
  100 files rather than a persistent inbox. Folder-add events are not included (no folder
  event log exists).
- Removing a gallery item deletes the Stash record only. The on-device media file and any
  uploaded object are untouched; this is stated in the confirmation copy.
