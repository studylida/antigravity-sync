# Changelog

All notable changes to `antigravity-sync` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (`MAJOR.MINOR.PATCH`).

## [2.2.1] - 2026-11-16

### Fixed
- **Non-Destructive Union Merge on `push`**: `exportToSyncDir` now merges `conversations_index.json`, CLI `settings.json` (`trustedWorkspaces`), `last_conversations.json`, and `mcp_config.json` with existing sync repository state so unpulled remote conversations and settings from another PC are never overwritten.
- **Timestamp-Driven Artifact Sync (Git `mtime` Fix)**: `push` and `pull` select `.db`, `brain/`, and `annotations/` files using conversation index timestamps (`last_modified_time` / `step_count`) and SHA-256 content hashes rather than Git checkout timestamps, while refusing to overwrite strictly newer conversation DBs.
- **Smart Project Locator Path Propagation**: `importFromSyncDir` now resolves shared `config/projects/*.json` paths first and passes discovered project path mappings (including encoded `file:///c%3A/...` URIs) into Desktop and CLI conversation/brain imports.
- **`metadata_guard.json` & CLI Cache Safety in `push`/`pull`**: `push` heals local metadata from `metadata_guard.json` before exporting and shares the guard ledger in `sync-data/`; `pull` prevents Desktop-project `.db` injection into `cli/conversations/`, keeps `app_data_dir: 'antigravity'` clean, and updates CLI `cache/conversation_metadata.json`.
- **Git Conflict & Push Resilience + `status` Freshness Diff**: Clears stuck merge/rebase states, recovers from `sync-data` rebase/non-fast-forward conflicts cleanly by re-merging local data onto `origin`, pushes ahead offline commits even with clean working trees, and shows updated conversation counts in `agy-sync status`.

## [2.2.0] - 2026-11-16

### Added
- **Background Auto-Bridge Watcher (`agy-sync watch`)**: Monitors Desktop (`Antigravity.exe`) and CLI (`agy.exe`) lifecycle and DB fingerprints, automatically running `bridge` once both clients have exited (`--daemon`, `--stop`, `--status`, `--interval`, plus `--install` / `--uninstall`).
- **Self-Healing Metadata Guard Ledger (`~/.antigravity-sync/metadata_guard.json`)**: Records verified conversation titles, `desktopSource`, and `desktopProjectId`, automatically repairing overwritten titles, `source`, `project_id`, `annotations/*.pbtxt`, and proto caches before/during `bridge`.

## [2.1.8] - 2026-11-16

### Fixed
- **Protobuf Field 17 Patch & CLI Round-Trip Protection**: Patch `project_id` inside existing `raw_summary` field 17 (`sub 18`), protect CLI round-trip sessions in `cliToDesktop`, and reset cleaned CLI `app_data_dir` entries back to `'antigravity'`.

## [2.1.7] - 2026-11-16

### Fixed
- **Safe Duplicate Cleanup Ordering**: Remove CLI-created duplicate Desktop `.db` files only after `cliToDesktop` rescues newer CLI turns.

## [2.1.6] - 2026-11-16

### Fixed
- **Desktop Sidebar Visibility Mapping**: Map bridged CLI conversations (`source: ''`) to matching Desktop workspace project UUIDs or `outside-of-project` (Playground) so they appear in the Desktop sidebar.

## [2.1.5] - 2026-11-16

### Fixed
- **Missing Artifact Backfill & CLI Metadata Cache**: Copy missing CLI conversation `.db`/`brain/` artifacts to Desktop and synchronize CLI `cache/conversation_metadata.json`.

## [2.1.4] - 2026-11-16

### Fixed
- **Title Protection & Annotations Bridge**: Preserve non-empty titles against empty-title overwrites on merge/bridge, clean poisoned CLI DB duplicates, and synchronize `annotations/*.pbtxt` during `bridge`.

## [2.1.3] - 2026-11-16

### Fixed
- **Prevented Desktop `additionalDirs` DB Collision & Hardened Sync**: Stopped copying Desktop-native `.db` files into `~/.gemini/antigravity-cli/conversations/`, hardened WAL read safety, improved Git pull/push resilience (dynamic default branch & unborn `HEAD`), blocked integrated-terminal self-termination, and added strict `--flag=value`/`--target` CLI validation.

## [2.1.2] - 2026-11-16

### Fixed
- **Proto Field Patching & Self-Contained Tests**: Patch `raw_summary` protobuf fields during import/sync and isolate all unit test suites inside temporary sandboxes.

## [2.1.1] - 2026-11-13

### Fixed
- **Bridge Copy, WAL Checkpointing & Proto Cache**: Enable selective newer-timestamp `bridge` copy, SQLite WAL checkpointing before reads/closes, and initial `raw_summary` protobuf cache sync.

## [2.1.0] - 2026-11-13

### Added
- **Automatic GitHub Repo Setup in `init`**: Automatically create and link a private GitHub sync repository (`antigravity-sync-data`) via `gh` when authenticated.

## [2.0.2] - 2026-11-13

### Fixed
- **Git Sync Hygiene**: Avoid nested `.git` directories inside `sync-data/`, suppress CRLF warnings via `.gitattributes` (`* -text`), and raise `git push` `maxBuffer` limits.

## [2.0.1] - 2026-11-13

### Fixed
- **Process Safety**: Automatically stop running Antigravity Desktop and `agy` CLI processes before sync commands when not using `--force`.

## [2.0.0] - 2026-11-13

### Breaking Changes
- **Sync Repository Layout (`schemaVersion: 2`)**: Redesigned `sync-data/` into separated client/domain directories (`manifest.json`, `desktop/`, `cli/`, `config/`) instead of flat root folders. Legacy v1 repositories are still automatically readable during `pull` and upgraded on the next `push`.
- **Configuration Schema (`configVersion: 2`)**: `~/.antigravity-sync/config.json` now tracks `desktopDir`, `cliDir`, `geminiConfigDir`, `projectsDir`, and `targets` (`desktop`, `cli`, `config`). Existing v1 configs are auto-migrated in memory on load.

### Added
- **Local Desktop ↔ CLI Bridge (`agy-sync bridge`)**: Bidirectional local union merge between Antigravity Desktop (`~/.gemini/antigravity`) and Antigravity CLI (`~/.gemini/antigravity-cli`), preserving native `app_data_dir` and `source` conventions (`CORTEX_TRAJECTORY_SOURCE_CLI` vs `antigravity-cli`), plus `--direction` and `--dry-run`.
- **Antigravity CLI (`agy`) Multi-PC Sync**: Exports and merges CLI `conversation_summaries.db` (including `conversation_parents` for `/fork` trees), `conversations/*.db`, `brain/`, `settings.json` (union-merging `trustedWorkspaces`), and `cache/last_conversations.json`.
- **Shared Config Sync (`config/`)**: Syncs `~/.gemini/config/projects/*.json` (with Smart Project Locator) and `~/.gemini/config/mcp_config.json` (non-destructive `mcpServers` merge).
- **Dual Process Guard**: Detects both `Antigravity` Desktop and `agy` CLI processes to prevent SQLite WAL/lock corruption.
- **Target Filtering (`--target`)**: `push` and `pull` now support `--target all|desktop|cli|config`.
- **Unified SemVer Versioning**: Added `src/version.js` so CLI `--version`, help output, and `manifest.json` read directly from `package.json`, along with `npm run version:patch|minor|major` scripts.

## [1.0.0] - 2026-10-01

### Added
- Initial release supporting Antigravity Desktop conversation & brain sync across machines (`init`, `push`, `pull`, `status`, `restore`), `{{USER_HOME}}` path virtualization, Smart Project Locator, and pre-sync snapshot rollback.
