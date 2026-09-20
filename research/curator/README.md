# 큐레이터 평가

이 폴더에는 정답 영화 없이 추천 품질을 비교하는 고정 입력 조합만 둡니다. 현재 엔진은 `lib/server/curator`의 운영 코드와 동일하며, 별도 파일럿 엔진이나 스냅샷 자료를 사용하지 않습니다.

## 속도와 형식 확인

```sh
npm run benchmark:curator -- --case matter-and-sky
npm run benchmark:curator -- --run --case all --models gpt-5.6-terra --repeat 1 --out work/curator.json
```

`--run`이 없으면 외부 API를 호출하지 않습니다. 실제 실행은 성공률, 20초 내 완료율, 단계별 시간, 식별 복구 여부와 사용량을 기록합니다.

## 블라인드 품질 평가

```sh
npm run evaluate:curator-quality -- --run --case all --model gpt-5.6-terra --out work/curator-quality.json
npm run score:curator-quality -- --report work/curator-quality.json --ratings work/reviewer-1.json,work/reviewer-2.json,work/reviewer-3.json --out work/curator-quality-score.json
```

평가는 특정 추천작을 정답으로 삼지 않습니다. 입력 독해, 연결의 구체성, 발견 가치, 큐레이션 판단, 목록 구성, 신뢰성을 사람이 블라인드로 평가합니다. 결과 파일은 `work/`에 두며 저장소에는 커밋하지 않습니다.
