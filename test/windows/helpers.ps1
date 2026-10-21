# The Windows guest's helpers, built as its bootstrap builds them, and the
# fence tried on real loopback connections: a copy of curl.exe, fenced, may
# reach only the ports it's given, and curl.exe itself is untouched. Run as
# an administrator, as the guest's entry runs as SYSTEM.

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$src = Join-Path $PSScriptRoot '..\..\apps\runner\src\machine\windows'
$out = Join-Path $env:RUNNER_TEMP 'nibblet-helpers'
New-Item -ItemType Directory -Force -Path $out | Out-Null

$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
foreach ($helper in Get-ChildItem "$src\*.cs") {
  $exe = Join-Path $out "nibblet-$($helper.BaseName).exe"
  & $csc /nologo /target:exe "/out:$exe" $helper.FullName
  if ($LASTEXITCODE -ne 0) { throw "Building $($helper.Name) failed" }
  Write-Host "built $($helper.Name)"
}

$fence = Join-Path $out 'nibblet-fence.exe'
$fenced = Join-Path $out 'fenced.exe'
Copy-Item "$env:WINDIR\System32\curl.exe" $fenced

$listeners = @()
foreach ($port in 18431, 18432) {
  foreach ($address in [Net.IPAddress]::Loopback, [Net.IPAddress]::IPv6Loopback) {
    $listener = [Net.Sockets.TcpListener]::new($address, $port)
    $listener.Start()
    $listeners += $listener
  }
}

# curl times out (28) on a connection that's made, since nothing answers;
# it couldn't connect (7) when the fence stops it.
function Expect($program, $hostname, $port, $code) {
  & $program -s --max-time 2 "http://${hostname}:$port/" *> $null
  $got = $LASTEXITCODE
  $what = "$(Split-Path -Leaf $program) to ${hostname}:$port"
  if ($got -ne $code) { throw "$what ended $got, not $code" }
  Write-Host "$what ended $got, as it should"
}

try {
  & $fence $fenced 18431
  if ($LASTEXITCODE -ne 0) { throw 'The fence failed' }
  Expect $fenced '127.0.0.1' 18431 28
  Expect $fenced '[::1]' 18431 28
  Expect $fenced '127.0.0.1' 18432 7
  Expect $fenced '[::1]' 18432 7
  Expect "$env:WINDIR\System32\curl.exe" '127.0.0.1' 18432 28

  # Again, with nothing shared: it replaces the last.
  & $fence $fenced
  if ($LASTEXITCODE -ne 0) { throw 'The fence failed' }
  Expect $fenced '127.0.0.1' 18431 7
  Expect $fenced '[::1]' 18431 7
} finally {
  foreach ($listener in $listeners) { $listener.Stop() }
}
# Tailscale, fetched as the bootstrap fetches it, and started as tailscale.ts
# starts it: in userspace networking, on a pipe only an administrator could
# have made, which its CLI talks to.
$tailscale = Join-Path $env:RUNNER_TEMP 'tailscale'
& "$src\get-tailscale.ps1" -To $tailscale -Arch amd64
$pipe = '\\.\pipe\ProtectedPrefix\Administrators\Nibblets\tailscaled'
$state = Join-Path $env:RUNNER_TEMP 'tailscale-state'
New-Item -ItemType Directory -Force -Path $state | Out-Null
$daemon = Start-Process -FilePath "$tailscale\tailscaled.exe" -PassThru -NoNewWindow -RedirectStandardError "$state\tailscaled.log" -ArgumentList '--tun=userspace-networking', "--statedir=$state", "--socket=$pipe", '--socks5-server=127.0.0.1:1055', '--outbound-http-proxy-listen=127.0.0.1:1055'
try {
  $said = ''
  for ($i = 0; $i -lt 60 -and -not ($said -match '"BackendState"'); $i++) {
    Start-Sleep -Seconds 1
    $said = (& "$tailscale\tailscale.exe" "--socket=$pipe" status --json 2>&1) -join "`n"
  }
  if ($said -notmatch '"BackendState":\s*"(\w+)"') {
    Get-Content "$state\tailscaled.log" -Tail 30 | Write-Host
    throw "tailscaled didn't answer on its pipe: $said"
  }
  Write-Host "tailscaled answered on its pipe: $($Matches[1])"
} finally {
  Stop-Process -Id $daemon.Id -Force -ErrorAction SilentlyContinue
}

# The last command's exit code isn't the script's: it got here, so it passed.
exit 0
