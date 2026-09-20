# STRADA

STRADA는 선택한 영화들을 같은 비중으로 읽고, 문헌 맥락과 영화 지식을 결합해 다음 12편을 제안하는 영화 디깅 서비스입니다.

- Production: https://strada-film-discovery.vercel.app
- Repository: https://github.com/swjeon0/strada-film-discovery
- Runtime: Next.js 16, React 19, Node.js 22
- Storage: 계정이나 서버 사용자 DB 없이 브라우저 `localStorage`에 경로 저장
- Metadata: TMDB, 연결되지 않았을 때 Wikidata/Wikipedia
- Knowledge: 검수된 정규화 자료에서 빌드한 읽기 전용 검색 인덱스

## 로컬 실행

```sh
npm ci
cp .env.example .env.local
npm run dev
```

`.env.local`에 `OPENAI_API_KEY`와 `TMDB_READ_ACCESS_TOKEN`을 넣습니다. 비밀 키에는 `NEXT_PUBLIC_` 접두사를 붙이지 않습니다.

## 운영 추천 경로

추천 요청은 다음 순서로만 처리됩니다.

1. 선택 영화의 메타데이터를 확인합니다.
2. `research/knowledge/serving-index.json`에서 선택 영화와 관련 맥락을 한 번 조회합니다.
3. 메인 큐레이터가 정확히 12편과 짧은 연결 이유를 생성합니다.
4. TMDB 또는 로컬 카탈로그가 12편의 제목·연도·감독을 확인합니다.
5. 식별에 실패한 자리만 한 번 복구하고, 다시 12편 전체를 검증합니다.

메인 모델은 문헌에 나온 영화만 고르도록 제한되지 않습니다. 문헌은 해석의 근거와 경계를 제공하고, 모델의 영화 지식은 자료가 희박한 영화와 새로운 연결을 보완합니다. 문헌이 없는 연결은 AI 큐레이션으로 표시하며 출처를 붙이지 않습니다. 상세 설명은 포스터를 열 때 별도 모델 호출로 생성합니다.

모델, 추론 수준, 프롬프트 실험은 [config/README.md](config/README.md)에 정리되어 있습니다. 문헌 자료 구조와 추가 절차는 [research/knowledge/README.md](research/knowledge/README.md)에 있습니다.

## 문헌 갱신

```sh
npm run knowledge:build
npm run knowledge:embed -- --run
npm run knowledge:audit
npm run knowledge:test
```

`research/knowledge/records/*.json`에 원문 위치와 접근 범위를 확인한 자료만 추가합니다. 초록만 확보한 학술논문은 수집과 온라인 인덱스에서 제외됩니다. 원문 전문과 API 키는 저장소에 넣지 않습니다.

## 검증

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

추천 품질 실험은 기본적으로 외부 호출을 하지 않습니다. 실제 유료 실행에는 명시적으로 `--run`을 붙입니다.

```sh
npm run benchmark:curator -- --case matter-and-sky
npm run evaluate:curator-quality -- --case all
```

`main` 브랜치가 Vercel Production에 연결되어 있으며 표준 빌드는 `npm run build`입니다.
