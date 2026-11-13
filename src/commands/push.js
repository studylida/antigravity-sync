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

  const target = options.target || 'all';
  assertAntigravitySafe(options.force, {
    desktop: target === 'all' || target === 'desktop',
    cli: target === 'all' || target === 'cli'
  });

  console.log(`🔄 로컬 Antigravity 데이터 내보내기 (Push, 대상: ${target}) 준비 중...`);

  if (isGitRepo(cfg.syncDir)) {
    try {
      console.log('📥 원격 저장소 최신 상태 확인 중 (Git Pull)...');
      gitPull(cfg.syncDir);
    } catch (err) {
      console.warn(`[Git Pull] 경고: ${err.message}`);
    }
  }

  console.log(`📦 저장소로 내보내는 중 -> ${cfg.syncDir}`);
  const result = exportToSyncDir(cfg, { target });

  if (result.desktop.present) {
    console.log(`   [Desktop] 인덱스: ${result.desktop.indexCount}개 | DB: ${result.desktop.convCount}개 | 브레인: ${result.desktop.brainCount}개`);
  }
  if (result.cli.present) {
    console.log(`   [CLI]     인덱스: ${result.cli.indexCount}개 | DB: ${result.cli.convCount}개 | 브레인: ${result.cli.brainCount}개 | 설정: ${result.cli.settingsExported ? 'O' : 'X'} | 최근세션: ${result.cli.lastConversationsExported ? 'O' : 'X'}`);
  }
  console.log(`   [Config]  프로젝트: ${result.config.projectCount}개 | MCP 설정: ${result.config.mcpExported ? 'O' : 'X'}`);

  if (isGitRepo(cfg.syncDir)) {
    const commitMsg = options.message || `Sync antigravity v2 (${target}) [${new Date().toISOString().replace('T', ' ').substring(0, 19)}]`;
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
