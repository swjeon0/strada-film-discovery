# STRADA 모델과 프롬프트 실험

## 현재 추천 목록 경로

현재 `/api/recommendations`의 12편 목록은 아래의 단일 경로를 사용합니다.

- 운영 모델·시간·출력 예산: `lib/server/curator-production.ts`의 `PRODUCTION_CURATOR_SETTINGS`
- 문헌 저장소: `lib/server/knowledge/corpus.ts`, 수집 자료: `research/knowledge/records`, 절차: `research/knowledge/README.md`
- 큐레이션 프롬프트: `lib/server/curator-v1/curate.ts`의 `SYSTEM_V2`
- 식별 실패 슬롯 프롬프트: 같은 파일의 `REPAIR_SYSTEM`
- 같은 평가 입력에서 모델 비교: `npm run benchmark:curator-v1 -- --run --case all --models 모델명 --out work/결과.json`
- 프롬프트와 문헌 유무의 블라인드 비교: `npm run evaluate:curator-v1-quality -- --run --case all --model 모델명 --out work/결과.json`

운영 모델을 바꾸지 않고 실험하려면 먼저 CLI의 `--models`만 바꿉니다. 프롬프트는 `SYSTEM_V2`를 복사해 버전을 하나 더 만든 뒤 `promptVersion`으로 분기해야 같은 조건을 재현할 수 있습니다. 아래의 프로필 설명은 상세 설명과 보관 중인 이전 다단계 파이프라인에 적용되며, 현재 12편 목록의 `PRODUCTION_CURATOR_SETTINGS`를 덮어쓰지 않습니다.

운영 화면에는 설정 버튼을 추가하지 않았습니다. 아래 설정은 서버에서만 읽으며 방문자가 모델이나 프롬프트를 바꿀 수 없습니다. API 키는 기존 `.env.local` 또는 Vercel 환경 변수에 둡니다.

## 모델 바꾸기

`config/curation.json`의 `balanced` 프로필이 기본값입니다. `draft`는 공동 해석과 후보 구성, `curate`는 근거를 읽고 최종 영화를 고르는 비평적 판단, `write`는 그 판단을 보존한 추천 이유의 병렬 작성, `detail`은 상세 설명, `search`는 자료 검색입니다. 강한 모델은 `curate`에서 짧은 판단을 맡고, 글로 풀어내는 작업은 `write`에서 작은 묶음으로 나눕니다.

환경 변수는 파일 설정보다 우선합니다. 예를 들어 최종 선별만 Terra로 비교하려면 `.env.local`에 다음을 넣고 개발 서버를 재시작합니다.

```dotenv
OPENAI_SELECT_MODEL=gpt-5.6-terra
OPENAI_SELECT_REASONING=low
```

같은 방식으로 `OPENAI_DRAFT_MODEL` / `OPENAI_DRAFT_REASONING`, `OPENAI_WRITE_MODEL` / `OPENAI_WRITE_REASONING`, `OPENAI_DETAIL_MODEL` / `OPENAI_DETAIL_REASONING`, `OPENAI_SEARCH_MODEL` / `OPENAI_SEARCH_REASONING`을 설정합니다. GPT-4.1 같은 비추론 모델에는 reasoning 매개변수를 보내지 않습니다.

`STRADA_PROFILE=baseline`은 **현재 파이프라인을 유지하면서** 초안·선별·추천 이유·상세 모델을 5.4-mini로 맞춥니다. 과거 버전의 서비스 전체를 재현하는 옵션은 아닙니다. `config/curation.json`에서 프로필을 복사해 새 이름을 만든 뒤 `STRADA_PROFILE=새이름`으로 선택할 수도 있습니다.

기존 `OPENAI_CURATOR_MODEL` / `OPENAI_CURATOR_REASONING`은 네 추론 단계의 공통 설정으로 계속 지원합니다. 우선순위는 **단계별 환경 변수 → 공통 환경 변수 → 선택한 프로필**입니다. 파일 설정을 바꿨는데 모델이 그대로라면 Vercel이나 `.env.local`의 기존 공통 설정을 확인합니다.

## 프롬프트 바꾸기

`config/curation-prompts.ts`의 `curationPromptAdditions`에서 원하는 단계의 빈 문자열에 지침을 추가합니다. 기본 프롬프트 뒤에 붙으므로 원문의 출력 형식과 근거 규칙을 유지하며 비교할 수 있습니다.

```ts
export const curationPromptAdditions = {
  draft: '',
  curate: 'Prefer a precise contrast in sound or staging when it reveals a relation beyond shared subject matter.',
  write: '',
  detail: '',
};
```

전체 교체가 필요하면 같은 파일의 `curationPromptOverrides`에 해당 단계만 넣습니다. 기본 전문은 `lib/curation-contract.ts`, 병렬 작성 기본 전문은 `lib/curation-writing-prompt.ts`에 있습니다. 출력 JSON의 필드와 영화 식별자는 스키마를 따라야 합니다. 자료에 없는 인용문을 만들거나 선택 영화의 비중을 바꾸는 지침은 추가하지 않는 편이 좋습니다.

모델·추론 수준·실제 프롬프트 내용은 설정 지문에 포함됩니다. 캐시를 사용하는 호출은 이 지문을 기준으로 결과를 구분합니다. 서버 로그의 `STRADA curator phase`에서 단계, 실제 응답 모델, 시간, 토큰, 설정 지문을 확인할 수 있습니다. 키는 이 로그에 포함되지 않습니다.

## 비교 순서

1. 같은 영화 조합과 같은 언어로 기준 결과를 저장합니다. 재생성은 이미 나온 영화를 제외하므로 첫 추천끼리 비교해야 합니다.
2. 한 번에 모델, 추론 수준, 프롬프트 중 하나만 바꿉니다.
3. 형식과 시대가 다른 조합 두세 개로 확인합니다. 한 번의 응답 속도만으로 결정하지 않습니다.
4. 전체 대기 시간과 함께 영화별 연결의 구체성, 사실 오류, 읽은 자료의 실제 반영, 목록의 다양성을 비교합니다.

모델 파일이나 프롬프트 변경은 개발 서버 재시작 후 적용됩니다. 운영 사이트에는 GitHub에 올려 Vercel 새 배포가 완료되어야 적용됩니다. 환경 변수만 바꿨을 때도 Vercel에서 새 배포가 필요합니다. 실험 호출은 설정된 모델의 API 사용량으로 청구됩니다.

## 보관용 구형 다단계 벤치마크 (현재 서비스에서 사용하지 않음)

프로젝트 폴더에서 실행합니다. `.env.local`을 자동으로 읽습니다. `--run`이 없으면 설정만 출력하고 외부 API를 호출하지 않습니다.

```bash
npm run benchmark -- --seeds tmdb:126238,tmdb:43838 --language ko
```

최종 판단 모델 두 개를 같은 후보·같은 자료로 비교합니다. 후보 준비는 한 번만 실행하며, `write` 모델은 같게 유지합니다. 실제 API 사용량이 발생합니다.

```bash
npm run benchmark -- --run --seeds tmdb:126238,tmdb:43838 --language ko --compare-select gpt-5.4-mini,gpt-5.6-terra --out work/compare-01.json
```

`--out` 보고서는 단계별 시간, 실제 호출 모델, 추천 이유와 근거, 추정 비용을 담습니다. 서명된 준비 토큰과 API 키는 출력하지 않습니다. `curationFallback: true`라면 최종 판단이, `writingFallback: true`라면 추천 이유 작성 일부가 실패해 이전 지침을 사용한 것이므로 그 결과를 해당 단계의 정상 결과로 평가하면 안 됩니다. 이미 있는 출력 파일은 덮어쓰지 않으므로 다음 실험에는 새 파일명을 씁니다.

시간은 `preparation.wallMs`(후보·자료 준비), 각 실행의 `timings.selectionMs`(판단), `timings.writingMs`(병렬 글쓰기)로 확인합니다. `phases`에 적힌 개별 호출 시간은 서로 겹칠 수 있으므로 합산하지 않습니다. 후보부터 전부 수행한 시간은 `preparation.wallMs + 해당 실행의 wallMs`입니다.

이 벤치마크는 백엔드 단계 비교용이며 화면의 백그라운드 시작 시점을 모사하지 않습니다. 서비스 화면은 안정된 영화 선택·상세 열기·직접 추가·예비 후보 소진 후 유휴 시점에 후보와 자료뿐 아니라 비평적 판단까지 미리 진행합니다. 판단을 재사용하려면 선택 영화, 모델·프롬프트, 추천 제외 조건이 일치해야 합니다. 준비가 끝난 상태에서 버튼을 누르면 주로 병렬 글쓰기만 기다립니다. 준비가 진행 중이면 남은 시간도 필요합니다. 선택 변경이나 화면 숨김은 채택하지 않은 작업을 취소하지만 이미 진행된 호출에는 비용이 발생할 수 있습니다. 실제 클릭 후 체감 시간은 로컬 화면에서 별도로 확인합니다.

후보와 자료를 별도로 보관한 뒤 최종 프롬프트만 바꿀 수도 있습니다.

```bash
npm run benchmark -- --run --seeds tmdb:126238,tmdb:43838 --prepare-only --save-preparation work/pool-01.json --out work/prepare-01.json
npm run benchmark -- --run --seeds tmdb:126238,tmdb:43838 --preparation work/pool-01.json --select-model gpt-5.6-terra --out work/select-01.json
```

첫 실행 후 `curationPromptAdditions.curate`를 수정하고 두 번째 명령의 출력 파일명을 바꿔 다시 실행하면 같은 후보·자료에서 프롬프트 효과를 비교합니다. 준비 파일은 6시간 동안 유효하며, 선택 영화·언어·초안/검색 설정이 바뀌면 다시 준비해야 합니다. `work/pool-01.json`은 로컬의 비공개 중간 파일이며 공유용 보고서가 아닙니다.

`--profile baseline`, `--draft-model`, `--draft-reasoning`, `--select-reasoning` 등으로 파일 변경 없이 한 실행의 설정만 덮어쓸 수 있습니다. 전체 옵션은 `npm run benchmark -- --help`에서 확인합니다. 상세 설명 단계는 이 벤치마크에서 호출하지 않습니다.

모델 지원 범위와 가격은 [OpenAI 모델 문서](https://developers.openai.com/api/docs/models)를 기준으로 확인합니다. 현재 문서상 5.6 Terra/Luna는 `none`, `low`, `medium`, `high`, `xhigh`, `max`를 지원하고, 5.4-mini는 `none`, `low`, `medium`, `high`, `xhigh`를 지원합니다.
