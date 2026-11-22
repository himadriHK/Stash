# Stash React Native — UI Gap Progress Tracker

Plan: [UI_GAP_PLAN.md](./UI_GAP_PLAN.md)
Started: 2026-11-22

Status legend: `Done` · `In progress` · `Planned` · `Deferred` · `Excluded`

---

## 1. Work items

| ID | Area | Item | Status | Files |
| --- | --- | --- | --- | --- |
| UI-01 | Services | Persisted UI preferences (auto-upload, backup videos, notifications seen) | Done | `src/services/uiPreferences.ts` |
| UI-02 | Services | Local favorites store keyed by content hash | Done | `src/services/favoritesStore.ts` |
| UI-03 | Data | `getSummaryAsync` + `getRecentActivityAsync` | Done | `src/data/fileRepository.ts` |
| UI-04 | Services | Notification feed derived from file rows | Done | `src/services/notificationFeed.ts` |
| UI-05 | Services | Scheduler `setEnabled` + App.tsx preference wiring | Done | `backgroundUploadScheduler.ts`, `App.tsx` |
| UI-06 | Services | Background pass honours Backup videos | Done | `backgroundUploadService.ts` |
| UI-07 | Utils | Relative timestamp formatter | Done | `src/utils/format.ts` |
| UI-08 | Navigation | Gallery tab + Notifications stack route | Done | `types.ts`, `MainTabs.tsx`, `RootNavigator.tsx` |
| UI-09 | Gallery | 3-column tile grid with status badges and video overlay | Done | `GalleryScreen.tsx`, `MediaTile.tsx` |
| UI-10 | Gallery | Header: pending badge, search, notifications bell, settings | Done | `GalleryScreen.tsx` |
| UI-11 | Gallery | Filter chips All/Photos/Videos/Favorites + search filtering | Done | `GalleryScreen.tsx` |
| UI-12 | Gallery | Selection mode, share, remove, done toolbar | Done | `GalleryScreen.tsx` |
| UI-13 | Gallery | Empty states, FAB, pull-to-refresh | Done | `GalleryScreen.tsx` |
| UI-14 | Notifications | Tabs All/Uploads/Errors/Synced | Done | `NotificationsScreen.tsx` |
| UI-15 | Notifications | Status items, unread dots, mark all read | Done | `NotificationsScreen.tsx` |
| UI-16 | Notifications | Details, retry failed upload, empty states | Done | `NotificationsScreen.tsx` |
| UI-17 | Settings | Backup Status stats + Sync now | Done | `SettingsScreen.tsx` |
| UI-18 | Settings | Preferences toggles (auto-upload, videos) | Done | `SettingsScreen.tsx` |
| UI-19 | Settings | About block (version/build) | Done | `SettingsScreen.tsx` |
| UI-20 | Folders | Add-folder pattern editor + subfolders | Done | `AddFolderDialog.tsx`, `FoldersScreen.tsx` |
| UI-21 | Folders | Folder details dialog (patterns, last scan, subfolder toggle) | Done | `FolderDetailsDialog.tsx`, `FoldersScreen.tsx` |
| UI-22 | Folders | Row metadata (last scan, pattern counts) | Done | `FolderRow.tsx` |
| UI-23 | Docs | README screens section update | Done | `README.md` |
| UI-24 | Verification | `npx tsc --noEmit` with no new errors | Done | — |

## 2. Deliberate exclusions

| ID | Item | Status | Reason |
| --- | --- | --- | --- |
| EX-01 | Mega.io status / email / delete-all-backups / storage-full item | Excluded | Retired MEGA backend; app uses S3-compatible storage |
| EX-02 | Thumbnail cache size / clear cache | Excluded | App has no thumbnail cache or generation pipeline |
| EX-03 | Login/Register logo, divider, legal footer | Deferred | No legal page URLs in repo; functional auth is complete |
| EX-04 | Wi-Fi-only upload preference | Deferred | Requires a network-info module not installed in this build |
| EX-05 | Thumbnail quality preference | Deferred | No thumbnail generation pipeline |
| EX-06 | Debug logging preference | Deferred | Error logger has no level switch |
| EX-07 | Reset database button | Deferred | Needs migration-aware reset and double confirmation UX |
| EX-08 | Persistent notification inbox + folder-add events | Deferred | Would require new tables; feed derives from file rows |

## 3. Verification log

| Date | Check | Result |
| --- | --- | --- |
| 2026-11-22 | `npx tsc --noEmit` | Passed — no type errors |
| 2026-11-22 | Code inspection of all 24 items | Passed — see notes below |
| 2026-11-22 | `npx expo export --platform web` | Not run (by plan; typecheck + review is the gate) |

**Inspection notes**

- `uiPreferences.ts` — `getUiPreferencesAsync`, `setAutoUploadAsync`,
  `setBackupVideosAsync`, `markNotificationsSeenAsync` present; keys in `utils/storage`.
- `favoritesStore.ts` — `loadFavoritesAsync`, `toggleFavoriteAsync`, `isFavorite`.
- `fileRepository.ts` — `getSummaryAsync`, `getRecentActivityAsync`, `getPageAsync`.
- `backgroundUploadScheduler.ts` — `setEnabled`; `App.tsx` applies `autoUpload` after auth
  and re-schedules on enable.
- `backgroundUploadService.ts` — skips `video/*` when `backupVideos` is off.
- `GalleryScreen.tsx` — 3-column `FlatList`, infinite scroll, pull-to-refresh runs
  `runOnceAsync`, header pending badge/search/bell/settings, filter chips + search,
  selection mode with share/remove/done, FAB hidden while selecting, empty states.
- `NotificationsScreen.tsx` — All/Uploads/Errors/Synced tabs, unread dots vs
  `notificationsSeenAt`, mark-all-read, retry for failed, per-tab empty states.
- `SettingsScreen.tsx` — Backup Status stat cards, storage status row, Sync now,
  Auto-upload/Backup videos switches, About version/build.
- Folders — `AddFolderDialog` include/exclude patterns + subfolders; `FolderDetailsDialog`
  with last scan, patterns, subfolder switch, Scan now, Delete; `FolderRow` last-scan meta.

## 4. Change log

| Date | Update |
| --- | --- |
| 2026-11-22 | Plan and tracker created; implementation not started. |
| 2026-11-22 | UI-01 … UI-24 implemented and verified; `npx tsc --noEmit` clean. Exclusions unchanged (EX-01 … EX-08 remain as documented). |
