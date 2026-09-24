import { loadConfig } from '../config.js';
import { assertAntigravitySafe } from '../process.js';
import { createSnapshot, importFromSyncDir } from '../storage.js';
import { isGitRepo, gitPull } from '../git.js';

export async function commandPull(options = {}) {
  const cfg = loadConfig();
  if (!cfg.configured) {
    console.log('⚠️  초기 설정이 필요합니다. 먼저 "agy-sync init"을 실행해주세요.');
    return;
  }

  // 1. Process check
  assertAntigravitySafe(options.force);

  console.log('🔄 원격 저장소 대화 내역 가져오기 (Pull) 시작...');

  // 2. Create emergency backup snapshot
  console.log('💾 작업 전 로컬 상태를 안전하게 자동 백업합니다...');
  const snapshotPath = createSnapshot(cfg.antigravityDir, cfg.backupDir);
  console.log(`   ✅ 백업 스냅샷 생성 완료: ${snapshotPath}`);

  // 3. Git pull if applicable
  if (isGitRepo(cfg.syncDir)) {
    console.log('📥 원격 저장소 최신 데이터 가져오는 중 (Git Pull)...');
    try {
      const pullRes = gitPull(cfg.syncDir);
      if (pullRes.pulled) {
        console.log('   ✅ Git Pull 성공');
      } else {
        console.log(`   ℹ️  Git 상태: ${pullRes.reason || 'up to date'}`);
      }
    } catch (err) {
      console.warn(`   ⚠️  Git Pull 경고: ${err.message}`);
    }
  }

  // 4. Import & Merge
  console.log('🔄 로컬 대화 데이터와 병합(Merge) 수행 중...');
  const result = importFromSyncDir(cfg.syncDir, cfg.antigravityDir);

  console.log('\n📊 병합 결과 보고서:');
  console.log(`   - 신규 대화 추가: ${result.mergeStats.added}개`);
  console.log(`   - 기존 대화 갱신: ${result.mergeStats.updated}개`);
  console.log(`   - 유지된 대화(최신): ${result.mergeStats.skipped}개`);
  console.log(`   - 동기화된 세션 DB(.db): ${result.copiedDbCount}개`);
  console.log(`   - 동기화된 에이전트 브레인: ${result.copiedBrainCount}개`);

  console.log('\n🎉 동기화 가져오기(Pull)가 완료되었습니다! 이제 Antigravity를 실행하셔도 좋습니다.\n');
}
