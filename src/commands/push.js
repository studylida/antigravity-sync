import { loadConfig } from '../config.js';
import { assertAntigravitySafe } from '../process.js';
import { exportToSyncDir } from '../storage.js';
import { isGitRepo, gitPull, gitCommitAndPush } from '../git.js';

export async function commandPush(options = {}) {
  const cfg = loadConfig();
  if (!cfg.configured) {
    console.log('⚠️  초기 설정이 필요합니다. 먼저 "agy-sync init"을 실행해주세요.');
    return;
  }

  // 1. Process check
  assertAntigravitySafe(options.force);

  console.log('🔄 로컬 대화 내역 내보내기 (Push) 준비 중...');

  // 2. If git, pull latest first to minimize conflicts
  if (isGitRepo(cfg.syncDir)) {
    try {
      console.log('📥 원격 저장소 최신 상태 확인 중 (Git Pull)...');
      gitPull(cfg.syncDir);
    } catch (err) {
      console.warn(`[Git Pull] 경고: ${err.message}`);
    }
  }

  // 3. Export to sync directory
  console.log(`📦 대화 인덱스 및 세션 데이터 내보내는 중 -> ${cfg.syncDir}`);
  const result = exportToSyncDir(cfg.antigravityDir, cfg.syncDir);
  console.log(`   - 대화 인덱스: ${result.indexCount}개`);
  console.log(`   - 세션 데이터베이스(.db): ${result.convCount}개`);
  console.log(`   - 에이전트 브레인 디렉터리: ${result.brainCount}개`);

  // 4. Git commit and push if applicable
  if (isGitRepo(cfg.syncDir)) {
    const commitMsg = options.message || `Sync antigravity sessions [${new Date().toISOString().replace('T', ' ').substring(0, 19)}]`;
    console.log(`🚀 Git 커밋 및 푸시 진행 중 ("${commitMsg}")...`);
    const gitRes = gitCommitAndPush(cfg.syncDir, commitMsg);
    if (gitRes.committed) {
      console.log('   ✅ Git 커밋 완료');
      if (gitRes.pushed) {
        console.log('   ✅ 원격 저장소 푸시 완료');
      } else {
        console.log('   ℹ️  원격 저장소가 설정되지 않았거나 로컬 커밋으로 저장되었습니다.');
      }
    } else {
      console.log('   ℹ️  변경된 내용이 없어 커밋을 건너뛰었습니다.');
    }
  }

  console.log('\n🎉 동기화 내보내기(Push)가 성공적으로 완료되었습니다!\n');
}
