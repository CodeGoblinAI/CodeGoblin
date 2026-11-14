# Shorthand for a tour of the real window:  rt.ps1 <pid> <title> <name-prefix> step [step...]
# A step is  k:<keys>  (type),  s:<name>  (picture into output\shots),  w:<ms>  (wait).
param([string]$ProcessId, [string]$Title, [string]$Prefix)
$tool = Join-Path $PSScriptRoot 'real-terminal.ps1'
$out = Join-Path $PSScriptRoot '..\..\output\shots'
New-Item -ItemType Directory -Force $out | Out-Null
foreach ($step in $args) {
  $kind = $step.Substring(0, 2); $value = $step.Substring(2)
  if ($kind -eq 'k:') { powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tool keys $ProcessId $value | Out-Null; Start-Sleep -Milliseconds 700 }
  elseif ($kind -eq 's:') { powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tool shot $Title (Join-Path $out "$Prefix-$value.png") | Out-Null }
  elseif ($kind -eq 'w:') { Start-Sleep -Milliseconds ([int]$value) }
}
"ok"
