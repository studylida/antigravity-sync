# 🌌 Antigravity Sync (`agy-sync`)

[![npm version](https://img.shields.io/npm/v/antigravity-sync.svg)](https://www.npmjs.com/package/antigravity-sync)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
[![Node: >=20](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](#)

**Google Antigravity(AGY)** 데스크톱 앱과 **Antigravity CLI (`agy`)** 의 대화 내역, 에이전트 브레인, 설정을 **같은 PC 내에서 양방향 브리지 연동**하고 **여러 컴퓨터(회사, 집, 노트북) 간에 안전하게 동기화·백업**하는 무의존성(Zero-dependency) 오픈소스 CLI 도구입니다.

---

## 💡 개발 배경 (Why Antigravity Sync v2?)

Google Antigravity는 데스크톱 앱과 CLI(`agy`)가 로컬에서 별도 디렉터리에 상태를 저장합니다:
1. **Desktop 앱 (`~/.gemini/antigravity/`)**: `conversation_summaries.db`, `conversations/<uuid>.db`, `brain/<uuid>/`
2. **CLI (`~/.gemini/antigravity-cli/`)**: `conversation_summaries.db`(`conversation_parents` 포함), `conversations/<uuid>.db`, `brain/<uuid>/`, `settings.json`, `cache/last_conversations.json`
3. **공통 Config (`~/.gemini/config/`)**: `projects/*.json`, `mcp_config.json`

기존 v1이 데스크톱 앱의 다중 PC 동기화에만 집중했다면, **v2.0.0**부터는 다음 문제까지 함께 해결합니다:
* 🌉 **Desktop ↔ CLI 로컬 단절 해결**: 터미널(`agy`)에서 진행하던 대화를 데스크톱 앱으로, 데스크톱에서 하던 대화를 `agy --conversation <uuid>`로 이어할 수 있도록 `bridge` 기능을 제공합니다.
* 💥 **바이너리 충돌 방지**: 양쪽 클라이언트의 `conversation_summaries.db`를 Git 친화적 JSON(`conversations_index.json`)으로 직렬화해 무손실 합집합 병합합니다.
* 🔒 **이중 프로세스 & WAL 잠금 보호**: `Antigravity.exe`/`antigravity`뿐만 아니라 `agy.exe`/`agy` 프로세스 실행 여부까지 감지해 DB 손상을 방지합니다.

---

## ✨ 핵심 기능

* 🌉 **로컬 Desktop ↔ CLI 브리지 (`agy-sync bridge`)**:
  같은 PC 내 데스크톱과 CLI의 대화 내역·세션 DB·브레인·`annotations/*.pbtxt`·프로토 캐시(`.pb`)·CLI 메타데이터 캐시(`conversation_metadata.json`)를 양방향(`both`) 또는 단방향(`cli-to-desktop`, `desktop-to-cli`)으로 안전하게 병합합니다.
  - CLI 대화를 Desktop의 해당 프로젝트 UUID 또는 Playground(`outside-of-project`)에 매핑해 Desktop 사이드바에 바로 표시합니다.
  - Desktop 전용 `.db`를 CLI 폴더에 중복 생성하지 않아 Desktop의 CLI 재태깅/제목 손실 충돌을 방지하며, `agy` CLI의 `/resume` 두 번째 탭(`Tab` 키)에서 Desktop 대화를 이어서 열 수 있습니다.
* 🛡️ **자동 치유 메타데이터 장부 & 백그라운드 감시 (`agy-sync watch`)**:
  `metadata_guard.json` 장부에 정상 제목·프로젝트·소스를 기록해 두어 Desktop 재스캔으로 메타데이터가 덮어쓰여도 자동 치유하며, `agy-sync watch --install`로 앱/CLI 종료 직후 자동 브리지를 실행할 수 있습니다.
* 🔄 **클라이언트 분리 저장 + 다중 PC 동기화 (`push` / `pull`)**:
  `sync-data/` 내부를 `desktop/`, `cli/`, `config/`로 분리 저장해 복잡도를 낮추면서도, CLI의 `settings.json`(`trustedWorkspaces` 합집합 병합)과 `last_conversations.json`, 공통 `projects/*.json` 및 `mcp_config.json`, `annotations/`까지 함께 동기화합니다. (`init` 시 `gh` 로그인 상태면 GitHub 비공개 저장소 자동 생성·연결 지원, 기존 v1 저장소 자동 업그레이드)
* 🔒 **안전한 프로세스 종료 & WAL 읽기 보호**:
  `bridge` / `push` / `pull` / `restore` 실행 시(외부 터미널에서) 실행 중인 `Antigravity` / `agy` / 잔여 `language_server` 프로세스를 안전하게 종료한 뒤 진행하며, Antigravity 내부 터미널에서의 자가 종료를 차단하고 `.gitattributes`(`* -text`)로 대량 CRLF 경고를 방지합니다.
* ⚡ **Zero External Dependencies (무의존성)**:
  Node.js v20+ 내장 모듈(`node:sqlite`, `node:fs`, `node:child_process`)만으로 작성되어 `npx`로 즉시 실행 가능합니다.
* 📂 **스마트 프로젝트 탐색기 & 홈 경로 가상화 (`{{USER_HOME}}`)**:
  OS·사용자명이 달라져도(`C:\Users\work` ↔ `/Users/home`) `transcript.jsonl`, `workspace_uris`, `settings.json`, `last_conversations.json` 경로를 자동 치환하고 로컬 Git 저장소와 매칭합니다.
* 💾 **작업 전 자동 스냅샷 (`restore`)**:
  `pull` 또는 `bridge` 실행 전 로컬 Desktop·CLI·Config 상태를 자동 백업하여 언제든 `agy-sync restore`로 복원할 수 있습니다.

---

## 🚀 빠른 시작 (Quick Start)

```bash
# npx로 즉시 실행
npx antigravity-sync <명령어>

# 또는 글로벌 설치 후 단축어 사용
npm install -g antigravity-sync
agy-sync <명령어>
```

### 1. 초기 설정 (`init`)
```bash
agy-sync init
```

### 2. 같은 PC에서 Desktop ↔ CLI 대화 이어하기 (`bridge` / `watch`)
*(Antigravity 내부 터미널이 아닌 **외부 PowerShell/터미널**에서 실행하면 실행 중인 앱·CLI를 자동 종료한 뒤 안전하게 반영됩니다.)*

```bash
# 변경 예정 내역 미리보기
agy-sync bridge --dry-run

# 양방향 브리지 실행 (작업 전 자동 백업 + 장부 자동 치유)
agy-sync bridge

# (선택) 백그라운드 감시 및 Windows 로그인 자동 시작 등록
# Desktop과 CLI가 모두 종료된 안전 시점에 자동으로 bridge 실행
agy-sync watch --install
agy-sync watch --status
```

> **팁 (`agy` CLI에서 Desktop 대화 보기)**: `agy` 실행 후 `/resume` 화면에서 **`Tab` 키**를 누르면 두 번째 탭에 Desktop 대화가 표시됩니다.

### 3. 회사 PC에서 퇴근 전 동기화 (`push`)
```bash
agy-sync push -m "CLI 및 데스크톱 세션 동기화"
```

### 4. 집 PC에서 작업 시작 전 가져오기 (`pull`)
```bash
agy-sync pull
```

### 5. 상태 확인 및 복원 (`status` / `restore`)
```bash
agy-sync status
agy-sync restore
```

---

## 💻 다른 컴퓨터(회사 ↔ 집) 빠른 연동 가이드

새 PC나 다른 컴퓨터에 `v2.2`을 세팅할 때는 아래 순서대로 진행하세요.
*(실행 시 외부 터미널을 사용하면 실행 중인 **Antigravity Desktop**과 **`agy` CLI**를 자동으로 종료한 뒤 안전하게 작업합니다.)*

1. **도구 설치 또는 최신화**
   ```bash
   # Git 저장소 직접 설치 (또는 최신화: git pull && npm install -g .)
   git clone https://github.com/studylida/antigravity-sync.git
   cd antigravity-sync && npm install -g .

   agy-sync --version   # antigravity-sync v2.2.0 확인
   ```
2. **초기 설정**: `agy-sync init` 실행 후 `1) 전체 (Desktop + CLI + Config)` 및 동일한 비공개 Git 저장소/공유 폴더 선택 (`gh` 로그인 시 GitHub 비공개 저장소 자동 생성·연결 가능)
3. **로컬 브리지 (Desktop ↔ CLI 합치기)**:
   ```bash
   agy-sync status
   agy-sync bridge --dry-run
   agy-sync bridge
   ```
4. **원격 저장소와 동기화**:
   ```bash
   agy-sync pull
   agy-sync push -m "다른 PC 초기 동기화"
   ```
   > **참고**: 기존 `v1` 동기화 저장소라도 `pull` 시 자동으로 인식해 병합하며, 다음 `push` 시 `v2` 폴더 구조(`desktop/`, `cli/`, `config/`)로 자동 업그레이드됩니다.
5. **일상 사용 루틴**: `agy-sync watch --install`을 한 번 켜 두면 같은 PC 내 Desktop ↔ CLI 전환은 자동 처리되며, 다른 PC 이동 시에만 `agy-sync push` / `agy-sync pull` 실행

### 🤖 다른 PC의 AI 에이전트(`agy`)에게 바로 시키기 (복사용 프롬프트)

다른 컴퓨터에 설치된 `agy`에게 아래 프롬프트를 그대로 붙여넣어 세팅을 맡길 수 있습니다:

````markdown
`antigravity-sync`를 v2.2.0 이상으로 설치/업데이트해서 현재 PC의 Antigravity Desktop과 CLI(`agy`)를 연동하고 싶어.
1. 로컬 레포에서 `git pull && npm install -g .`(또는 `git clone` 후 설치)를 수행하고 `agy-sync --version`이 `2.2.0` 이상인지 확인해줘.
2. `agy-sync status`와 `agy-sync bridge --dry-run`을 실행해서 현재 Desktop/CLI 대화 차이점과 프로세스 실행 상태를 먼저 보여줘.
3. 실제 `bridge`, `pull`, `push`를 실행하기 전에 내가 외부 터미널에서 실행해야 하는지(현재 Desktop/CLI 실행 중인지) 안내하고 진행해줘.
````

---

## 📖 명령어 전체 목록

| 명령어 | 설명 | 주요 옵션 |
|---|---|---|
| `agy-sync init` | Desktop, CLI, Config 경로 및 저장소 대화형 설정 | - |
| `agy-sync bridge` | 같은 PC 내 Desktop ↔ CLI 대화 양방향 병합 및 자동 치유 | `--direction <both\|cli-to-desktop\|desktop-to-cli>`<br>`--dry-run`, `--force` |
| `agy-sync watch` | Desktop/CLI 종료 시 자동 브리지 데몬 및 로그인 자동시작 관리 | `--daemon`, `--stop`, `--status`<br>`--install`, `--uninstall`, `--interval <ms>` |
| `agy-sync push` | 로컬 Desktop/CLI/Config를 저장소로 내보내고 Git Push | `--target <all\|desktop\|cli\|config>`<br>`-m, --message <msg>`, `--force` |
| `agy-sync pull` | 저장소에서 가져와 로컬 Desktop/CLI/Config에 무손실 병합 | `--target <all\|desktop\|cli\|config>`<br>`--auto-yes`, `--force` |
| `agy-sync status` | 실행 프로세스, Watch 데몬, 로컬 브리지 및 원격 동기화 차이 표시 | - |
| `agy-sync restore [스냅샷]` | 자동 백업 스냅샷(v1/v2)으로 로컬 상태 복원 | `--force` |
| `agy-sync --version` | 현재 도구 SemVer 버전 출력 | `-v` |

---

## 📁 저장소 데이터 구조 (`schemaVersion: 2`)

```text
sync-data/
├── manifest.json                   # 스키마/도구 버전 및 활성 타깃 메타데이터
├── desktop/                        # ~/.gemini/antigravity
│   ├── conversations_index.json
│   ├── conversations/<uuid>.db
│   └── brain/<uuid>/
├── cli/                            # ~/.gemini/antigravity-cli
│   ├── conversations_index.json    # conversation_parents 포함
│   ├── conversations/<uuid>.db
│   ├── brain/<uuid>/
│   ├── settings.json               # 경로 템플릿화 적용
│   └── last_conversations.json     # 작업 디렉터리별 최근 세션 맵
└── config/                         # ~/.gemini/config
    ├── projects/*.json
    └── mcp_config.json
```

---

## 🏷️ 버전 관리 규칙 (Semantic Versioning)

이 프로젝트는 `MAJOR.MINOR.PATCH`([SemVer 2.0.0](https://semver.org/))와 [CHANGELOG.md](CHANGELOG.md)를 기준으로 버전을 관리합니다:
* **MAJOR (`npm run version:major`)**: `sync-data/` 스키마 또는 CLI 명령어의 하위 호환이 깨지는 구조 개편
* **MINOR (`npm run version:minor`)**: 하위 호환을 유지하는 신규 명령어, 옵션, 동기화 대상 추가
* **PATCH (`npm run version:patch`)**: 버그 수정 및 내부 안정성 개선

---

## 🔒 보안 및 프라이버시 주의사항

> [!WARNING]
> Antigravity 대화 내역, 브레인 파일, `settings.json`, `mcp_config.json`에는 **사내 소스코드, API 키, 패스워드, 개인 프로젝트 경로**가 포함될 수 있습니다.
> Git 저장소 백엔드 사용 시 반드시 **비공개 저장소(Private Repository)**를 사용하세요.

---

## 🛠️ 개발 및 테스트

```bash
git clone https://github.com/studylida/antigravity-sync.git
cd antigravity-sync
npm test
```

---

## 📄 라이선스 (License)

이 프로젝트는 [GNU General Public License v3.0 (GPL-3.0)](LICENSE)에 따라 배포됩니다.
