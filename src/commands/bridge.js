import { loadConfig } from '../config.js';
import { assertAntigravitySafe } from '../process.js';
import { bridgeLocalClients } from '../bridge.js';

export async function commandBridge(options = {}) {
  const cfg = loadConfig();
  const direction = options.direction || 'both';
  const dryRun = Boolean(options.dryRun);

  if (!['both', 'cli-to-desktop', 'desktop-to-cli'].includes(direction)) {
    throw new Error(`지원하지 않는 bridge 방향입니다: ${direction} (both | cli-to-desktop | desktop-to-cli)`);
  }

  if (!dryRun) {
    assertAntigravitySafe(options.force, { desktop: true, cli: true });
  }

  console.log(`\n🌉 로컬 Desktop ↔ CLI 브리지 (${direction}${dryRun ? ', 미리보기' : ''}) 실행 중...`);
  const res = bridgeLocalClients(cfg, { direction, dryRun });

  if (dryRun) {
    console.log('\n📋 브리지 미리보기 (실제 변경 없음):');
    console.log(`   - Desktop 보유 대화: ${res.diff.desktopCount}개 | CLI 보유 대화: ${res.diff.cliCount}개`);
    console.log(`   - CLI → Desktop 반영 예정: 신규 ${res.diff.cliOnly.length}개, 갱신 ${res.diff.newerInCli.length}개`);
    console.log(`   - Desktop → CLI 반영 예정: 신규 ${res.diff.desktopOnly.length}개, 갱신 ${res.diff.newerInDesktop.length}개\n`);
    return;
  }

  if (res.snapshotPath) {
    console.log(`💾 자동 백업 스냅샷 생성: ${res.snapshotPath}`);
  }

  if (res.cliToDesktop) {
    const m = res.cliToDesktop.mergeStats;
    console.log(`   [CLI → Desktop] 추가: ${m.added} | 갱신: ${m.updated} | 유지: ${m.skipped} | 세션DB: ${res.cliToDesktop.copiedDbCount} | 브레인: ${res.cliToDesktop.copiedBrainCount}`);
  }
  if (res.desktopToCli) {
    const m = res.desktopToCli.mergeStats;
    console.log(`   [Desktop → CLI] 추가: ${m.added} | 갱신: ${m.updated} | 유지: ${m.skipped} | 부모링크: ${m.parentsMerged} | 세션DB: ${res.desktopToCli.copiedDbCount} | 브레인: ${res.desktopToCli.copiedBrainCount}`);
  }

  console.log('\n🎉 로컬 Desktop ↔ CLI 브리지 연동이 완료되었습니다!\n');
}
