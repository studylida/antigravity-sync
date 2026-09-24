import { loadConfig } from '../config.js';
import { isAntigravityRunning } from '../process.js';
import { exportSummaries } from '../db.js';
import { isGitRepo, getGitStatus } from '../git.js';
import fs from 'node:fs';
import path from 'node:path';

export async function commandStatus() {
  const cfg = loadConfig();
  console.log('\n📊 Antigravity Sync 상태 보고서');
  console.log('==================================================');

  // 1. Process
  const running = isAntigravityRunning();
  console.log(`[앱 상태]       Antigravity 프로세스: ${running ? '🟢 실행 중 (동기화 전 종료 권장)' : '⚪ 미실행 (동기화 가능)'}`);

  // 2. Local info
  const localDb = path.join(cfg.antigravityDir, 'conversation_summaries.db');
  let localConvs = [];
  if (fs.existsSync(localDb)) {
    try {
      const exported = exportSummaries(localDb);
      localConvs = exported.conversations;
    } catch (e) {
      console.warn('로컬 DB 읽기 실패:', e.message);
    }
  }
  console.log(`[로컬 데이터]   경로: ${cfg.antigravityDir}`);
  console.log(`                보유 대화 수: ${localConvs.length}개`);

  // 3. Sync repo info
  console.log(`[동기화 저장소] 경로: ${cfg.syncDir}`);
  let remoteConvs = [];
  const indexJsonPath = path.join(cfg.syncDir, 'conversations_index.json');
  if (fs.existsSync(indexJsonPath)) {
    try {
      const raw = fs.readFileSync(indexJsonPath, 'utf8');
      remoteConvs = JSON.parse(raw).conversations || [];
    } catch {
      // ignore
    }
  }
  console.log(`                저장소 대화 수: ${remoteConvs.length}개`);

  if (isGitRepo(cfg.syncDir)) {
    const gitStatus = getGitStatus(cfg.syncDir);
    if (gitStatus) {
      console.log(`[Git 상태]      브랜치: ${gitStatus.branch}`);
      console.log(`                원격 URL: ${gitStatus.remote || '(설정되지 않음)'}`);
      console.log(`                로컬 변경사항: ${gitStatus.hasChanges ? '있음 (push 권장)' : '없음 (동기화됨)'}`);
    }
  }

  // 4. Comparison
  const localIds = new Set(localConvs.map(c => c.conversation_id));
  const remoteIds = new Set(remoteConvs.map(c => c.conversation_id));

  const localOnly = localConvs.filter(c => !remoteIds.has(c.conversation_id));
  const remoteOnly = remoteConvs.filter(c => !localIds.has(c.conversation_id));

  console.log('--------------------------------------------------');
  if (localOnly.length > 0) {
    console.log(`📤 Push 대기 중인 로컬 신규 대화 (${localOnly.length}개):`);
    for (const c of localOnly.slice(0, 5)) {
      console.log(`   - [${c.last_modified_time?.substring(0, 10) || 'N/A'}] ${c.title || '(제목 없음)'} (${c.conversation_id.substring(0, 8)}...)`);
    }
    if (localOnly.length > 5) console.log(`   ...외 ${localOnly.length - 5}개`);
  } else {
    console.log('📤 Push 대기 중인 로컬 신규 대화: 없음');
  }

  if (remoteOnly.length > 0) {
    console.log(`📥 Pull 대기 중인 원격 신규 대화 (${remoteOnly.length}개):`);
    for (const c of remoteOnly.slice(0, 5)) {
      console.log(`   - [${c.last_modified_time?.substring(0, 10) || 'N/A'}] ${c.title || '(제목 없음)'} (${c.conversation_id.substring(0, 8)}...)`);
    }
    if (remoteOnly.length > 5) console.log(`   ...외 ${remoteOnly.length - 5}개`);
  } else {
    console.log('📥 Pull 대기 중인 원격 신규 대화: 없음');
  }

  console.log('==================================================\n');
}
