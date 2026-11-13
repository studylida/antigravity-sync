import { loadConfig } from '../config.js';
import { assertAntigravitySafe } from '../process.js';
import { listSnapshots, restoreSnapshot } from '../storage.js';

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
  const res = restoreSnapshot(targetSnapshot.path, cfg);

  if (res.desktop.summary || res.desktop.dbs > 0) {
    console.log(`   ✅ [Desktop] 인덱스: ${res.desktop.summary ? 'O' : 'X'}, 세션 DB: ${res.desktop.dbs}개 복원`);
  }
  if (res.cli.summary || res.cli.dbs > 0 || res.cli.extras > 0) {
    console.log(`   ✅ [CLI]     인덱스: ${res.cli.summary ? 'O' : 'X'}, 세션 DB: ${res.cli.dbs}개, 설정/캐시: ${res.cli.extras}개 복원`);
  }
  if (res.projects > 0 || res.mcpRestored) {
    console.log(`   ✅ [Config]  프로젝트: ${res.projects}개, MCP 설정: ${res.mcpRestored ? 'O' : 'X'} 복원`);
  }

  console.log('\n🎉 스냅샷 복원이 안전하게 완료되었습니다!\n');
}
