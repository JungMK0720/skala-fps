<!--
  Date: 06NOV2026
  Author: Minkyu Jung
  Purpose: 서울 서버의 안전한 생성·접속·비용 알림·철거 절차와 현재 중계 서비스의 한계를 설명한다.
-->
# 서울 게임 서버 운영

`docs/PRODUCT_PLAN.md` §6·§7.2의 AWS 부분이다. **도메인을 사기 전에는 apply하지 않는다.** 정적 사이트·로그인·결제·로비는 Cloudflare, 데이터베이스는 기존 Supabase에 남는다. 이 코드는 기존 URL이나 운영 서버를 바꾸지 않는다.

## 지금 실행하는 서비스

기본 `service_command`는 의존성 없는 기존 Node 중계 어댑터 `server/relay/src/node.js`다. **서버 판정 게임 서버가 아니다.** 방장 브라우저가 판정하며, 프로세스를 재시작하면 메모리의 방이 사라진다. 검토된 서버 판정 구현이 병합되면 `repo_ref`와 `service_command`를 함께 바꾼다. 새 서비스는 `127.0.0.1:8788`에서 받아야 한다. 추가 패키지·빌드가 필요한 구현이라면 이 부트스트랩을 먼저 수정해야 한다. 현재 템플릿은 npm 의존성을 설치하지 않는다.

브라우저는 계속 Cloudflare 중계 주소를 쓴다. `game.<도메인>`은 TLS·건강 확인까지 준비하는 별도 주소이고 자동으로 방을 이전하지 않는다. 테스트 방 없이 `relay.url`을 AWS로 돌리지 않는다.

## 준비

- Terraform 1.9 이상 2.0 미만, AWS CLI v2, Session Manager 플러그인.
- 서울 `ap-northeast-2`의 **기본 VPC와 기본 공용 서브넷**. 삭제한 계정은 먼저 복구한다. EC2/SSM/IAM/SNS/CloudWatch/Budgets/EIP 관리 권한이 있는 운영자 자격 증명. 키는 파일·저장소·tfvars에 쓰지 말고 `aws configure sso` 등을 사용한다.
- 실제 도메인, 도메인 관리 권한, 메일을 받는 운영자 이메일. 공개 HTTPS 저장소와 검토한 배포 커밋(토큰을 repo_url에 넣지 않는다).
- AWS 계정은 유료 플랜이고 결제 수단이 활성화되어야 한다. 지원금 신청·승인과 과금 방지는 별개다.

## 생성

저장소 루트에서 아래처럼 실행한다. `example.io`와 이메일은 **실제 값으로** 바꾼다.

```powershell
aws sso login
terraform -chdir=infra/aws init
terraform -chdir=infra/aws plan -out=launch.tfplan -var='domain=example.io' -var='budget_email=ops@example.io' -var='repo_ref=<검토한-커밋-해시>'
terraform -chdir=infra/aws apply launch.tfplan
terraform -chdir=infra/aws output
```

반복 운영은 무시되는 `infra/aws/terraform.tfvars`에 비밀이 아닌 값만 보관해도 된다. 상태 파일에는 운영 정보가 있으므로 안전하게 백업한다. 이 초기 구성은 **로컬 상태**다. 두 명이 동시에 apply하지 말고, 공동 운영 전 암호화된 원격 상태와 잠금을 마련한다. `.terraform.lock.hcl`은 공급자 버전·체크섬 고정용이므로 보관한다.

1. 출력 `public_ip`를 `game.<도메인>`의 A 레코드에 넣고 **DNS only(회색 구름)**로 둔다. Cloudflare 프록시/캐시를 거치지 않는다. AAAA는 만들지 않는다.
2. SNS의 구독 확인 이메일에서 **Confirm subscription**을 누른다. 예산 알림은 SNS와 별개로 Budgets가 직접 메일을 보낸다.
3. 출력 `ssm_command`로 들어가 아래를 확인한다. **인바운드 22번은 열지 않는다.**

```sh
sudo cloud-init status --wait
sudo systemctl status fps caddy amazon-ssm-agent
sudo journalctl -u fps -u caddy --since '-15 minutes'
curl --fail http://127.0.0.1:8788/health
```

외부 PC에서 `curl https://game.<도메인>/health`가 정상인지 본다. DNS 전파 전에는 Caddy 인증서 발급이 실패할 수 있다. DNS가 맞으면 자동 재시도하며, 필요하면 SSM에서 `sudo systemctl restart caddy` 한다. Caddy는 80에서 HTTPS 전환/인증서 검증을 받고 443에서 WSS를 포함해 Node로 프록시한다. 서비스는 비특권 전용 계정으로 동작하고 IMDSv2를 강제한다. SSM·부트스트랩 다운로드·인증서 갱신을 위해 인터넷 아웃바운드는 허용한다.

`repo_ref`/명령/템플릿 변경은 EC2를 교체하고 EIP를 새 서버에 다시 연결한다. 교체 동안 접속이 끊긴다. 데이터는 Node 메모리 외에 남기지 않는 현재 중계 기준이다. EBS는 종료 시 삭제되며 프로덕션 영속 데이터를 여기에 두지 않는다. 운영 변경 전 접속을 비우고 필요 시 상태·로그를 따로 백업한다.

## 알림과 예상 비용

| 자원·기준 | 월 추정(USD, 730시간) | 비고 |
|---|---:|---|
| EC2 t4g.small 서울 | 약 15~20 | arm64, 버스트 CPU. 실제 단가는 콘솔 확인 |
| gp3 12 GB | 약 1.2 | 루트 볼륨 암호화 |
| 공인 IPv4 1개 | 약 3.65 | 시간당 $0.005, 정지해도 할당되어 있으면 과금 |
| CloudWatch 경보 2개·SNS 메일·예산 알림 | 소액(보통 $1 미만) | 무료 구간·사용량에 따라 다름 |
| 서울 인터넷 송신 | 약 $0.126/GB | 무료 구간·부가세 제외, 트래픽에 비례 |
| 기본 예산 | **$40** | 계정 전체, 지원금 차감 전 비용 기준 |

이는 구매 견적이 아니라 운영 계획용 추정이다. [EC2 요금](https://aws.amazon.com/ec2/pricing/on-demand/), [EBS 요금](https://aws.amazon.com/ebs/pricing/), [IPv4 요금](https://aws.amazon.com/vpc/pricing/)에서 적용 시점에 확인한다. t4g의 지속 CPU 사용에는 버스트 크레딧 추가 요금이 날 수 있다.

기획서 §7의 혼합 구성 총액(환율 $1=1,400원): 하루 300명 약 **9.5만 원/월**(AWS 몫 약 5만 원), 3,000명 약 **57만 원**, 3만 명 약 **490만 원**. 대부분은 송신량이고 인스턴스 하나의 처리 용량을 보장하는 표가 아니다. 현재 relay와 서버 판정 구현의 트래픽은 다르므로 이전 뒤 실측한다. 지원금은 보통 1~2년 기한이며 만료·소진 후 정상 과금된다.

- CPU 평균 80% 초과가 10분 지속되거나 EC2 상태 검사 실패 시 SNS 메일, 복구 시에도 메일.
- 월 실제 비용이 $40의 **50%($20)·80%($32)·100%($40)**를 넘으면 이메일. 계정 전체 비용을 잡고 크레딧/환불을 제외해 지원금 때문에 경고가 사라지지 않게 한다.
- **예산 알림은 지출 상한·즉시 탐지·자동 정지가 아니다.** 비용 반영이 늦고 초과 과금될 수 있다. 첫날 Billing → Budgets 설정·수신 메일을 확인한다. 이 구성에는 게임 틱 지연/접속 수/프로세스 가용성 경보가 없으므로 서버 판정 도입 때 그 지표를 추가한다.

## 철거 / 롤백

1. 브라우저를 기존 Cloudflare relay로 돌리고 진행 중인 방을 비운다. 정적 도메인만 이전한 상태라면 브라우저 설정 변경은 없다.
2. `terraform -chdir=infra/aws plan -destroy`를 검토한 뒤 아래 실행(생성 때와 같은 변수 파일/값 필요).

```powershell
terraform -chdir=infra/aws destroy -var='domain=example.io' -var='budget_email=ops@example.io'
```

3. `game.` DNS 레코드를 삭제한다. EIP/EC2/EBS/SNS/Budgets가 제거됐는지 콘솔로 확인한다. 기본 VPC는 삭제하지 않는다. 지원금 만료 전에 비용을 다시 확인한다.
4. 소유자 기록용으로 상태 백업과 청구서를 보관하고, 다른 사람이 남겨 둔 자원을 임의로 지우지 않는다.
