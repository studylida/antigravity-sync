import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { getDefaultAntigravityDir, getDefaultSyncDir, getDefaultBackupDir, loadConfig, saveConfig } from '../config.js';
import { isGitAvailable, initGitRepo } from '../git.js';
import fs from 'node:fs';

export async function commandInit() {
  const rl = readline.createInterface({ input, output });
  try {
    console.log('\n🚀 Antigravity Sync 초기 설정을 시작합니다.\n');

    const currentCfg = loadConfig();
    const defaultAgy = currentCfg.antigravityDir || getDefaultAntigravityDir();

    // 1. Antigravity path
    const agyAnswer = await rl.question(`[1/3] Antigravity 데이터 디렉터리 경로 [기본값: ${defaultAgy}]: `);
    const antigravityDir = agyAnswer.trim() || defaultAgy;

    if (!fs.existsSync(antigravityDir)) {
      console.log(`⚠️  경로가 존재하지 않아 새로 생성합니다: ${antigravityDir}`);
      fs.mkdirSync(antigravityDir, { recursive: true });
    }

    // 2. Storage type
    console.log('\n[2/3] 동기화에 사용할 저장소 유형을 선택하세요:');
    console.log('  1) Git 저장소 (GitHub / GitLab Private Repository 추천)');
    console.log('  2) 로컬 또는 클라우드 공유 폴더 (Google Drive, OneDrive, Dropbox, NAS 등)');
    const storageChoice = await rl.question('선택 (1 또는 2) [기본값: 1]: ');
    const isGit = (storageChoice.trim() || '1') === '1';

    let syncDir = currentCfg.syncDir || getDefaultSyncDir();
    let gitRemote = '';

    if (isGit) {
      if (!isGitAvailable()) {
        console.warn('⚠️  시스템에 git 명령어가 설치되어 있지 않습니다. 로컬 폴더 모드로 전환합니다.');
      } else {
        const remoteAns = await rl.question('\n[3/3] 원격 Git 저장소 URL (예: git@github.com:user/my-repo.git 또는 엔터로 건너뛰기): ');
        gitRemote = remoteAns.trim();

        const syncDirAns = await rl.question(`동기화 로컬 작업 폴더 경로 [기본값: ${syncDir}]: `);
        if (syncDirAns.trim()) syncDir = syncDirAns.trim();

        initGitRepo(syncDir, gitRemote);
        console.log(`✅ Git 저장소가 준비되었습니다: ${syncDir}`);
      }
    } else {
      const syncDirAns = await rl.question(`\n[3/3] 동기화 대상 폴더 경로 (예: C:\\Users\\...\\OneDrive\\AntigravitySync) [기본값: ${syncDir}]: `);
      if (syncDirAns.trim()) syncDir = syncDirAns.trim();
      fs.mkdirSync(syncDir, { recursive: true });
      console.log(`✅ 동기화 폴더가 준비되었습니다: ${syncDir}`);
    }

    const newCfg = {
      antigravityDir,
      syncDir,
      backupDir: currentCfg.backupDir || getDefaultBackupDir(),
      gitRemote,
      autoPush: isGit,
      configured: true
    };

    saveConfig(newCfg);
    console.log('\n🎉 설정이 성공적으로 저장되었습니다!');
    console.log('--------------------------------------------------');
    console.log('사용 가능한 명령어:');
    console.log('  agy-sync push    : 로컬 대화 내역을 동기화 저장소로 내보내기');
    console.log('  agy-sync pull    : 동기화 저장소의 대화 내역을 로컬로 가져와 병합');
    console.log('  agy-sync status  : 현재 동기화 상태 및 차이점 확인');
    console.log('  agy-sync restore : 직전 자동 백업 스냅샷으로 롤백');
    console.log('--------------------------------------------------\n');
  } finally {
    rl.close();
  }
}
