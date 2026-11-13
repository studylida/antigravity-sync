# Changelog

All notable changes to `antigravity-sync` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (`MAJOR.MINOR.PATCH`).

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
