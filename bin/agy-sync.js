#!/usr/bin/env node

import { commandInit } from '../src/commands/init.js';
import { commandPush } from '../src/commands/push.js';
import { commandPull } from '../src/commands/pull.js';
import { commandBridge } from '../src/commands/bridge.js';
import { commandStatus } from '../src/commands/status.js';
import { commandRestore } from '../src/commands/restore.js';
import { TOOL_VERSION } from '../src/version.js';

const args = process.argv.slice(2);
const command = args[0] || 'help';

function printHelp() {
  console.log(`
Antigravity Sync (agy-sync) - v${TOOL_VERSION}
Multi-device sync, backup, and local Desktop <-> CLI bridge for Google Antigravity.

Usage:
  agy-sync <command> [options]
  npx antigravity-sync <command> [options]

Commands:
  init                     Interactive setup for Desktop, CLI, Config, and sync storage
  bridge [options]         Bridge conversations locally between Desktop and CLI (agy)
  push [options]           Export Desktop, CLI, and Config state and push to sync repo
  pull [options]           Pull from sync repo and merge into local Desktop, CLI, and Config
  status                   Show process status, local bridge diff, and remote sync diff
  restore [snapshot]       Restore local state from an emergency backup snapshot
  help                     Show this help message

Options for push / pull:
  --target <name>          Sync target: all (default), desktop, cli, or config
  -m, --message <msg>      Custom commit message for Git push (push only)
  --auto-yes               Auto-confirm project locator prompts (pull only)
  --force                  Bypass running Antigravity Desktop / CLI process check

Options for bridge:
  --direction <dir>        Bridge direction: both (default), cli-to-desktop, or desktop-to-cli
  --dry-run                Preview bridge diff without modifying files
  --force                  Bypass running Antigravity Desktop / CLI process check

Options for restore:
  --force                  Bypass running Antigravity Desktop / CLI process check

Examples:
  agy-sync init
  agy-sync bridge --dry-run
  agy-sync bridge --direction cli-to-desktop
  agy-sync push -m "Sync desktop and cli sessions"
  agy-sync pull --target cli
  agy-sync status
`);
}

function parseOptions(argList) {
  const options = {
    force: false,
    message: '',
    target: 'all',
    direction: 'both',
    dryRun: false,
    autoYes: false
  };
  for (let i = 0; i < argList.length; i++) {
    const arg = argList[i];
    if (arg === '--force') {
      options.force = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--auto-yes' || arg === '-y') {
      options.autoYes = true;
    } else if (arg === '-m' || arg === '--message') {
      options.message = argList[i + 1] || '';
      i++;
    } else if (arg === '--target' || arg === '-t') {
      options.target = argList[i + 1] || 'all';
      i++;
    } else if (arg === '--direction' || arg === '-d') {
      options.direction = argList[i + 1] || 'both';
      i++;
    }
  }
  return options;
}

async function main() {
  try {
    switch (command) {
      case 'init':
        await commandInit();
        break;

      case 'bridge': {
        const options = parseOptions(args.slice(1));
        await commandBridge(options);
        break;
      }

      case 'push': {
        const options = parseOptions(args.slice(1));
        await commandPush(options);
        break;
      }

      case 'pull': {
        const options = parseOptions(args.slice(1));
        await commandPull(options);
        break;
      }

      case 'status':
        await commandStatus();
        break;

      case 'restore': {
        const snapshotName = args[1] && !args[1].startsWith('-') ? args[1] : '';
        const options = parseOptions(args.slice(1));
        await commandRestore(snapshotName, options);
        break;
      }

      case '-v':
      case '--version':
        console.log(`antigravity-sync v${TOOL_VERSION}`);
        break;

      case 'help':
      case '--help':
      case '-h':
      default:
        printHelp();
        break;
    }
  } catch (err) {
    console.error(`\n❌ [오류] ${err.message}\n`);
    if (process.env.DEBUG) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

main();
