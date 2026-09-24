import { loadConfig } from '../config.js';
import { assertAntigravitySafe } from '../process.js';
import { listSnapshots } from '../storage.js';
import fs from 'node:fs';
import path from 'node:path';

export async function commandRestore(snapshotName = '', options = {}) {
  const cfg = loadConfig();
  assertAntigravitySafe(options.force);

  const snapshots = listSnapshots(cfg.backupDir);
  if (snapshots.length === 0) {
    console.log('⚠️  복원 가능한 백업 스냅샷이 존재하지 않습니다.');
    return;
  }

  let targetSnapshot = snapshots[0];
  if (snapshotName) {
    const found = snapshots.find(s => s.name === snapshotName || s.name.includes(snapshotName));
    if (!found) {
      console.log(`⚠️  지정한 스냅샷 "${snapshotName}"을(를) 찾을 수 없습니다.`);
      console.log('사용 가능한 스냅샷 목록:');
      for (const s of snapshots) {
        console.log(`  - ${s.name} (${s.createdAt})`);
      }
      return;
    }
    targetSnapshot = found;
  }

  console.log(`🔄 스냅샷 복원 시작: ${targetSnapshot.name} (${targetSnapshot.createdAt})`);

  // Restore conversation_summaries.db
  const snapSummary = path.join(targetSnapshot.path, 'conversation_summaries.db');
  const targetSummary = path.join(cfg.antigravityDir, 'conversation_summaries.db');
  if (fs.existsSync(snapSummary)) {
    fs.copyFileSync(snapSummary, targetSummary);
    console.log('   ✅ conversation_summaries.db 복원 완료');
  }

  // Restore conversations directory
  const snapConvDir = path.join(targetSnapshot.path, 'conversations');
  const targetConvDir = path.join(cfg.antigravityDir, 'conversations');
  if (fs.existsSync(snapConvDir)) {
    fs.mkdirSync(targetConvDir, { recursive: true });
    for (const f of fs.readdirSync(snapConvDir)) {
      fs.copyFileSync(path.join(snapConvDir, f), path.join(targetConvDir, f));
    }
    console.log('   ✅ conversations/*.db 세션 복원 완료');
  }

  console.log('\n🎉 스냅샷 복원이 안전하게 완료되었습니다!\n');
}
