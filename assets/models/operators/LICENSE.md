<!--
  Date: 06NOV2026
  Author: Minkyu Jung
  Purpose: 대원 모델(operators.glb)의 원본 주소·받은 날짜·라이선스·해시와 만드는 방법을 기록한다.
-->
# 대원 모델 출처와 라이선스

`operators.glb`(약 654 KB)는 Quaternius **Ultimate Modular Men Pack**(2022-02)의 인물 네 개를 합쳐 줄인 파일이다. 받은 날짜: **2026-11-21**.

| 쓴 부분 | 원본 | 받은 주소 | 라이선스 표시 | sha256 |
|---|---|---|---|---|
| 몸·다리·발·SWAT 머리, 뼈대 62관절, 동작 7개 | SWAT | https://static.poly.pizza/713f6535-f4f3-4367-a4c6-ced126ae0936.glb (https://poly.pizza/m/Btfn3G5Xv4) | Public Domain (CC0) | `a835107bac833eb916c494e10997ae1709e85957ea6f6c59ace3c9a66f6d1fec` |
| 맨머리(살·눈·눈썹) | Business Man(Suit) | https://static.poly.pizza/e599abbe-7d73-488c-9d7e-3ead281e705c.glb (https://poly.pizza/m/JFrLIKqvCH) | Public Domain (CC0) | `82b81257c1e94cd9ee48cb1dcbe5ff506e81c9ce67cd0c5af542d8712dca546e` |
| 안전모 | Worker | https://static.poly.pizza/3a5f3056-ffe6-42eb-bd52-122afcbd22b2.glb (https://poly.pizza/m/Yg2bQZO6Hj) | Public Domain (CC0) | `9c28614f465b7dc105f908c20c22fc045f4b07caf8c5ef0e9f8049eceb6dd38d` |
| 챙 넓은 모자·띠 | Farmer | https://static.poly.pizza/81f2f0cf-6f53-4b57-92ea-dba0928620f2.glb (https://poly.pizza/m/7pn3R6hPvE) | Public Domain (CC0) | `f7ae6e2596c6521d296fa5948783f1dac717807456ce5355e48719e81d15e9a6` |

## 라이선스 근거

- 제작자 페이지 https://quaternius.com/packs/ultimatemodularcharacters.html 의 License 칸: **CC0**(https://creativecommons.org/publicdomain/zero/1.0/). 같은 페이지의 버전 기록: https://github.com/Quaternius/quaternius.github.io/blob/c219437bd230a5e66e1b523dbd8ee2bcf0dfb90b/packs/ultimatemodularcharacters.html (197행, 2026-10-16 커밋).
- poly.pizza 묶음 https://poly.pizza/bundle/Ultimate-Modular-Men-Pack-ZiH8muWqwQ : "Licence: Public Domain (CC0)", 위 네 모델 페이지도 모두 CC0.
- 같은 팩의 여성 인물(Soldier)은 poly.pizza가 CC-BY로 표시해 쓰지 않았다.
- Quaternius가 2026-08-28에 낸 새 라이선스는 소급하지 않는다(그 문서 7절). 받은 시점의 CC0 법률 문구는 옆의 `CC0-1.0.txt`(creativecommons.org legalcode.txt 원문)다.
- 팩 안의 `License.txt`(Google Drive)는 받는 날 Drive 할당량 초과로 받지 못했다. 페이지 표시와 위 기록으로 대신한다.

## 바꾼 것

- 네 원본은 뼈 이름·순서·바인드 행렬이 같다. 다른 인물의 머리 부품을 SWAT 뼈대에 그대로 옮겨 붙였다.
- 동작은 Idle·Walk·Run·Run_Back·Run_Left·Run_Right·Death만 남겼다. UV를 뺐다(무늬 없는 단색 모델).
- 법선·가중치만 KHR_mesh_quantization으로 줄였다(위치는 float). three.js GLTFLoader가 따로 디코더 없이 읽는다.
- 색·팀 색·직접 만든 장비는 게임이 불러올 때 입힌다(`js/engine/operator-look.js`, `operator-gear.js`).

## 다시 만들기

```
cd tools/models
npm install
node build-operators.mjs <위 네 GLB를 SWAT.glb·Suit.glb·Worker.glb·Farmer.glb 이름으로 둔 폴더>
```

해시가 위 표와 다르면 도구가 멈춘다.
