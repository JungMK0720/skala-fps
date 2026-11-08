# Date: 06NOV2026
# Author: Minkyu Jung
# Purpose: (Windows) 배치 파일 하나를 보이지 않는 별도 데스크톱에서 실행한다. 그 안에서 뜨는 콘솔·브라우저 창은
#          작업 중인 화면에 나타나지 못해 포커스·마우스를 가져가지 않는다. tools/qa/hidden.mjs가 부른다.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/qa/run-hidden.ps1 -Cwd <폴더> -Log <기록 파일> -Script <배치 파일>
#   종료 코드 = 배치 파일의 종료 코드. 표준 출력·오류는 모두 -Log 파일로 간다.
param(
  [Parameter(Mandatory = $true)][string]$Cwd,
  [Parameter(Mandatory = $true)][string]$Log,
  [Parameter(Mandatory = $true)][string]$Script
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SkalaHiddenDesk {
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr sa);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool CloseDesktop(IntPtr h);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
"@
$name = "skala-qa-$PID"
# GENERIC_ALL. 같은 창 묶음(WinSta0) 안의 새 데스크톱이라 관리자 권한이 필요 없다
$desk = [SkalaHiddenDesk]::CreateDesktop($name, [IntPtr]::Zero, [IntPtr]::Zero, 0, 0x10000000, [IntPtr]::Zero)
if ($desk -eq [IntPtr]::Zero) { throw "CreateDesktop 실패: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
try {
  $si = New-Object SkalaHiddenDesk+STARTUPINFO
  $si.cb = [Runtime.InteropServices.Marshal]::SizeOf($si)
  $si.lpDesktop = "WinSta0\$name"
  $si.dwFlags = 1          # STARTF_USESHOWWINDOW
  $si.wShowWindow = 0      # SW_HIDE
  $pi = New-Object SkalaHiddenDesk+PROCESS_INFORMATION
  $line = "`"$env:ComSpec`" /d /s /c `"`"$Script`" > `"$Log`" 2>&1`""
  $CREATE_NO_WINDOW = 0x08000000
  if (-not [SkalaHiddenDesk]::CreateProcess($env:ComSpec, $line, [IntPtr]::Zero, [IntPtr]::Zero, $false, $CREATE_NO_WINDOW, [IntPtr]::Zero, $Cwd, [ref]$si, [ref]$pi)) {
    throw "CreateProcess 실패: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  [void][SkalaHiddenDesk]::WaitForSingleObject($pi.hProcess, [uint32]::MaxValue)
  $code = 0
  [void][SkalaHiddenDesk]::GetExitCodeProcess($pi.hProcess, [ref]$code)
  [void][SkalaHiddenDesk]::CloseHandle($pi.hThread)
  [void][SkalaHiddenDesk]::CloseHandle($pi.hProcess)
  exit $code
} finally {
  [void][SkalaHiddenDesk]::CloseDesktop($desk)
}
