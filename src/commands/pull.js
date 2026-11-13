import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
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

  const target = options.target || 'all';
  assertAntigravitySafe(options.force, {
    desktop: target === 'all' || target === 'desktop',
    cli: target === 'all' || target === 'cli'
  });

  console.log(`🔄 원격 저장소 데이터 가져오기 (Pull, 대상: ${target}) 시작...`);

  console.log('💾 작업 전 로컬 상태를 안전하게 자동 백업합니다...');
  const snapshotPath = createSnapshot(cfg, cfg.backupDir);
  console.log(`   ✅ 백업 스냅샷 생성 완료: ${snapshotPath}`);

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

  console.log('🔄 로컬 대화 데이터 및 설정 병합(Merge) 수행 중...');

  let rl = null;
  let askFn = null;
  if (!options.autoYes && process.stdin.isTTY) {
    rl = readline.createInterface({ input, output });
    askFn = (q) => rl.question(q);
  }

  let result;
  try {
    result = await importFromSyncDir(cfg, {
      ...options,
      target,
      askFn
    });
  } finally {
    if (rl) rl.close();
  }

  if (result.schemaVersion === 1) {
    console.log('   ℹ️  레거시 v1 저장소 포맷을 감지하여 자동으로 가져왔습니다. 다음 "agy-sync push" 시 v2 포맷으로 업그레이드됩니다.');
  }

  console.log('\n📊 병합 결과 보고서:');
  if (result.desktop.present) {
    const m = result.desktop.mergeStats;
    console.log(`   [Desktop] 추가: ${m.added} | 갱신: ${m.updated} | 유지: ${m.skipped} | 세션DB: ${result.desktop.copiedDbCount} | 브레인: ${result.desktop.copiedBrainCount}`);
  }
  if (result.cli.present) {
    const m = result.cli.mergeStats;
    console.log(`   [CLI]     추가: ${m.added} | 갱신: ${m.updated} | 유지: ${m.skipped} | 부모링크: ${m.parentsMerged} | 세션DB: ${result.cli.copiedDbCount} | 브레인: ${result.cli.copiedBrainCount} | 설정: ${result.cli.settingsMerged ? 'O' : 'X'} | 최근세션: ${result.cli.lastConversationsMerged ? 'O' : 'X'}`);
  }
  console.log(`   [Config]  프로젝트: ${result.config.copiedProjectCount}개 | MCP 설정: ${result.config.mcpMerged ? 'O' : 'X'}`);

  console.log('\n🎉 동기화 가져오기(Pull)가 완료되었습니다! 이제 Antigravity를 실행하셔도 좋습니다.\n');
}
