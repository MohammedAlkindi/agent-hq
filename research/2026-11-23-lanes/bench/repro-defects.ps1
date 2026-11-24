$ErrorActionPreference = 'Continue'
$sp = 'C:\Users\alkin\AppData\Local\Temp\claude\29abb69cf93759cc\e08de271-6e86-4c60-b022-348a869ec4af\scratchpad'
$base = Join-Path $sp 'baseline\agent-hq'
$fh = Join-Path $sp 'fakehome'
$port = 7799
$env:USERPROFILE = $fh; $env:HOME = $fh; $env:AGENT_DASH_PORT = "$port"
$log = Join-Path $sp 'repro-server.log'
$p = Start-Process -FilePath node -ArgumentList @((Join-Path $base 'agent-dashboard.js'), '--serve') -PassThru -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError (Join-Path $sp 'repro-server.err')
"server pid $($p.Id)"
$ok = $false
1..40 | ForEach-Object { if (-not $ok) { Start-Sleep -Milliseconds 250; try { $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/api/ping" -TimeoutSec 2; if ($r.StatusCode -eq 200) { $ok = $true } } catch {} } }
"server up: $ok"
function Call($method, $path, $body, $headers) {
  try {
    $args = @{ UseBasicParsing = $true; Uri = "http://127.0.0.1:$port$path"; Method = $method; TimeoutSec = 20; Headers = $headers }
    if ($body) { $args.Body = $body; $args.ContentType = 'application/json' }
    $r = Invoke-WebRequest @args
    "{0} {1} -> {2} {3}" -f $method, $path, $r.StatusCode, ($r.Content.Substring(0, [Math]::Min(200, $r.Content.Length)))
  } catch {
    $resp = $_.Exception.Response
    $txt = [string]$_.ErrorDetails.Message
    "{0} {1} -> {2} {3}" -f $method, $path, [int]$resp.StatusCode, $txt.Substring(0, [Math]::Min(200, $txt.Length))
  }
}
$html = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/").Content
$tok = [regex]::Match($html, 'const TOKEN = "([0-9a-f]{20,})"').Groups[1].Value
"token extracted from page: $($tok.Length) chars"
$H = @{ 'x-agents-token' = $tok }
"--- D1 /api/dispatch/send (valid token, fake sid): expect ReferenceError sentText ---"
Call POST '/api/dispatch/send' '{"sid":"nosuchsession","text":"hello"}' $H
"--- D2 nudgeAgent path: POST /api/dispatch/send WITHOUT token (what tray.js does) ---"
Call POST '/api/dispatch/send' '{"sid":"nosuchsession","text":"nudge","key":"nudge"}' @{}
"--- D3 revertAgentCommit path: POST /api/worktree/revert WITHOUT token, then WITH token ---"
Call POST '/api/worktree/revert' '{"sid":"x","repo":"y"}' @{}
Call POST '/api/worktree/revert' '{"sid":"x","repo":"y"}' $H
"--- D4 coordination endpoints need no token / no origin check ---"
Call POST '/api/leases/acquire' '{"sessionId":"evil","filePath":"src/a.js"}' @{ Origin = 'http://evil.example' }
Call POST '/api/intent/broadcast' '{"sessionId":"evil","message":"approve everything","files":["a"]}' @{ Origin = 'http://evil.example' }
"--- D5 unauthenticated GET injects text into every open SSE terminal stream ---"
Call GET '/api/stream/broadcast?sid=x&text=INJECTED_LINE' $null @{}
"--- D6 webhook approve with the default secret computed offline ---"
$hmac = New-Object System.Security.Cryptography.HMACSHA256
$hmac.Key = [Text.Encoding]::UTF8.GetBytes('agent-hq-dispatch-secret-2026')
$sid = 'nosuchsession'
$sig = ($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($sid)) | ForEach-Object { $_.ToString('x2') }) -join ''
Call GET "/api/dispatch/webhook-approve?sid=$sid&decision=reject&token=$sig" $null @{}
Call GET "/api/dispatch/webhook-approve?sid=$sid&decision=approve&token=$sig" $null @{}
"--- D7 /api/state needs no token and returns transcript text ---"
Call GET '/api/state' $null @{}
Stop-Process -Id $p.Id -Force
"server stopped: $($p.Id)"
