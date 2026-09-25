# Contributing to Antigravity Sync (`agy-sync`)

`antigravity-sync` 프로젝트에 관심을 가져주시고 기여를 고려해 주셔서 감사합니다! 🌌  
여러분의 버그 리포트, 기능 제안, 코드 기여 및 문서 개선은 프로젝트를 더욱 안정적이고 유용하게 만듭니다.

---

## 🧭 핵심 철학: Zero External Dependencies

`antigravity-sync`는 사용자 환경에 관계없이 `npx antigravity-sync`로 즉시 실행할 수 있는 **초경량, 무의존성(Zero External Dependencies)** 도구를 지향합니다.

기여 시 아래의 원칙을 반드시 준수해 주세요:

1. **외부 npm 패키지 의존성 금지**:
   - `node_modules`에 추가되는 외부 패키지(`dependencies`, `devDependencies`)를 추가하지 않습니다.
   - 모든 기능은 **Node.js (>=20.0.0) 내장 모듈**(`node:sqlite`, `node:fs`, `node:path`, `node:child_process`, `node:test` 등)만으로 구현합니다.
2. **단순성과 플랫폼 독립성**:
   - Windows, macOS, Linux 환경에서 별도의 빌드 단계(Build Step) 없이 원활하게 구동되어야 합니다.

---

## 🤝 행동 강령 (Code of Conduct)

모든 기여자와 사용자가 안전하고 존중받는 환경에서 협업할 수 있도록 다음을 지켜주세요:
- 서로 다른 배경과 경험 수준을 가진 동료 개발자에게 친절하고 건설적인 피드백을 제공합니다.
- 기술적 토론은 개인에 대한 비판이 아닌 코드와 아키텍처에 집중합니다.
- 프로젝트 발전에 기여하는 모든 형태(오탈자 수정, 버그 리포트, 아이디어 제안 등)를 환영합니다.

---

## 🛠️ 개발 환경 설정 (Getting Started)

### 필수 요구 사항
- **Node.js**: `v20.0.0` 이상 (`node:sqlite` 및 내장 테스트 러너 사용)
- **Git**: 최신 버전

### 로컬 환경 구성
`antigravity-sync`는 제로 디펜던시 프로젝트이므로 별도의 **`npm install`이나 빌드(Build) 과정이 필요 없습니다.**

1. 저장소를 Fork하고 로컬 머신에 Clone합니다:
   ```bash
   git clone https://github.com/<your-username>/antigravity-sync.git
   cd antigravity-sync
   ```

2. 로컬에서 CLI 실행을 테스트합니다:
   ```bash
   # 직접 스크립트 실행
   node bin/agy-sync.js --help

   # 또는 글로벌 링크 등록 (개발 편의를 위해 권장)
   npm link
   agy-sync --help
   ```

3. 기존 단위 테스트가 정상 통과하는지 확인합니다:
   ```bash
   npm test
   ```

---

## 🚀 기여 워크플로우 (How to Contribute)

`antigravity-sync`는 **GitHub Flow**를 따릅니다. 모든 기여는 `main` 브랜치를 기준으로 작업 브랜치를 분기하여 진행합니다.

### 1. 이슈(Issue) 확인 및 등록
- 새로운 버그를 발견했거나 기능을 제안하고 싶다면, 먼저 기존 [Issues](https://github.com/studylida/antigravity-sync/issues)에서 유사한 논의가 있는지 확인해 주세요.
- 없다면 명확한 재현 단계(Reproduction Steps)나 제안 배경을 담아 신규 이슈를 등록해 주세요.
- 대규모 리팩토링이나 새로운 아키텍처 제안은 코드 작성 전 이슈를 통해 메인테이너와 먼저 방향성을 조율하는 것을 권장합니다.

### 2. 브랜치 생성
항상 최신 `main` 브랜치로부터 작업 브랜치를 분기해 주세요:

```bash
git switch main
git pull upstream main
git switch -c <브랜치-타입>/<간결한-설명>
```

**권장 브랜치 네이밍 규칙:**
- `feat/` : 새로운 기능 추가 (예: `feat/per-machine-branch-strategy`)
- `fix/` : 버그 수정 (예: `fix/parse-options-flags`)
- `docs/` : 문서 추가 및 수정 (예: `docs/contributing-guide`)
- `test/` : 테스트 코드 추가 및 수정 (예: `test/sqlite-concurrency`)
- `refactor/` : 기능 변경 없는 코드 개선

### 3. 변경 사항 구현 및 검증
- 코드 수정 후 반드시 테스트를 실행하여 기존 기능이 깨지지 않았는지 확인합니다:
  ```bash
  npm test
  ```
- 새로운 기능이나 버그 수정 시 관련 단위 테스트를 `tests/` 폴더에 함께 작성해 주세요.

### 4. 풀 리퀘스트(PR) 제출
1. 변경 사항을 본인의 Fork 저장소에 푸시합니다:
   ```bash
   git push origin <작업-브랜치명>
   ```
2. 원본 저장소(`studylida/antigravity-sync`)의 `main` 브랜치를 대상으로 PR을 생성합니다.
3. PR 본문에는 다음 내용을 포함해 주세요:
   - 변경 목적 및 해결하려는 문제 (관련 이슈가 있다면 `Closes #이슈번호` 명시)
   - 주요 변경 사항 요약
   - 테스트를 수행한 OS 환경 (Windows, macOS, Linux 등)

### 5. 풀 리퀘스트(PR) 제출 전 체크리스트
PR을 열기 전에 다음 사항을 스스로 확인(Self-review)해 주세요:
- [ ] `npm test`를 실행하여 모든 단위 테스트가 통과하는가?
- [ ] 개인 설정 파일, 임시 백업 파일, 로그 등 불필요한 파일이 Git Staging에 포함되지 않았는가?
- [ ] 기능/옵션이 추가되거나 변경되었다면 `README.md`나 CLI 도움말(`--help`)에도 반영되었는가?
- [ ] 커밋 메시지가 프로젝트의 컨벤션(`feat:`, `fix:` 등)을 준수하고 있는가?

### 6. 리뷰 피드백 반영 및 추가 푸시 (Iterating on PR)
- 코드 리뷰 과정에서 수정 요청(Changes requested)을 받은 경우:
  1. 새 PR을 열지 말고, **기존 작업 브랜치에서 코드를 수정**합니다.
  2. 수정한 내용을 커밋한 뒤 다시 Fork 저장소로 푸시합니다:
     ```bash
     git push origin <작업-브랜치명>
     ```
  3. 기존 열려 있던 PR에 자동으로 커밋이 추가되어 반영됩니다.
- 리뷰어의 피드백에 질문이나 이견이 있다면 PR 코멘트로 편하게 토론을 이어가시면 됩니다.

### 7. 브랜치 보호 및 머지(Merge) 정책
- **`main` 브랜치 직접 푸시 금지**: 모든 변경 사항(메인테이너 포함)은 PR 및 리뷰를 거쳐 `main`에 병합됩니다.
- 머지 방식: 커밋 히스토리를 깔끔하게 유지하기 위해 기본적으로 **Squash and Merge** 방식을 선호합니다.

---

## 📐 코딩 및 아키텍처 가이드라인 (Coding Standards)

`antigravity-sync`의 안정성과 이식성을 유지하기 위해 다음 규칙을 준수합니다.

### 1. Pure ESM 및 내장 모듈 네임스페이스
- 모든 소스코드는 **ES Modules (`import` / `export`)**로 작성합니다.
- Node.js 내장 모듈을 불러올 때는 반드시 `node:` 접두사(Prefix)를 사용합니다:
  ```javascript
  // Good
  import fs from 'node:fs';
  import path from 'node:path';
  import assert from 'node:assert';

  // Bad
  const fs = require('fs');
  import path from 'path';
  ```

### 2. 크로스 플랫폼(Windows, macOS, Linux) 호환성
- **경로 구분자 하드코딩 금지**: 경로 결합 시 `/`나 `\`를 직접 문자열로 더하지 말고 `path.join()` 또는 `path.resolve()`를 사용합니다.
- **사용자 홈 디렉토리 가상화**: 백업 데이터 내 경로 치환 시 `src/path_utils.js`의 `templatizePaths` 및 `expandPaths` 모듈 규격을 따릅니다.
- **줄바꿈 및 인코딩**: 텍스트 파일 저장 및 처리 시 UTF-8 인코딩을 기본으로 하며, 운영체제별 줄바꿈(`\r\n`, `\n`) 차이로 인한 파싱 오류가 없도록 유의합니다.

### 3. 데이터 안전성 및 예외 처리
- SQLite DB나 세션 데이터를 수정하기 전에 기존 데이터가 유실되지 않도록 방어 로직(스냅샷, 파일 존재 여부 확인 등)을 항상 우선 배치합니다.
- 외부 명령어(`git` 등) 호출 시 실패 가능성을 고려하여 적절한 `try-catch` 및 에러 메시지를 제공합니다.

---

## 🧪 테스트 가이드 (Testing)

모든 기여는 기존 기능의 무결성을 증명하는 테스트를 통과해야 합니다.

### 테스트 실행
저장소의 전체 단위 테스트는 Node.js 내장 테스트 러너로 실행됩니다:
```bash
npm test
```

### 테스트 작성 원칙
- **외부 테스트 라이브러리 미사용**: Jest, Mocha 등의 외부 도구 대신 Node.js 내장 `node:assert`와 `node:test`를 사용합니다.
- **격리된 샌드박스(Sandbox) 활용**: 파일 시스템이나 Git 명령을 테스트할 때는 `tests/test_*_sandbox`와 같은 임시 격리 디렉토리를 생성하여 테스트 후 안전하게 정리(`rmSync`)하도록 작성합니다.
- **재현 가능한 단위 테스트**: 버그를 수정할 때는 해당 버그가 수정 전에는 실패하고 수정 후에는 성공하는 재현 단위 테스트를 `tests/` 디렉토리에 추가해 주세요.

---

## 📝 커밋 메시지 컨벤션 (Commit Convention)

일관되고 추적하기 쉬운 변경 이력을 유지하기 위해 **Conventional Commits** 형식을 따릅니다:

```
<type>(<scope>): <설명>
```

### 접두사(Type) 규칙:
- `feat` : 새로운 기능 추가 (예: `feat(sync): add per-machine branch isolation push strategy`)
- `fix` : 버그 수정 (예: `fix(cli): resolve option parser flag collision`)
- `docs` : 문서 수정 및 추가 (예: `docs: add CONTRIBUTING.md guideline`)
- `test` : 테스트 코드 추가 및 수정 (예: `test(db): add non-destructive merge test`)
- `refactor` : 코드 구조 개선 (기능 변경 없음)
- `chore` : 빌드 스크립트, 패키지 메타데이터 수정 등 잡무

### 본문 및 이슈 연결:
- 커밋 제목은 명령형 현재 시제로 간결하게 작성합니다.
- 관련된 이슈가 있다면 커밋 메시지 본문이나 PR 설명에 `Fixes #이슈번호` 또는 `Closes #이슈번호`를 기재합니다.

---

## 📜 라이선스 (License)

`antigravity-sync`는 **[GNU General Public License v3.0 (GPL-3.0-or-later)](LICENSE)** 라이선스에 따라 배포되는 자유 소프트웨어(Free/Libre Open Source Software)입니다.

- 이 프로젝트에 코드를 제출(Pull Request)함으로써, 귀하의 기여물이 동일한 GPL-3.0 라이선스 조건에 따라 배포되는 것에 동의하게 됩니다.
- 외부 코드를 인용하거나 참조할 경우, 해당 코드가 GPL-3.0과 양립 가능한 라이선스(MIT, Apache 2.0, BSD 등)인지 사전에 확인하고 출처를 명시해야 합니다.