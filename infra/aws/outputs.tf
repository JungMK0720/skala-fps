# Date: 06NOV2026
# Author: Minkyu Jung
# Purpose: DNS 연결 주소와 SSH 없는 운영 접속 명령을 출력한다.
output "public_ip" {
  value       = aws_eip.game.public_ip
  description = "game_server_host의 DNS only A 레코드에 넣을 고정 IPv4"
}

output "ssm_command" {
  value       = "aws ssm start-session --target ${aws_instance.game.id} --region ap-northeast-2"
  description = "AWS CLI와 Session Manager 플러그인이 설치된 운영 PC에서 실행"
}

output "game_server_url" {
  value = "https://${local.game_server_host}"
}
