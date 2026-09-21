# 큐레이터 설정과 실험

운영 추천, 식별 복구, 상세 설명은 모두 [curation.json](curation.json)의 같은 프로필을 사용합니다. 기본 `balanced` 프로필은 다음 세 호출만 정의합니다.

- `list`: 12편을 한 번에 큐레이션
- `repair`: 식별에 실패한 슬롯만 한 번 교체
- `detail`: 사용자가 영화를 열었을 때 긴 설명 생성

`baseline` 프로필은 비교 실험용입니다. Sol 계열 모델은 설정 검증 단계에서 거부됩니다.

현재 응답 목표는 20초이며 성공 여부를 결정하는 강제 중단선과 구분합니다. `list.timeoutMs`는 35초, `repair.timeoutMs`는 8초, 전체 추천 작업은 55초까지 허용합니다. 식별 확인은 메인 응답 생성과 겹쳐 실행합니다. 영화·문헌 확인을 생략하거나 모델을 낮춰 목표 시간을 맞추지 않습니다. `smoke-curator.ts`는 이 복구 시간을 허용하면서 `within20s`를 별도로 기록합니다. `evaluate:curator-quality`의 기본 20초 제한은 기존 품질·속도 비교를 위한 실험 조건이므로 운영 동작 전체를 비교하려면 명시적으로 `--deadline-ms 55000`을 사용합니다.

환경 변수는 선택한 프로필보다 우선합니다.

```dotenv
STRADA_PROFILE=balanced
OPENAI_CURATOR_MODEL=gpt-5.6-terra
OPENAI_CURATOR_REASONING=none
OPENAI_REPAIR_MODEL=gpt-5.4
OPENAI_REPAIR_REASONING=none
OPENAI_DETAIL_MODEL=gpt-5.4-mini
OPENAI_DETAIL_REASONING=low
```

모델만 비교하려면 운영 설정을 바꾸기 전에 벤치마크 CLI를 사용합니다.

```sh
npm run benchmark:curator -- --run --case all --models gpt-5.4-mini,gpt-5.6-terra --out work/curator-comparison.json
npm run evaluate:curator-quality -- --run --case all --model gpt-5.6-terra --out work/curator-quality.json
```

프롬프트 실험은 [curation-prompts.ts](curation-prompts.ts)의 `curatorPromptAdditions`에 한 단계의 지침만 추가해 비교합니다. 완전 교체가 필요할 때만 `curatorPromptOverrides`를 사용합니다. 메인 출력 계약은 `lib/server/curator/contract.ts`, 실제 프롬프트는 `lib/server/curator/model.ts`와 `detail-contract.ts`에 있습니다.

변경 후 서버를 재시작하고 같은 입력, 언어, 문헌 버전으로 비교합니다. 한 번에 모델·추론 수준·프롬프트 중 하나만 바꾸고, 연결의 구체성·발견 가치·사실 정확성·전체 목록 구성을 함께 평가합니다. 운영 반영에는 새 Vercel 배포가 필요합니다.
