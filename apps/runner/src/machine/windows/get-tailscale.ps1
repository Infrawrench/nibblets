# Tailscale's latest tailscale.exe and tailscaled.exe, taken out of its
# installer rather than installed, so there's no service of its own: the
# entry runs it (see tailscale.ts). Run by the guest's bootstrap.
#
#   get-tailscale.ps1 -To C:\Nibblets\tailscale -Arch amd64

param([Parameter(Mandatory)] [string] $To, [Parameter(Mandatory)] [string] $Arch)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$work = Join-Path ([IO.Path]::GetTempPath()) "nibblet-tailscale-$PID"
New-Item -ItemType Directory -Force -Path $work | Out-Null

function Get-Download($url, $to) {
  for ($i = 1; $i -le 5; $i++) {
    try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $to; return } catch { Start-Sleep -Seconds (5 * $i) }
  }
  throw "Couldn't download $url"
}

try {
  Get-Download 'https://pkgs.tailscale.com/stable/?mode=json' "$work\packages.json"
  $msi = (Get-Content "$work\packages.json" -Raw | ConvertFrom-Json).MSIs.$Arch
  if (-not $msi) { throw "Tailscale has no installer for $Arch" }
  Get-Download "https://pkgs.tailscale.com/stable/$msi" "$work\tailscale.msi"
  $signed = Get-AuthenticodeSignature "$work\tailscale.msi"
  if ($signed.Status -ne 'Valid' -or $signed.SignerCertificate.Subject -notmatch 'O="?Tailscale Inc') {
    throw "Tailscale's installer wasn't signed by Tailscale ($($signed.Status), $($signed.SignerCertificate.Subject))"
  }
  # An administrative install: its files, unpacked, and nothing else.
  $unpack = Start-Process msiexec.exe -ArgumentList '/a', "`"$work\tailscale.msi`"", '/qn', "TARGETDIR=`"$work\unpacked`"" -Wait -PassThru
  if ($unpack.ExitCode -ne 0) { throw "Unpacking Tailscale's installer failed ($($unpack.ExitCode))" }
  New-Item -ItemType Directory -Force -Path $To | Out-Null
  foreach ($exe in 'tailscale.exe', 'tailscaled.exe') {
    $found = Get-ChildItem -Path "$work\unpacked" -Recurse -Filter $exe | Select-Object -First 1
    if (-not $found) { throw "Tailscale's installer had no $exe" }
    Copy-Item $found.FullName (Join-Path $To $exe) -Force
  }
  Write-Host "Tailscale's $msi unpacked to $To"
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
