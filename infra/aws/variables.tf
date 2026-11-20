# Date: 06NOV2026
# Author: Minkyu Jung
# Purpose: 서버 크기·도메인·배포 원본·예산 알림의 운영 입력을 정의한다.
variable "project" {
  type        = string
  default     = "skala-fps"
  description = "모든 AWS 자원의 project 태그와 이름 접두사"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,29}$", var.project))
    error_message = "project는 소문자로 시작하는 30자 이하 영문·숫자·하이픈입니다."
  }
}

variable "instance_type" {
  type        = string
  default     = "t4g.small"
  description = "arm64 AMI와 호환되는 인스턴스 종류"
}

variable "domain" {
  type        = string
  description = "구매한 게임 도메인(예: example.io), 프로토콜·경로 제외"
  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z][a-z0-9-]*$", var.domain))
    error_message = "domain은 소문자 DNS 호스트 이름이어야 합니다."
  }
}

variable "game_server_host" {
  type        = string
  default     = ""
  description = "비우면 game.<domain>. Caddy 인증서를 발급할 실제 호스트"
  validation {
    condition     = var.game_server_host == "" || can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z][a-z0-9-]*$", var.game_server_host))
    error_message = "game_server_host는 빈 문자열 또는 소문자 DNS 호스트 이름입니다."
  }
}

variable "budget_email" {
  type        = string
  description = "SNS 장애 알림과 예산 50·80·100% 알림 수신 이메일"
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.budget_email))
    error_message = "수신 가능한 이메일 주소를 넣으세요."
  }
}

variable "monthly_budget_usd" {
  type        = number
  default     = 40
  description = "계정 전체 월 비용 경보 기준(USD). 지출 상한이나 자동 종료가 아님"
  validation {
    condition     = var.monthly_budget_usd > 0
    error_message = "월 예산은 0보다 커야 합니다."
  }
}

variable "repo_url" {
  type        = string
  default     = "https://github.com/JungMK0720/skala-fps.git"
  description = "서버가 인증 없이 읽을 수 있는 공개 HTTPS 저장소 URL"
  validation {
    condition     = can(regex("^https://[A-Za-z0-9._~:/-]+$", var.repo_url))
    error_message = "인증 정보·공백 없는 HTTPS 저장소 URL을 넣으세요."
  }
}

variable "repo_ref" {
  type        = string
  default     = "main"
  description = "배포할 태그·브랜치·커밋. 운영은 검토한 커밋 해시 권장"
  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._/-]*$", var.repo_ref))
    error_message = "repo_ref는 영숫자로 시작하고 공백·셸 기호를 포함하지 않아야 합니다."
  }
}

variable "service_command" {
  type        = string
  default     = "/usr/local/bin/node /opt/fps/server/relay/src/node.js --host 127.0.0.1 --port 8788"
  description = "systemd ExecStart. 127.0.0.1:8788에서 듣는 Node 서비스의 절대 경로 명령"
  validation {
    condition     = startswith(var.service_command, "/") && length(regexall("[\\r\\n]", var.service_command)) == 0
    error_message = "서비스 명령은 절대 경로로 시작하는 한 줄이어야 합니다."
  }
}
