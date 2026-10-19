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
foreach ($port in 47001, 47002) {
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
  & $fence $fenced 47001
  if ($LASTEXITCODE -ne 0) { throw 'The fence failed' }
  Expect $fenced '127.0.0.1' 47001 28
  Expect $fenced '[::1]' 47001 28
  Expect $fenced '127.0.0.1' 47002 7
  Expect $fenced '[::1]' 47002 7
  Expect "$env:WINDIR\System32\curl.exe" '127.0.0.1' 47002 28

  # Again, with nothing shared: it replaces the last.
  & $fence $fenced
  if ($LASTEXITCODE -ne 0) { throw 'The fence failed' }
  Expect $fenced '127.0.0.1' 47001 7
  Expect $fenced '[::1]' 47001 7
} finally {
  foreach ($listener in $listeners) { $listener.Stop() }
}
