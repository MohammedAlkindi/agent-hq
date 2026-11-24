$ErrorActionPreference = 'Continue'
$sp = 'C:\Users\alkin\AppData\Local\Temp\claude\29abb69cf93759cc\e08de271-6e86-4c60-b022-348a869ec4af\scratchpad'
$base = Join-Path $sp 'baseline\agent-hq'
$fh = Join-Path $sp ("fakehome-wake-" + (Get-Date -Format 'HHmmss'))
$proj = Join-Path $fh '.claude\projects\C--fake'
New-Item -ItemType Directory -Force $proj | Out-Null
$sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
$t0 = (Get-Date).AddMinutes(-30).ToUniversalTime().ToString('o'); $t1 = (Get-Date).AddMinutes(-29).ToUniversalTime().ToString('o')
$l1 = '{"type":"user","timestamp":"' + $t0 + '","cwd":"C:\\fake","message":{"role":"user","content":"hello"}}'
$l2 = '{"type":"assistant","timestamp":"' + $t1 + '","cwd":"C:\\fake","message":{"id":"m1","model":"claude-opus-5-5","role":"assistant","content":[{"type":"text","text":"All done. Want me to continue?"}],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":5}}}'
Set-Content -Path (Join-Path $proj "$sid.jsonl") -Value @($l1, $l2) -Encoding utf8
$env:USERPROFILE = $fh; $env:HOME = $fh; $env:AGENT_DASH_PORT = '7798'
$p = Start-Process -FilePath node -ArgumentList @((Join-Path $base 'agent-dashboard.js'), '--serve') -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $sp 'wake-server.log') -RedirectStandardError (Join-Path $sp 'wake-server.err')
$ok = $false
1..40 | ForEach-Object { if (-not $ok) { Start-Sleep -Milliseconds 250; try { if ((Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:7798/api/ping' -TimeoutSec 2).StatusCode -eq 200) { $ok = $true } } catch {} } }
Start-Sleep -Seconds 6   # let the roster refresh finish
$html = (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:7798/').Content
$tok = [regex]::Match($html, 'const TOKEN = "([0-9a-f]{20,})"').Groups[1].Value
$st = (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:7798/api/state').Content | ConvertFrom-Json
"roster ok: $($st.roster.ok); sessions listed: $($st.sessions.Count); state of fake session: $($st.sessions[0].state) kind: $($st.sessions[0].kind)"
try {
  $r = Invoke-WebRequest -UseBasicParsing -Method POST -Uri 'http://127.0.0.1:7798/api/prompt' -Headers @{ 'x-agents-token' = $tok } -ContentType 'application/json' -Body (@{ target = $sid; text = 'continue' } | ConvertTo-Json) -TimeoutSec 30
  "POST /api/prompt (wake a closed/finished Claude session) -> $($r.StatusCode) $($r.Content)"
} catch { "POST failed: $($_.ErrorDetails.Message)" }
Stop-Process -Id $p.Id -Force
"server stopped: $($p.Id)"
