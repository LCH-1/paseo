export const sessionSettingsEn = {
  navigationTitle: "Bulk session settings",
  title: "Session settings",
  catalogHost: "Model catalog host",
  catalogHostHint:
    "Loads model and provider choices only. Existing sessions are updated on the target hosts above.",
  provider: "Provider",
  model: "Model",
  access: "Access",
  thinking: "Thinking mode",
  warning: "Warning",
  fast: "Fast",
  keep: "Keep current value",
  on: "On",
  off: "Off",
  target: "Target host for existing sessions",
  allHosts: "All hosts",
  apply: "Apply to existing sessions",
  applyLabel: "Apply",
  defaults: "New workspace defaults",
  save: "Save defaults",
  saved: "Saved new workspace defaults for {{provider}} in this app.",
  scope:
    "Only sessions using {{provider}} are changed. Archived sessions are excluded. New workspace defaults are stored in this app.",
  partial:
    "Successful updates remain applied. Review the failures below before retrying; an individual failed session may have some fields applied.",
  result:
    "Applied: {{applied}} · Failed sessions: {{failed}} · Host errors: {{hosts}} · Disconnected hosts skipped: {{skipped}}",
  skippedHosts: "Skipped disconnected hosts: {{hosts}}",
  skippedHostsHint:
    "No update requests were sent to these hosts. Reconnect and select the host to retry.",
  missingDirectory:
    "Saved working directory is missing: {{path}}. Restore the original project directory before updating this session.",
  loading: "Loading providers…",
  offline: "Connect a host to configure sessions.",
  unavailable: "No available providers on this host.",
  update: "Update this host to load provider settings.",
  working: "Applying…",
  featuresError: "Could not load Fast settings: {{message}}",
};

export const sessionSettingsKo = {
  navigationTitle: "세션 일괄 설정",
  title: "전체 세션 설정",
  catalogHost: "모델 목록 기준 호스트",
  catalogHostHint:
    "모델·공급자 목록만 이 호스트에서 가져옵니다. 기존 세션에는 위에서 지정한 적용 대상 호스트에 반영합니다.",
  provider: "공급자",
  model: "모델",
  access: "Access 범위",
  thinking: "사고 모드",
  warning: "주의",
  fast: "Fast",
  keep: "현재 값 유지",
  on: "On",
  off: "Off",
  target: "기존 세션을 변경할 호스트",
  allHosts: "전체 호스트",
  apply: "기존 세션에 일괄 적용",
  applyLabel: "적용",
  defaults: "새 워크스페이스 기본 설정",
  save: "기본값 저장",
  saved: "이 앱의 {{provider}} 새 워크스페이스 기본값을 저장했습니다.",
  scope:
    "{{provider}} 세션만 변경하며 보관한 세션은 제외합니다. 새 워크스페이스 기본값은 이 앱에 저장됩니다.",
  partial:
    "성공한 세션의 변경은 유지됩니다. 실패한 세션도 일부 항목은 적용되었을 수 있으므로 아래 내용을 확인한 뒤 다시 적용하세요.",
  result:
    "적용 {{applied}}개 · 실패 세션 {{failed}}개 · 호스트 오류 {{hosts}}개 · 미연결 호스트 {{skipped}}개 건너뜀",
  skippedHosts: "미연결로 건너뛴 호스트: {{hosts}}",
  skippedHostsHint:
    "이 호스트에는 변경 요청을 보내지 않았습니다. 연결 후 해당 호스트를 골라 다시 적용하세요.",
  missingDirectory:
    "저장된 작업 폴더가 없습니다: {{path}}. 원래 프로젝트 폴더를 복구한 뒤 이 세션의 설정을 변경하세요.",
  loading: "공급자 목록을 불러오는 중…",
  offline: "호스트에 연결하면 세션을 설정할 수 있습니다.",
  unavailable: "이 호스트에 사용 가능한 공급자가 없습니다.",
  update: "공급자 설정을 불러오려면 이 호스트를 업데이트하세요.",
  working: "적용 중…",
  featuresError: "Fast 설정을 불러오지 못했습니다: {{message}}",
};
