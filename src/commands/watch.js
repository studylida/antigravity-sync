import fs from 'node:fs';
import { loadConfig } from '../config.js';
import {
  createWatchController,
  getWatchPaths,
  getWatchStatus,
  startWatchDaemon,
  stopWatchDaemon,
  installWatchAutoStart,
  uninstallWatchAutoStart
} from '../watch.js';

export async function commandWatch(options = {}) {
  if (options.status) {
    const st = getWatchStatus();
    console.log('\n👀 Antigravity Sync Watch 상태');
    console.log('--------------------------------------------------');
    console.log(`실행 상태     : ${st.running ? `🟢 실행 중 (PID ${st.pid})` : '⚪ 중지됨'}`);
    console.log(`로그인 자동시작: ${st.autoStartInstalled ? `✅ 등록됨 (${st.startupScriptPath})` : '❌ 미등록'}`);
    console.log(`로그 파일     : ${st.logPath}`);
    if (st.recentLogs.length > 0) {
      console.log('\n최근 로그:');
      for (const line of st.recentLogs) {
        console.log(`  ${line}`);
      }
    }
    console.log('');
    return;
  }

  if (options.uninstall) {
    const res = uninstallWatchAutoStart();
    console.log(`✅ 자동 감시 해제 완료 (시작프로그램 제거: ${res.removedStartup ? 'O' : 'X'}, 데몬 종료: ${res.stoppedDaemon ? `O (PID ${res.pid})` : '실행 중 아님'})`);
    return;
  }

  if (options.stop) {
    const res = stopWatchDaemon();
    if (res.stopped) {
      console.log(`✅ watch 데몬 종료 완료 (PID ${res.pid})`);
    } else {
      console.log('ℹ️  실행 중인 watch 데몬이 없습니다.');
    }
    return;
  }

  const intervalMs = Math.max(1000, Number(options.interval) || 3000);

  if (options.install) {
    const res = installWatchAutoStart();
    console.log(`✅ Windows 로그인 자동 감시 등록 완료: ${res.startupScriptPath}`);
    if (res.daemon.started) {
      console.log(`🟢 백그라운드 감시 데몬 시작됨 (PID ${res.daemon.pid}, 로그: ${res.daemon.logPath})`);
    } else {
      console.log(`🟢 백그라운드 감시 데몬이 이미 실행 중입니다 (PID ${res.daemon.pid})`);
    }
    return;
  }

  if (options.daemon) {
    const res = startWatchDaemon(intervalMs);
    if (res.started) {
      console.log(`🟢 백그라운드 watch 데몬 시작됨 (PID ${res.pid}, 로그: ${res.logPath})`);
    } else {
      console.log(`🟢 백그라운드 watch 데몬이 이미 실행 중입니다 (PID ${res.pid})`);
    }
    return;
  }

  // Foreground watch loop
  const cfg = loadConfig();
  const paths = getWatchPaths();
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.writeFileSync(paths.pidPath, String(process.pid), 'utf8');

  const logLine = (msg) => {
    console.log(`[${new Date().toISOString()}] ${msg}`);
  };
  logLine(`Antigravity Sync watch started (interval=${intervalMs}ms, pid=${process.pid})`);

  const controller = createWatchController({
    cfg,
    settleMs: Math.min(2000, intervalMs),
    onLog: logLine
  });

  const cleanupPid = () => {
    try {
      if (fs.existsSync(paths.pidPath) && fs.readFileSync(paths.pidPath, 'utf8').trim() === String(process.pid)) {
        fs.rmSync(paths.pidPath, { force: true });
      }
    } catch {}
  };

  let stopped = false;
  const shutdown = () => {
    stopped = true;
    cleanupPid();
    logLine('Watch stopped.');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', cleanupPid);

  const runTick = () => {
    if (stopped) return;
    try {
      controller.step();
    } catch (err) {
      logLine(`[Watch Error] ${err.message}`);
    }
  };

  runTick();
  setInterval(runTick, intervalMs);
}
