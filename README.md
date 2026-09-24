# 🌌 Antigravity Sync (`agy-sync`)

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
[![Node: >=20](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](#)

**Google Antigravity(AGY)** 데스크톱 앱의 대화 내역 및 에이전트 브레인 데이터를 여러 컴퓨터(회사, 집, 노트북) 간에 안전하게 동기화하고 백업하는 범용 오픈소스 CLI 도구입니다.

---

## 💡 개발 배경 (Why Antigravity Sync?)

Google Antigravity는 로컬 파일 시스템(`~/.gemini/antigravity`)에 대화 상태를 저장합니다:
1. **대화 목록 인덱스**: `conversation_summaries.db` (SQLite DB)
2. **세션 메시지 데이터**: `conversations/<conversation_id>.db` (SQLite DB)
3. **에이전트 브레인 & 로그**: `brain/<conversation_id>/` (트랜스크립트, 작업 파일, 아티팩트)

기존에 이 폴더들을 단순 Git 커밋하거나 파일 복사로 동기화하려 할 때 다음과 같은 문제가 발생했습니다:
* 💥 **바이너리 충돌 (Git Merge Conflict)**: 서로 다른 기기에서 대화를 나눈 후 단일 `conversation_summaries.db` 파일을 합치려 하면 Git 충돌이 발생해 DB가 손상됩니다.
* 🔒 **파일 락 (WAL Lock)**: Antigravity가 켜져 있을 때 DB를 건드리면 파일이 잠겨 복사가 실패하거나 데이터가 깨집니다.
* ❌ **UI 미인식**: `brain` 데이터만 백업하거나 `conversations`에 잘못 배치하면 Antigravity UI의 대화 목록에 전혀 나타나지 않습니다.

**Antigravity Sync는 이 문제들을 해결하기 위해 설계되었습니다.**

---

## ✨ 핵심 기능

* 🔄 **스마트 양방향 병합 (Non-destructive Merge)**:
  `conversation_summaries.db`를 Git 친화적인 텍스트(`conversations_index.json`)로 직렬화하여 관리합니다. A 컴퓨터의 대화와 B 컴퓨터의 대화가 서로 지워지지 않고 합집합(Union)으로 안전하게 병합됩니다.
* ⚡ **Zero External Dependencies (무의존성)**:
  Node.js v20+ 내장 모듈(`node:sqlite`, `node:fs`, `node:child_process`)만으로 작성되어, 무거운 빌드 도구나 외부 패키지 설치 없이 `npx`로 즉시 실행할 수 있습니다.
* 🛡️ **작업 전 자동 스냅샷 (Auto-Rollback)**:
  동기화(`pull`)나 복원 작업을 시작하기 전, 현재 로컬 상태를 타임스탬프 스냅샷으로 자동 백업합니다. 만약의 경우 `agy-sync restore` 명령어로 1초 만에 원복할 수 있습니다.
* 🖥️ **크로스 플랫폼 & 프로세스 보호**:
  Windows, macOS, Linux를 자동 감지하며, 동기화 중 Antigravity 앱 실행 여부를 체크하여 데이터 오염을 사전에 방지합니다.
* ☁️ **다양한 저장소 지원**:
  GitHub/GitLab의 **비공개(Private) 저장소** 또는 Google Drive, OneDrive, Dropbox, 로컬 공유 폴더(NAS)를 백엔드로 사용할 수 있습니다.

---

## 🚀 빠른 시작 (Quick Start)

별도 설치 없이 `npx`로 바로 실행하거나, 전역 설치하여 사용할 수 있습니다:

```bash
# npx로 즉시 실행
npx antigravity-sync <명령어>

# 또는 글로벌 설치 후 단축어 사용
npm install -g antigravity-sync
agy-sync <명령어>
```

### 1. 초기 설정 (`init`)
처음 사용할 컴퓨터에서 설정 마법사를 실행합니다:
```bash
agy-sync init
```
* Antigravity 경로(기본값 자동 감지)를 확인합니다.
* 저장소 방식(Git Private Repo 또는 클라우드 공유 폴더)을 선택합니다.
* Git URL(예: `git@github.com:yourname/my-antigravity-backup.git`)을 입력합니다.

### 2. 회사 컴퓨터에서 퇴근 전 동기화 (`push`)
작업한 대화 내역을 동기화 저장소로 내보냅니다:
```bash
agy-sync push -m "3D 그래프 기능 개발 세션 동기화"
```

### 3. 집 컴퓨터에서 작업 시작 전 가져오기 (`pull`)
다른 컴퓨터에서 최신 대화 내역을 안전하게 가져와 로컬 DB에 병합합니다:
```bash
agy-sync pull
```

### 4. 동기화 상태 확인 (`status`)
로컬에만 있는 신규 대화, 원격에만 있는 신규 대화 차이를 확인합니다:
```bash
agy-sync status
```

### 5. 롤백 복원 (`restore`)
이전 상태로 되돌리고 싶을 때 자동 생성된 스냅샷으로 롤백합니다:
```bash
agy-sync restore
```

---

## 📖 명령어 전체 목록

| 명령어 | 설명 | 주요 옵션 |
|---|---|---|
| `agy-sync init` | 저장소 및 Antigravity 경로 대화형 설정 | - |
| `agy-sync push` | 로컬 대화를 저장소로 내보내고 Git Push | `-m, --message <msg>`: 커밋 메시지<br>`--force`: 앱 실행 중 경고 무시 |
| `agy-sync pull` | 저장소에서 가져와 로컬 DB와 무손실 병합 | `--force`: 앱 실행 중 경고 무시 |
| `agy-sync status` | 앱 프로세스 상태 및 로컬/원격 대화 차이점 표시 | - |
| `agy-sync restore [스냅샷]` | 직전 스냅샷 또는 지정된 백업으로 로컬 상태 복원 | `--force`: 앱 실행 중 경고 무시 |
| `agy-sync help` | 도움말 확인 | `-h, --help` |

---

## 🔒 보안 및 프라이버시 주의사항

> [!WARNING]
> Antigravity 대화 내역과 에이전트 브레인 파일에는 **사내 소스코드, API 키, 패스워드, 개인 프로젝트 정보**가 포함되어 있을 수 있습니다.
> Git을 저장소로 사용할 때는 반드시 **비공개 저장소(Private Repository)**를 사용하세요.

---

## 📁 저장소 데이터 구조

동기화 저장소(Git Repo 또는 공유 폴더)에는 다음과 같이 깔끔하고 정돈된 형태로 데이터가 적재됩니다:

```text
sync-data/
├── conversations_index.json    # [핵심] JSON으로 직렬화된 대화 메타데이터 (Git 머지 지원)
├── conversations/              # 세션별 상세 메시지 DB (<UUID>.db)
│   ├── 03963a29-....db
│   └── 5f2a1572-....db
└── brain/                      # 에이전트 작업 로그 및 아티팩트
    ├── 03963a29-.../
    └── 5f2a1572-.../
```

---

## 🛠️ 개발 및 테스트

```bash
# 레포지토리 클론
git clone https://github.com/studylida/antigravity-sync.git
cd antigravity-sync

# 단위 테스트 실행 (Node.js 내장 테스트 러너)
npm test
```

---

## 📄 라이선스 (License)

이 프로젝트는 [GNU General Public License v3.0 (GPL-3.0)](LICENSE)에 따라 배포됩니다.
