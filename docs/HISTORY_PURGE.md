<!--
  Date: 06NOV2026
  Author: Minkyu Jung
  Purpose: 저장소 기록에서 이모트 음원을 지운 일(2026-11-21)의 기록. 무엇을 왜 지웠는지, 팀원이 할 일, 다시 들어오지 않게 막는 장치, GitHub 고객지원 요청 문안.
-->
# 저장소 기록에서 이모트 음원 지우기

## 1. 무엇을 왜

- 지운 파일: `audio/emotes/` 의 `takeL.bin`, `veggie.bin`, `crissCross.bin`, `creamCheese.bin`, `fromYou.bin`, `selfie.bin` (커밋 `d312d39`에서 들어옴).
- 이유: 출처와 사용 권리 기록이 없는 외부 음원이었다. 암호화했지만 풀이 키가 코드에 있어 누구나 들을 수 있었다. 상용 출시 전에 권리 문제를 없앤다(`docs/PRODUCT_PLAN.md` 2절).
- 방법: `git filter-repo --invert-paths`로 모든 브랜치의 모든 커밋에서 위 6개 파일만 뺐다. 다른 파일과 커밋 내용은 그대로이고, 커밋 해시만 바뀌었다.
- 지우기 전 전체 백업 묶음은 소유자 PC의 `E:/backup/fps-history/`에 있다(공개하지 않는다).

## 2. 팀원이 할 일 (한 번)

기록을 다시 썼으므로 **예전 클론은 쓰지 않는다.**

1. 예전 클론에 아직 올리지 않은 작업이 있으면 패치로 뽑아 둔다.
   ```bash
   git format-patch origin/main..내브랜치 -o ~/my-patches
   ```
2. 새로 받는다.
   ```bash
   git clone https://github.com/JungMK0720/skala-fps.git
   ```
3. 뽑아 둔 패치를 새 클론에 적용한다.
   ```bash
   git switch -c 내브랜치 && git am ~/my-patches/*.patch
   ```
4. 예전 클론은 지운다. **예전 클론에서 `git pull` 후 `git push`를 하면 음원이 되살아난다.**

## 3. 다시 들어오지 않게 막는 장치

| 장치 | 위치 | 하는 일 |
|---|---|---|
| push 검사(내 PC) | `tools/hooks/pre-push` | push하는 커밋에 지운 음원이 있으면 막는다. 설치: `cp tools/hooks/pre-push .git/hooks/pre-push && chmod +x .git/hooks/pre-push` |
| 기록 감시(GitHub) | `.github/workflows/history-guard.yml` | push·PR마다 저장소에 지운 음원이 다시 생기면 실패해서 소유자에게 메일이 간다 |

`core.hooksPath`를 바꾸지 않는다. 바꾸면 `.git/hooks`에 있는 다른 훅(commit-msg)이 꺼진다.

## 4. GitHub 고객지원 요청 (소유자가 보낸다)

GitHub는 닫힌 PR의 옛 커밋과 캐시된 화면을 따로 보관한다. 브랜치에서 지워도 옛 커밋 주소로는 한동안 열릴 수 있다. 아래 문안으로 https://support.github.com/contact 에 요청한다(영어).

```text
Subject: Remove cached views and pull request refs for rewritten history (JungMK0720/skala-fps)

Hello,

I rewrote the history of my public repository JungMK0720/skala-fps with git filter-repo
to remove six audio files whose distribution rights I could not confirm:

  audio/emotes/takeL.bin        blob 6d5370e1ebf76f4046f0a004d38de9f5f9ae387d
  audio/emotes/veggie.bin       blob e9c2afc3c2b76f1fcfbdb1e1a038c7134d6dfd25
  audio/emotes/crissCross.bin   blob a3b264007729d240285c8e6dbe7fcdc94314123f
  audio/emotes/creamCheese.bin  blob a5a488ccb0adc219009c9be8401c31cefa514001
  audio/emotes/fromYou.bin      blob c82b73f80621205f222294ee89f44109eb7f0f98
  audio/emotes/selfie.bin       blob d071caed0cddb015de4ff5a8d5c8db08d2cd4154

They were added in the original commit d312d39. All branches have been force-pushed.
Please remove cached views of the old commits and any pull request refs that still
reference these objects, and run garbage collection on the repository.

Thank you.
```

## 5. 확인

```bash
# 저장소 전체에서 지운 음원 blob이 없어야 한다(출력 없음)
git rev-list --objects --all | grep -E "audio/emotes/.*\.bin"
```
