import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import fs from 'node:fs';
import {
  getDefaultDesktopDir,
  getDefaultCliDir,
  getDefaultGeminiConfigDir,
  getDefaultSyncDir,
  getDefaultBackupDir,
  loadConfig,
  saveConfig
} from '../config.js';
import { isGitAvailable, initGitRepo } from '../git.js';
import { TOOL_VERSION } from '../version.js';

export async function commandInit() {
  const rl = readline.createInterface({ input, output });
  try {
    console.log(`\n🚀 Antigravity Sync v${TOOL_VERSION} 초기 설정을 시작합니다.\n`);

    const currentCfg = loadConfig();
    const defaultDesktop = currentCfg.desktopDir || getDefaultDesktopDir();
    const defaultCli = currentCfg.cliDir || getDefaultCliDir();
    const defaultConfig = currentCfg.geminiConfigDir || getDefaultGeminiConfigDir();

    // 1. Desktop & CLI paths
    const desktopAns = await rl.question(`[1/5] Antigravity Desktop 경로 [기본값: ${defaultDesktop}]: `);
    const desktopDir = desktopAns.trim() || defaultDesktop;

    const cliAns = await rl.question(`[2/5] Antigravity CLI (agy) 경로 [기본값: ${defaultCli}]: `);
    const cliDir = cliAns.trim() || defaultCli;

    const configAns = await rl.question(`[3/5] 공통 Config 경로 (~/.gemini/config) [기본값: ${defaultConfig}]: `);
    const geminiConfigDir = configAns.trim() || defaultConfig;

    // 2. Sync targets
    const cliDetected = fs.existsSync(cliDir);
    console.log(`\n[4/5] 동기화 대상 선택 (CLI 폴더 감지됨: ${cliDetected ? '예' : '아니오'}):`);
    console.log('  1) 전체 (Desktop + CLI + Config) [추천]');
    console.log('  2) Desktop + Config만');
    console.log('  3) CLI + Config만');
    const targetChoice = (await rl.question('선택 (1~3) [기본값: 1]: ')).trim() || '1';
    const targets = {
      desktop: targetChoice === '1' || targetChoice === '2',
      cli: targetChoice === '1' || targetChoice === '3',
      config: true
    };

    // 3. Storage type
    console.log('\n[5/5] 동기화에 사용할 저장소 유형을 선택하세요:');
    console.log('  1) Git 저장소 (GitHub / GitLab Private Repository 추천)');
    console.log('  2) 로컬 또는 클라우드 공유 폴더 (Google Drive, OneDrive, Dropbox, NAS 등)');
    const storageChoice = (await rl.question('선택 (1 또는 2) [기본값: 1]: ')).trim() || '1';
    const isGit = storageChoice === '1';

    let syncDir = currentCfg.syncDir || getDefaultSyncDir();
    let gitRemote = currentCfg.gitRemote || '';

    if (isGit) {
      if (!isGitAvailable()) {
        console.warn('⚠️  시스템에 git 명령어가 설치되어 있지 않습니다. 로컬 폴더 모드로 전환합니다.');
      } else {
        const remotePrompt = gitRemote
          ? `원격 Git 저장소 URL [현재: ${gitRemote}, 유지하려면 엔터]: `
          : '원격 Git 저장소 URL (예: git@github.com:user/my-repo.git 또는 엔터로 건너뛰기): ';
        const remoteAns = (await rl.question(`\n${remotePrompt}`)).trim();
        if (remoteAns) gitRemote = remoteAns;

        const syncDirAns = (await rl.question(`동기화 로컬 작업 폴더 경로 [기본값: ${syncDir}]: `)).trim();
        if (syncDirAns) syncDir = syncDirAns;

        initGitRepo(syncDir, gitRemote);
        console.log(`✅ Git 저장소가 준비되었습니다: ${syncDir}`);
      }
    } else {
      const syncDirAns = (await rl.question(`\n동기화 대상 폴더 경로 [기본값: ${syncDir}]: `)).trim();
      if (syncDirAns) syncDir = syncDirAns;
      fs.mkdirSync(syncDir, { recursive: true });
      console.log(`✅ 동기화 폴더가 준비되었습니다: ${syncDir}`);
    }

    const newCfg = {
      configVersion: 2,
      desktopDir,
      cliDir,
      geminiConfigDir,
      syncDir,
      backupDir: currentCfg.backupDir || getDefaultBackupDir(),
      gitRemote,
      autoPush: isGit,
      targets,
      configured: true
    };

    saveConfig(newCfg);
    console.log('\n🎉 설정이 성공적으로 저장되었습니다!');
    console.log('--------------------------------------------------');
    console.log('사용 가능한 명령어:');
    console.log('  agy-sync bridge  : 같은 PC 내 Desktop ↔ CLI 대화 양방향 연동');
    console.log('  agy-sync push    : 로컬(Desktop/CLI/Config) 상태를 저장소로 내보내기');
    console.log('  agy-sync pull    : 저장소에서 가져와 로컬 DB/설정에 무손실 병합');
    console.log('  agy-sync status  : 프로세스 상태, 로컬 브리지 차이 및 원격 상태 확인');
    console.log('  agy-sync restore : 직전 자동 백업 스냅샷으로 롤백');
    console.log('--------------------------------------------------\n');
  } finally {
    rl.close();
  }
}
