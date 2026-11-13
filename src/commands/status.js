import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { getRunningProcesses } from '../process.js';
import { exportSummaries } from '../db.js';
import { getBridgeDiff } from '../bridge.js';
import { isGitRepo, getGitStatus } from '../git.js';
import { TOOL_VERSION } from '../version.js';

function readIndexConversations(indexPath) {
  if (!fs.existsSync(indexPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8')).conversations || [];
  } catch {
    return [];
  }
}

function printDiffSection(label, localConvs, remoteConvs) {
  const localIds = new Set(localConvs.map(c => c.conversation_id));
  const remoteIds = new Set(remoteConvs.map(c => c.conversation_id));
  const localOnly = localConvs.filter(c => !remoteIds.has(c.conversation_id));
  const remoteOnly = remoteConvs.filter(c => !localIds.has(c.conversation_id));

  console.log(`   [${label}] Push 대기(로컬만): ${localOnly.length}개 | Pull 대기(원격만): ${remoteOnly.length}개`);
  for (const c of localOnly.slice(0, 3)) {
    console.log(`     📤 [${c.last_modified_time?.substring(0, 10) || 'N/A'}] ${c.title || '(제목 없음)'} (${c.conversation_id.substring(0, 8)}...)`);
  }
  for (const c of remoteOnly.slice(0, 3)) {
    console.log(`     📥 [${c.last_modified_time?.substring(0, 10) || 'N/A'}] ${c.title || '(제목 없음)'} (${c.conversation_id.substring(0, 8)}...)`);
  }
}

export async function commandStatus() {
  const cfg = loadConfig();
  console.log(`\n📊 Antigravity Sync v${TOOL_VERSION} 상태 보고서`);
  console.log('==================================================');

  // 1. Process status
  const procs = getRunningProcesses();
  console.log(`[앱 상태]       Desktop: ${procs.desktop ? '🟢 실행 중' : '⚪ 미실행'} | CLI (agy): ${procs.cli ? '🟢 실행 중' : '⚪ 미실행'}`);

  // 2. Local Desktop & CLI
  const desktopDb = path.join(cfg.desktopDir, 'conversation_summaries.db');
  const cliDb = path.join(cfg.cliDir, 'conversation_summaries.db');
  const desktopConvs = fs.existsSync(desktopDb) ? exportSummaries(desktopDb).conversations : [];
  const cliConvs = fs.existsSync(cliDb) ? exportSummaries(cliDb).conversations : [];
  const localProjects = cfg.projectsDir && fs.existsSync(cfg.projectsDir)
    ? fs.readdirSync(cfg.projectsDir).filter(f => f.endsWith('.json'))
    : [];

  console.log(`[Desktop 로컬]  경로: ${cfg.desktopDir} (${desktopConvs.length}개 대화)`);
  console.log(`[CLI 로컬]      경로: ${cfg.cliDir} (${cliConvs.length}개 대화, 폴더 존재: ${fs.existsSync(cfg.cliDir) ? 'O' : 'X'})`);
  console.log(`[Config 로컬]   프로젝트: ${localProjects.length}개`);

  // 3. Local Bridge diff
  const bridgeDiff = getBridgeDiff(cfg.desktopDir, cfg.cliDir);
  console.log(`[로컬 브리지]   CLI→Desktop 대기: ${bridgeDiff.cliOnly.length}개 신규 / ${bridgeDiff.newerInCli.length}개 갱신`);
  console.log(`                Desktop→CLI 대기: ${bridgeDiff.desktopOnly.length}개 신규 / ${bridgeDiff.newerInDesktop.length}개 갱신`);

  // 4. Sync repo info (v2 or legacy v1)
  console.log(`[동기화 저장소] 경로: ${cfg.syncDir}`);
  const manifestPath = path.join(cfg.syncDir, 'manifest.json');
  let remoteDesktopConvs = [];
  let remoteCliConvs = [];

  if (fs.existsSync(manifestPath)) {
    remoteDesktopConvs = readIndexConversations(path.join(cfg.syncDir, 'desktop', 'conversations_index.json'));
    remoteCliConvs = readIndexConversations(path.join(cfg.syncDir, 'cli', 'conversations_index.json'));
    const remoteProjDir = path.join(cfg.syncDir, 'config', 'projects');
    const remoteProjects = fs.existsSync(remoteProjDir) ? fs.readdirSync(remoteProjDir).filter(f => f.endsWith('.json')) : [];
    console.log(`                포맷: v2 | Desktop: ${remoteDesktopConvs.length}개 | CLI: ${remoteCliConvs.length}개 | 프로젝트: ${remoteProjects.length}개`);
  } else {
    remoteDesktopConvs = readIndexConversations(path.join(cfg.syncDir, 'conversations_index.json'));
    console.log(`                포맷: v1(레거시) 또는 미초기화 | Desktop: ${remoteDesktopConvs.length}개`);
  }

  if (isGitRepo(cfg.syncDir)) {
    const gitStatus = getGitStatus(cfg.syncDir);
    if (gitStatus) {
      console.log(`[Git 상태]      브랜치: ${gitStatus.branch} | 원격: ${gitStatus.remote || '(미설정)'} | 변경: ${gitStatus.hasChanges ? '있음' : '없음'}`);
    }
  }

  console.log('--------------------------------------------------');
  printDiffSection('Desktop', desktopConvs, remoteDesktopConvs);
  printDiffSection('CLI', cliConvs, remoteCliConvs);
  console.log('==================================================\n');
}
