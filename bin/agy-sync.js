#!/usr/bin/env node

import { commandInit } from '../src/commands/init.js';
import { commandPush } from '../src/commands/push.js';
import { commandPull } from '../src/commands/pull.js';
import { commandStatus } from '../src/commands/status.js';
import { commandRestore } from '../src/commands/restore.js';

const args = process.argv.slice(2);
const command = args[0] || 'help';

function printHelp() {
  console.log(`
Antigravity Sync (agy-sync) - v1.0.0
Multi-device conversation backup and synchronization for Google Antigravity.

Usage:
  agy-sync <command> [options]
  npx antigravity-sync <command> [options]

Commands:
  init                     Interactive setup for sync directory and storage
  push [options]           Export local conversations and push to sync repository
  pull [options]           Pull conversations from sync repository and merge locally
  status                   Show sync status and diff between local and remote
  restore [snapshot]       Restore local state from an emergency backup snapshot
  help                     Show this help message

Options for push:
  -m, --message <msg>      Custom commit message for Git push
  --force                  Bypass Antigravity running process check

Options for pull / restore:
  --force                  Bypass Antigravity running process check

Examples:
  npx antigravity-sync init
  npx antigravity-sync push -m "Finish 3D graph refactor"
  npx antigravity-sync pull
  npx antigravity-sync status
`);
}

function parseOptions(argList) {
  const options = { force: false, message: '' };
  for (let i = 0; i < argList.length; i++) {
    if (argList[i] === '--force') {
      options.force = true;
    } else if (argList[i] === '-m' || argList[i] === '--message') {
      options.message = argList[i + 1] || '';
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
        console.log('antigravity-sync v1.0.0');
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
