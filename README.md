# YouTube Studio Transcript Copy

YouTube Studio 영상 편집 화면에서 현재 영상의 자막/트랜스크립트를 가져와 클립보드에 복사하는 Chrome 확장 프로그램입니다.

`https://studio.youtube.com/video/<영상ID>/edit` 페이지에 **트랜스크립트 복사** 버튼을 추가하고, 버튼을 누르면 해당 영상의 자막을 읽기 좋은 문장 단위 텍스트로 정리해 복사합니다.

## 주요 기능

- YouTube Studio 영상 편집 페이지에 자막 복사 버튼 추가
- 공개 영상 자막 복사
- 로그인된 계정이 접근할 수 있는 비공개 영상 자막 복사 시도
- 자동 생성 자막과 수동 자막 모두 지원
- 한국어 자막 우선 선택
- 한국어 자막이 없으면 수동 자막, 그다음 첫 번째 자막 순서로 fallback
- 자막 줄 조각을 문장 단위로 병합
- 음악/박수/웃음/효과음 표기 제거
- 클립보드 복사 실패 시 extension offscreen 문서로 재시도
- YouTube 요청이 extension service worker에서 차단될 경우 YouTube Studio 페이지 컨텍스트에서 재시도

## 설치 방법

이 확장 프로그램은 Chrome Web Store 배포용 패키지가 아니라, 개발자 모드에서 직접 로드하는 unpacked extension 형태입니다.

1. 이 저장소를 내려받거나 클론합니다.
2. Chrome 주소창에 `chrome://extensions`를 입력합니다.
3. 오른쪽 위의 **Developer mode**를 켭니다.
4. **Load unpacked**를 클릭합니다.
5. 이 저장소 폴더를 선택합니다.
6. 확장 프로그램 목록에 `YouTube Studio Transcript Copy`가 표시되면 설치가 완료됩니다.

수정한 파일을 반영하려면 `chrome://extensions`에서 이 확장 프로그램의 **Reload** 버튼을 눌러야 합니다.

## 사용 방법

1. YouTube에 로그인합니다.
2. YouTube Studio에서 자막을 복사할 영상의 편집 페이지로 이동합니다.
   - 예: `https://studio.youtube.com/video/<영상ID>/edit`
3. 영상 링크 근처에 추가된 **트랜스크립트 복사** 버튼을 클릭합니다.
4. 자막을 가져오면 문장 단위로 정리된 텍스트가 클립보드에 복사됩니다.
5. 원하는 편집기, 문서, 메모 앱에 붙여넣습니다.

## 텍스트 정리 방식

복사되는 텍스트는 원본 자막 세그먼트를 그대로 붙여넣지 않고, 복사 직전에 간단한 후처리를 거칩니다.

- 여러 줄로 쪼개진 자막을 하나의 흐름으로 병합합니다.
- `.`, `?`, `!`, `。`, `？`, `！`, `…` 같은 문장 부호 기준으로 줄을 나눕니다.
- 한국어 자막은 `다`, `요`, `니다`, `습니다` 같은 종결 어미도 보조 기준으로 사용합니다.
- 너무 긴 문장은 일정 길이에서 줄을 나눕니다.
- `[음악]`, `[박수]`, `[웃음]`, `[효과음]`, `♪` 같은 표기를 제거합니다.
- 중복 공백과 문장부호 앞 공백을 정리합니다.

완벽한 문장 분리는 아닙니다. 특히 자동 생성 자막에 문장부호가 거의 없는 경우에는 휴리스틱 기반으로 정리합니다.

## 동작 방식

확장 프로그램은 Manifest V3 기반으로 구성되어 있습니다.

1. `content.js`가 YouTube Studio 편집 페이지의 URL과 DOM 변화를 감지합니다.
2. 영상 편집 페이지에서 현재 URL의 영상 ID를 추출합니다.
3. 자막 복사 버튼을 페이지에 삽입합니다.
4. 버튼을 누르면 `background.js`에 자막 요청을 보냅니다.
5. `background.js`는 YouTube watch 페이지와 YouTube 내부 player/transcript endpoint를 사용해 자막 트랙을 찾습니다.
6. service worker 요청이 YouTube에서 403으로 차단되면 `page_bridge.js`가 YouTube Studio 페이지 컨텍스트에서 요청을 재시도합니다.
7. 자막 텍스트를 가져오면 `content.js`가 문장 단위로 정리합니다.
8. 브라우저 클립보드 API로 복사하고, 실패하면 `offscreen.html`/`offscreen.js`를 통해 다시 복사합니다.

## 비공개 영상과 비공개 자막

이 확장 프로그램은 같은 브라우저에서 YouTube에 로그인된 상태를 전제로 합니다.

로그인된 계정이 해당 영상과 자막에 접근할 수 있으면, 비공개 영상이나 제한된 영상의 자막도 가져오도록 여러 경로를 시도합니다.

다만 다음 경우에는 실패할 수 있습니다.

- 해당 계정에 영상 접근 권한이 없는 경우
- 자막이 아직 생성 중인 경우
- 자막이 YouTube Studio에만 초안 상태로 있고 player endpoint에 노출되지 않는 경우
- YouTube 내부 API 응답 구조가 변경된 경우
- 브라우저 또는 계정 정책으로 내부 endpoint 요청이 차단되는 경우

실패 시 에러 메시지에 `android-omit`, `android-include`, `web-transcript`, `web-timedtext`, `페이지 컨텍스트 재시도` 같은 상세 정보가 표시될 수 있습니다. 이 정보는 어느 경로가 막혔는지 확인하기 위한 진단용입니다.

## 권한

`manifest.json`에서 사용하는 주요 권한은 다음과 같습니다.

- `clipboardWrite`: 정리된 자막 텍스트를 클립보드에 쓰기 위해 사용합니다.
- `offscreen`: Manifest V3 환경에서 클립보드 복사 fallback을 처리하기 위해 사용합니다.
- `host_permissions`
  - `https://studio.youtube.com/*`: YouTube Studio 편집 페이지에 버튼을 삽입하기 위해 사용합니다.
  - `https://www.youtube.com/*`: 자막 트랙과 YouTube 내부 endpoint에 접근하기 위해 사용합니다.

## 파일 구성

- `manifest.json`: Chrome 확장 프로그램 설정 파일
- `content.js`: YouTube Studio 페이지에 버튼을 삽입하고 복사 흐름을 제어하는 content script
- `background.js`: 자막 트랙 탐색, YouTube endpoint 호출, offscreen 복사 요청을 처리하는 service worker
- `page_bridge.js`: service worker 요청이 차단될 때 YouTube Studio 페이지 컨텍스트에서 자막 요청을 재시도하는 브리지
- `offscreen.html`: Manifest V3 offscreen 문서
- `offscreen.js`: offscreen 문서에서 클립보드 복사를 수행하는 스크립트
- `icons/`: 확장 프로그램 아이콘 이미지

## 개발 메모

문법 검사는 다음 명령으로 확인할 수 있습니다.

```powershell
node --check background.js
node --check content.js
node --check page_bridge.js
node --check offscreen.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"
```

Chrome 확장 프로그램은 파일을 수정한 뒤 자동으로 갱신되지 않습니다. 변경 사항을 테스트하려면 `chrome://extensions`에서 확장 프로그램을 Reload해야 합니다.

## 제한 사항

이 확장 프로그램은 YouTube의 공개 공식 Captions API를 사용하는 도구가 아닙니다. YouTube 웹 플레이어와 YouTube Studio에서 사용하는 내부 응답 구조를 활용합니다. 따라서 YouTube가 내부 구조나 요청 정책을 바꾸면 동작이 깨질 수 있습니다.

또한 이 확장 프로그램은 사용자가 접근할 수 없는 영상이나 자막을 우회해 가져오는 도구가 아닙니다. 현재 브라우저 세션과 로그인된 YouTube 계정의 접근 권한 범위 안에서만 동작합니다.

## 라이선스

MIT License입니다. 자세한 내용은 [LICENSE](LICENSE)를 참고하세요.
