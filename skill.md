# cloxy skill

## Working rule
- Read `README.md` before changing transport behavior.
- Preserve the OpenAI-compatible surface unless there is a concrete break.
- Keep backend differences explicit, not hidden behind heavy abstraction.

## Anti-pattern
- Expanding the proxy surface before the current endpoints are stable.
- Hiding session semantics so callers cannot tell stateless from persisted mode.
- publish 직전에 `AGENTS.md`, `skill.md` 같은 레포 메타를 빠뜨리는 패턴.
- backend별 모델 선택을 넣으면서 `/v1/models` 노출, 실제 adapter 전달, 문서 설명 셋 중 하나만 바꾸는 패턴.
