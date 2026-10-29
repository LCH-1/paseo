# Claude Windows Usage

Claude Code의 Windows 자격증명 저장소와 별도로 설정된 계정의 파일 인증을 Paseo의 기존 사용량 화면과 Aster에 연결합니다. 기본 계정의 일반 파일 인증은 Paseo 기본 소스가 계속 담당합니다. 별도 계정이 Windows 저장소 대신 파일 인증을 사용해도 사용량과 자동 분배 후보에서 빠지지 않습니다.

Paseo 내장 `claude-usage-source`와 Settings Sync의 Windows 저장소 읽기 형식을 재사용합니다. 토큰은 메모리에서만 사용하며 저장소에 쓰거나 로그로 출력하지 않습니다. 사용량·프로필 조회는 내장 코드의 `api.anthropic.com` 호출을 사용합니다. 인증 갱신은 공식 Claude CLI가 담당합니다.

```powershell
paseo plugin install "C:/path/to/claude-windows-usage"
paseo plugin ls claude-windows-usage
```

Aster의 Windows 지원 버전과 함께 설치합니다. 두 확장은 각각 독립적으로 reload할 수 있으며 설치 앱 수정이나 데몬 재시작은 필요하지 않습니다. Claude 로그인은 PC와 계정별로 준비해야 합니다.

원본은 Paseo 0.12.0의 `plugins/claude-usage-source`이며 Windows 호환 변경은 로컬 native 저장소의 커밋 `92aa09b`에 있습니다. `server/`, `shared/`, `icon.svg`를 원본에서 복사하되, 이 확장의 manifest와 `index.server.ts`는 유지합니다. 원본 및 확장 라이선스는 Apache-2.0입니다.
