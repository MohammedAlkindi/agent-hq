// run-tests.js - Full verification suite for Agent HQ Multi-Agent & 5-Frontier Evolution
const fs = require('fs');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const vm = require('vm');

const ROOT = __dirname;
const AGENT_DASH = path.join(ROOT, 'agent-dashboard.js');
const ADAPTERS_DIR = path.join(ROOT, 'adapters');
const UI_DIR = path.join(ROOT, 'agents-ui');
const WORLD_HTML = path.join(UI_DIR, 'world.html');
const WORKTREES_JS = path.join(ROOT, 'worktrees.js');
const DISPATCHER_JS = path.join(ROOT, 'dispatcher.js');
const POLICY_JSON = path.join(ROOT, 'dispatcher-policy.json');
const COORDINATION_JS = path.join(ROOT, 'coordination.js');
const KNOWLEDGE_JS = path.join(ROOT, 'knowledge.js');
const TEST_PORT = 7795;

const dashModule = require(AGENT_DASH);
const coordination = require(COORDINATION_JS);
const knowledge = require(KNOWLEDGE_JS);

let passed = 0;
let failed = 0;
const results = [];

function assert(condition, message) {
  if (condition) {
    passed++;
    results.push(`  [PASS] ${message}`);
    console.log(`  [PASS] ${message}`);
  } else {
    failed++;
    results.push(`  [FAIL] ${message}`);
    console.error(`  [FAIL] ${message}`);
  }
}

async function runCommand(cmd, args) {
  return new Promise((resolve) => {
    cp.execFile(cmd, args, { cwd: ROOT, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code || 1) : 0, stdout, stderr, error });
    });
  });
}

function fetchHttp(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function main() {
  console.log('====================================================');
  console.log(' Starting Agent HQ Multi-Agent & 5-Frontier QA Suite');
  console.log('====================================================\n');

  // --- 1. Syntax Verification ---
  console.log('--- 1. Syntax Verification ---');
  const dashCheck = await runCommand('node', ['--check', AGENT_DASH]);
  assert(dashCheck.code === 0, 'agent-dashboard.js syntax is valid');

  const wtCheck = await runCommand('node', ['--check', WORKTREES_JS]);
  assert(wtCheck.code === 0, 'worktrees.js syntax is valid');

  const dispCheck = await runCommand('node', ['--check', DISPATCHER_JS]);
  assert(dispCheck.code === 0, 'dispatcher.js syntax is valid');

  const adapterFiles = fs.readdirSync(ADAPTERS_DIR).filter((f) => f.endsWith('.js'));
  for (const f of adapterFiles) {
    const res = await runCommand('node', ['--check', path.join(ADAPTERS_DIR, f)]);
    assert(res.code === 0, `adapters/${f} syntax is valid`);
  }

  const uiJsFiles = fs.readdirSync(UI_DIR).filter((f) => f.endsWith('.js'));
  for (const f of uiJsFiles) {
    const res = await runCommand('node', ['--check', path.join(UI_DIR, f)]);
    assert(res.code === 0, `agents-ui/${f} syntax is valid`);
  }

  // --- 2. AudioContext Synthesizer Features (alerts.js & world.html) ---
  console.log('\n--- 2. AudioContext 8-Bit Synthesizer Verification ---');
  const alertsCode = fs.readFileSync(path.join(UI_DIR, 'alerts.js'), 'utf8');
  assert(alertsCode.includes('AudioContext') || alertsCode.includes('webkitAudioContext'), 'alerts.js utilizes Web Audio API AudioContext');
  assert(alertsCode.includes('chime(kind)'), 'alerts.js defines procedural chime() function');
  assert(alertsCode.includes('square') && alertsCode.includes('sawtooth'), 'alerts.js synthesizes 8-bit waveforms (square & sawtooth oscillators)');
  assert(alertsCode.includes('done') && alertsCode.includes('finish'), 'alerts.js contains finish fanfare arpeggio synthesis');
  assert(alertsCode.includes('ask') && alertsCode.includes('question'), 'alerts.js contains question ping rising pitch synthesis');
  assert(alertsCode.includes('warn') && alertsCode.includes('stuck'), 'alerts.js contains stuck/warn descending warning synthesis');
  assert(alertsCode.includes('hq-sound'), 'alerts.js persists sound preference to localStorage("hq-sound")');

  // Verify mock execution of chime in VM
  let vmSoundWorks = false;
  try {
    const mockContext = {
      window: {
        AudioContext: class {
          constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
          createOscillator() {
            return {
              type: 'sine',
              frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
              connect() {}, start() {}, stop() {}
            };
          }
          createGain() {
            return {
              gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} },
              connect() {}
            };
          }
        }
      },
      localStorage: { getItem() { return '1'; }, setItem() {} },
      $: () => ({ setAttribute() {}, addEventListener() {} }),
      toast: () => {},
      console
    };
    mockContext.window.webkitAudioContext = mockContext.window.AudioContext;
    vm.createContext(mockContext);
    vm.runInContext(alertsCode + '; AL.sound = true; chime("done"); chime("ask"); chime("warn"); chime("pr");', mockContext);
    vmSoundWorks = true;
  } catch (e) {
    console.error('VM AudioContext mock error:', e);
  }
  assert(vmSoundWorks, 'alerts.js AudioContext synthesizer executes cleanly under simulated audio environment');

  // --- 3. Frontend HTML, Avatars, Diff Modal & Terminal Drawer ---
  console.log('\n--- 3. Frontend HTML, Diff Modal & Terminal Drawer Validation ---');
  const htmlContent = fs.readFileSync(WORLD_HTML, 'utf8');
  assert(htmlContent.length > 50000, `world.html exists and has substantial size (${htmlContent.length} bytes)`);

  const scriptMatches = [...htmlContent.matchAll(/<script[\s\S]*?>([\s\S]*?)<\/script>/gi)];
  let scriptErrors = 0;
  scriptMatches.forEach((m, idx) => {
    const code = m[1].trim();
    if (!code) return;
    try {
      new vm.Script(code);
    } catch (e) {
      scriptErrors++;
      console.error(`Script tag ${idx + 1} compile error:`, e.message);
    }
  });
  assert(scriptErrors === 0, `All embedded scripts in world.html compile with zero syntax errors`);

  // Audio toggle in world.html
  assert(htmlContent.includes('id="audio-toggle"'), 'world.html contains #audio-toggle button in header');

  // Inline Git Diff Modal
  assert(htmlContent.includes('id="diff-modal"'), 'world.html contains #diff-modal dialog container');
  assert(htmlContent.includes('id="diff-body"'), 'world.html contains #diff-body container');
  assert(htmlContent.includes('id="diff-stats"'), 'world.html contains #diff-stats additions/deletions badge');
  assert(htmlContent.includes('id="diff-mode-unified"') && htmlContent.includes('id="diff-mode-split"'), 'world.html contains Unified and Side-by-side mode switchers');
  assert(htmlContent.includes('openDiffModal'), 'world.html implements openDiffModal() controller');
  assert(htmlContent.includes('closeDiffModal'), 'world.html implements closeDiffModal() with ESC and backdrop support');

  // In-Browser Live Log Terminal Drawer
  assert(htmlContent.includes('id="term-drawer"'), 'world.html contains #term-drawer live console panel');
  assert(htmlContent.includes('id="term-body"'), 'world.html contains #term-body log feed container');
  assert(htmlContent.includes('id="term-autoscroll"'), 'world.html contains #term-autoscroll toggle');
  assert(htmlContent.includes('openTerminalDrawer'), 'world.html implements openTerminalDrawer() controller');
  assert(htmlContent.includes('closeTerminalDrawer'), 'world.html implements closeTerminalDrawer() controller');

  // Creative Avatars
  const visualFeatures = [
    { key: 'zeroGFloat', name: 'Antigravity zero-G floating animation' },
    { key: 'zeroGShadow', name: 'Antigravity zero-G floating shadow' },
    { key: 'celestial', name: 'Antigravity celestial orbit glow / aura' },
    { key: 'stardust', name: 'Antigravity twinkling stardust particle effect' },
    { key: 'visor', name: 'Codex dark emerald cybernetic visor' },
    { key: 'matrix', name: 'Codex retro-futuristic CRT matrix phosphor terminal' },
    { key: 'crown', name: 'Claude signature royal crown prop' },
    { key: 'companion', name: 'Claude cheerful companion pet' },
    { key: 'watercooler', name: 'Office life interactive watercooler station' },
    { key: 'coffee', name: 'Office life steaming coffee mug prop' },
    { key: 'idleStretch', name: 'Lively idle stretch animation' },
    { key: 'c-celebrate-stars', name: 'Turn completion celebratory stars' },
    { key: 'pacing', name: 'Tool running / thinking pacing animation' },
    { key: 'harnessOf', name: 'Universal harness detection helper' }
  ];
  for (const feat of visualFeatures) {
    assert(htmlContent.includes(feat.key), `Visual feature: ${feat.name} (${feat.key}) present in world.html`);
  }

  // --- 4. Worktree Isolation Engine (worktrees.js) ---
  console.log('\n--- 4. Worktree Isolation Engine Validation ---');
  const wtModule = require(WORKTREES_JS);
  assert(typeof wtModule.listWorktrees === 'function', 'worktrees.js exports listWorktrees');
  assert(typeof wtModule.createWorktree === 'function', 'worktrees.js exports createWorktree');
  assert(typeof wtModule.mergeWorktree === 'function', 'worktrees.js exports mergeWorktree');
  assert(typeof wtModule.cleanupWorktree === 'function', 'worktrees.js exports cleanupWorktree');
  assert(typeof wtModule.getDiffForSession === 'function', 'worktrees.js exports getDiffForSession');

  // Test listWorktrees call
  const existingWts = await wtModule.listWorktrees();
  assert(Array.isArray(existingWts), `worktrees.listWorktrees() returns an array (found ${existingWts.length} worktrees)`);

  // Test createWorktree parameter validation
  const invalidCreate = await wtModule.createWorktree({});
  assert(invalidCreate.ok === false && invalidCreate.msg, 'createWorktree validates missing parameters safely');

  // --- 5. Level-1 Actionable Dispatcher (dispatcher.js & tray.js) ---
  console.log('\n--- 5. Level-1 Actionable Dispatcher Validation ---');
  const policy = JSON.parse(fs.readFileSync(POLICY_JSON, 'utf8'));
  assert(policy.mode === 'level1' || policy.mode === 'shadow', `dispatcher-policy.json defines active policy mode (${policy.mode})`);

  const dispModule = require(DISPATCHER_JS);
  assert(typeof dispModule.getDraft === 'function', 'dispatcher.js exports getDraft()');
  assert(typeof dispModule.markSent === 'function', 'dispatcher.js exports markSent()');

  // Verify tray.js and dispatch.js 1-click Accept & Send
  const trayJsContent = fs.readFileSync(path.join(UI_DIR, 'tray.js'), 'utf8');
  assert(trayJsContent.includes('⚡ Accept & Send'), 'tray.js contains 1-click "⚡ Accept & Send" button');
  assert(trayJsContent.includes('acceptAndSendDraft'), 'tray.js wires click to acceptAndSendDraft');
  assert(trayJsContent.includes('Ctrl+Enter') || trayJsContent.includes('ctrlKey'), 'tray.js supports Ctrl+Enter shortcut for instant delivery');

  const dispatchJsContent = fs.readFileSync(path.join(UI_DIR, 'dispatch.js'), 'utf8');
  assert(dispatchJsContent.includes('acceptAndSendDraft'), 'dispatch.js implements acceptAndSendDraft function');
  assert(dispatchJsContent.includes('/api/dispatch/send'), 'dispatch.js calls /api/dispatch/send endpoint');

  // --- 6. Backend Snapshot CLI Mode (--json) ---
  console.log('\n--- 6. Backend Snapshot CLI Mode (--json) ---');
  const jsonRun = await runCommand('node', [AGENT_DASH, '--json']);
  assert(jsonRun.code === 0, 'node agent-dashboard.js --json exits with code 0');

  let snapshot;
  try {
    snapshot = JSON.parse(jsonRun.stdout);
    assert(true, 'node --json produces valid parseable JSON');
  } catch (e) {
    assert(false, `node --json JSON parse failed: ${e.message}`);
  }

  let sampleSid = '';
  if (snapshot) {
    assert(Array.isArray(snapshot.sessions), `Snapshot contains sessions array (${snapshot.sessions.length} sessions)`);
    assert(typeof snapshot.counts === 'object', 'Snapshot contains counts object');
    assert(snapshot.harnesses && snapshot.harnesses.includes('antigravity'), 'Snapshot declares antigravity harness');
    assert(snapshot.harnesses && snapshot.harnesses.includes('claude'), 'Snapshot declares claude harness');
    assert(snapshot.harnesses && snapshot.harnesses.includes('codex'), 'Snapshot declares codex harness');

    const claudeSessions = snapshot.sessions.filter((s) => s.harness === 'claude');
    const agySessions = snapshot.sessions.filter((s) => s.harness === 'antigravity');
    assert(claudeSessions.length > 0, `Claude sessions detected and normalized (${claudeSessions.length})`);
    assert(agySessions.length > 0, `Antigravity sessions detected and normalized (${agySessions.length})`);

    const sample = snapshot.sessions[0];
    sampleSid = sample ? sample.id : '';
    const requiredFields = ['id', 'harness', 'turns', 'state', 'model', 'metrics'];
    const hasAllFields = requiredFields.every((f) => sample && sample[f] !== undefined);
    assert(hasAllFields, `Sessions contain normalized schema fields: ${requiredFields.join(', ')}`);
  }

  // --- 7. Live Server HTTP, Endpoints & SSE Integration ---
  console.log('\n--- 7. Live Server HTTP & REST API Integration ---');
  const env = { ...process.env, AGENT_DASH_PORT: String(TEST_PORT) };
  const serverProc = cp.spawn('node', [AGENT_DASH], { env, stdio: ['ignore', 'pipe', 'pipe'] });

  // Wait for server to start
  await new Promise((r) => setTimeout(r, 2000));

  try {
    // GET /
    const rootRes = await fetchHttp(`http://127.0.0.1:${TEST_PORT}/`);
    assert(rootRes.status === 200, `GET / returns HTTP 200 OK (size: ${rootRes.body.length})`);
    assert(rootRes.headers['content-type'] && rootRes.headers['content-type'].includes('text/html'), 'GET / Content-Type is text/html');
    assert(rootRes.body.includes('Agent HQ'), 'GET / HTML body contains Agent HQ title');

    // Extract CSRF token
    const tokenMatch = /const TOKEN = "([0-9a-f]{36})";/.exec(rootRes.body);
    const sessionToken = tokenMatch ? tokenMatch[1] : '';
    assert(Boolean(sessionToken), 'Extracted per-session CSRF token from GET /');

    const authHeaders = {
      'Content-Type': 'application/json',
      'x-agents-token': sessionToken,
      'Origin': `http://127.0.0.1:${TEST_PORT}`
    };

    // GET /api/state
    const stateRes = await fetchHttp(`http://127.0.0.1:${TEST_PORT}/api/state`);
    assert(stateRes.status === 200, 'GET /api/state returns HTTP 200 OK');
    const stateJson = JSON.parse(stateRes.body);
    assert(stateJson.sessions && stateJson.sessions.length > 0, `GET /api/state returns populated sessions (${stateJson.sessions.length})`);

    // GET /api/perf
    const perf1h = await fetchHttp(`http://127.0.0.1:${TEST_PORT}/api/perf?range=1h`);
    assert(perf1h.status === 200, 'GET /api/perf?range=1h returns HTTP 200 OK');
    const perf1hJson = JSON.parse(perf1h.body);
    assert(perf1hJson.range === '1h' && perf1hJson.kpi, 'GET /api/perf returns valid KPI performance metrics');

    // GET /api/worktrees
    const wtRes = await fetchHttp(`http://127.0.0.1:${TEST_PORT}/api/worktrees`);
    assert(wtRes.status === 200, 'GET /api/worktrees returns HTTP 200 OK');
    const wtJson = JSON.parse(wtRes.body);
    assert(wtJson.ok === true && Array.isArray(wtJson.worktrees), 'GET /api/worktrees returns ok: true and worktrees array');

    // POST /api/worktree/create (validation error handling)
    const wtCreateRes = await fetchHttp(`http://127.0.0.1:${TEST_PORT}/api/worktree/create`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({})
    });
    assert(wtCreateRes.status === 400, 'POST /api/worktree/create rejects empty body with 400 Bad Request');

    // GET /api/diff (error on missing sid)
    const diffMissing = await fetchHttp(`http://127.0.0.1:${TEST_PORT}/api/diff`);
    assert(diffMissing.status === 400, 'GET /api/diff without sid returns 400 Bad Request');

    // GET /api/diff?sid=<sampleSid>
    if (sampleSid) {
      const diffRes = await fetchHttp(`http://127.0.0.1:${TEST_PORT}/api/diff?sid=${encodeURIComponent(sampleSid)}`);
      assert(diffRes.status === 200, `GET /api/diff?sid=${sampleSid} returns HTTP 200 OK`);
      const diffJson = JSON.parse(diffRes.body);
      assert(diffJson.ok === true && diffJson.sid === sampleSid, 'GET /api/diff response contains { ok: true, sid } and diff payload');
    }

    // GET /api/logs (missing sid)
    const logsMissing = await fetchHttp(`http://127.0.0.1:${TEST_PORT}/api/logs`);
    assert(logsMissing.status === 400 || logsMissing.status === 404, 'GET /api/logs without sid returns error status (400 or 404)');

    // GET /api/logs?sid=<sampleSid>
    if (sampleSid) {
      const logsRes = await fetchHttp(`http://127.0.0.1:${TEST_PORT}/api/logs?sid=${encodeURIComponent(sampleSid)}&tail=50`);
      assert(logsRes.status === 200, `GET /api/logs?sid=${sampleSid} returns HTTP 200 OK`);
      const logsJson = JSON.parse(logsRes.body);
      assert(logsJson.ok === true && Array.isArray(logsJson.lines), 'GET /api/logs returns { ok: true, lines: [...] }');
    }

    // POST /api/dispatch/send (missing sid or key)
    const dispSendEmpty = await fetchHttp(`http://127.0.0.1:${TEST_PORT}/api/dispatch/send`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({})
    });
    assert(dispSendEmpty.status === 400, 'POST /api/dispatch/send rejects empty payload with 400 Bad Request');

    // Test GET /api/stream (SSE)
    const streamOk = await new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${TEST_PORT}/api/stream`, (res) => {
        const isEventStream = res.statusCode === 200 && (res.headers['content-type'] || '').includes('text/event-stream');
        res.on('data', (chunk) => {
          const str = chunk.toString();
          if (str.includes('retry:') || str.includes('event:')) {
            req.destroy();
            resolve(isEventStream);
          }
        });
      });
      req.on('error', () => resolve(false));
      setTimeout(() => { req.destroy(); resolve(false); }, 4000);
    });
    assert(streamOk, 'GET /api/stream provides active text/event-stream SSE events');

    // Test GET /api/logs/stream (Dedicated Session SSE Stream)
    if (sampleSid) {
      const logStreamOk = await new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${TEST_PORT}/api/logs/stream?sid=${encodeURIComponent(sampleSid)}`, (res) => {
          const isEventStream = res.statusCode === 200 && (res.headers['content-type'] || '').includes('text/event-stream');
          res.on('data', (chunk) => {
            const str = chunk.toString();
            if (str.includes('event:') || str.includes('retry:') || str.includes('data:')) {
              req.destroy();
              resolve(isEventStream);
            }
          });
        });
        req.on('error', () => resolve(false));
        setTimeout(() => { req.destroy(); resolve(false); }, 4000);
      });
      assert(logStreamOk, 'GET /api/logs/stream provides dedicated text/event-stream SSE log feed');
    }

    // --- Coordination API Endpoints Integration ---
    // POST /api/leases/acquire
    const testFile = 'test-coordination-target.js';
    const acqRes1 = await fetchHttp(`http://127.0.0.1:${TEST_PORT}/api/leases/acquire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-qa-1', filePath: testFile, type: 'exclusive_write', ttlMs: 5000 })
    });
    assert(acqRes1.status === 200, 'POST /api/leases/acquire returns 200 OK on first lease grant');
    const acq1Json = JSON.parse(acqRes1.body);
    assert(acq1Json.ok === true && acq1Json.leaseId, 'POST /api/leases/acquire grants lease with leaseId');

    // POST /api/leases/acquire contention
    const acqRes2 = await fetchHttp(`http://127.0.0.1:${TEST_PORT}/api/leases/acquire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-qa-2', filePath: testFile, type: 'shared_read' })
    });
    assert(acqRes2.status === 409, 'POST /api/leases/acquire returns 409 Conflict under file contention');
    const acq2Json = JSON.parse(acqRes2.body);
    assert(acq2Json.error === 'CONTENTION' && acq2Json.blockingSession === 'session-qa-1', 'Contention correctly identifies blockingSession');

    // GET /api/leases/active
    const leasesRes = await fetchHttp(`http://127.0.0.1:${TEST_PORT}/api/leases/active`);
    assert(leasesRes.status === 200, 'GET /api/leases/active returns 200 OK');
    const leasesJson = JSON.parse(leasesRes.body);
    assert(leasesJson.ok === true && Array.isArray(leasesJson.leases) && leasesJson.leases.some((l) => l.file_path === testFile), 'Active leases array lists currently acquired lease');

    // POST /api/leases/release
    const relRes = await fetchHttp(`http://127.0.0.1:${TEST_PORT}/api/leases/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-qa-1', filePath: testFile })
    });
    assert(relRes.status === 200, 'POST /api/leases/release returns 200 OK');
    const relJson = JSON.parse(relRes.body);
    assert(relJson.ok === true, 'Lease released successfully');

    // POST /api/intent/broadcast
    const intentRes = await fetchHttp(`http://127.0.0.1:${TEST_PORT}/api/intent/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-qa-1', message: 'Refactoring auth router', files: ['auth.js', 'user.js'] })
    });
    assert(intentRes.status === 200, 'POST /api/intent/broadcast returns 200 OK');
    const intentJson = JSON.parse(intentRes.body);
    assert(intentJson.ok === true, 'Intent broadcast recorded successfully');

    // Remote HMAC Webhook Approval Endpoint (/api/dispatch/webhook-approve)
    const webhookToken = dashModule.generateWebhookToken ? dashModule.generateWebhookToken('sample-sid-qa', 'approve') : '';
    const badWebhookRes = await fetchHttp(`http://127.0.0.1:${TEST_PORT}/api/dispatch/webhook-approve?token=bad-token&sid=sample-sid-qa&decision=approve`);
    assert(badWebhookRes.status === 403, 'GET /api/dispatch/webhook-approve rejects invalid HMAC signature with 403 Forbidden');

    if (webhookToken) {
      const goodWebhookRes = await fetchHttp(`http://127.0.0.1:${TEST_PORT}/api/dispatch/webhook-approve?token=${webhookToken}&sid=sample-sid-qa&decision=approve`);
      assert(goodWebhookRes.status === 200, 'GET /api/dispatch/webhook-approve accepts valid HMAC signature with 200 OK');
      const webhookJson = JSON.parse(goodWebhookRes.body);
      assert(webhookJson.ok === true && webhookJson.decision === 'approve', 'Webhook response confirms approved decision');
    }

  } finally {
    serverProc.kill('SIGKILL');
  }

  // --- 8. One-Command Global CLI Validation ---
  console.log('\n--- 8. One-Command Global CLI Validation ---');
  const pkgJsonPath = path.join(ROOT, 'package.json');
  assert(fs.existsSync(pkgJsonPath), 'package.json exists');
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  assert(pkg.bin && pkg.bin['agent-hq'] === 'agent-dashboard.js', 'package.json defines "bin": { "agent-hq": "agent-dashboard.js" }');

  const helpCheckLong = await runCommand('node', [AGENT_DASH, '--help']);
  assert(helpCheckLong.code === 0, 'node agent-dashboard.js --help exits with code 0');
  assert(helpCheckLong.stdout.includes('Agent HQ') && helpCheckLong.stdout.includes('agent-hq'), 'node --help outputs application usage and agent-hq command line');
  assert(helpCheckLong.stdout.includes('--open') && helpCheckLong.stdout.includes('--json'), 'node --help documents flags (--open, --json, etc.)');

  const helpCheckShort = await runCommand('node', [AGENT_DASH, '-h']);
  assert(helpCheckShort.code === 0, 'node agent-dashboard.js -h exits with code 0');
  assert(helpCheckShort.stdout === helpCheckLong.stdout, 'node -h matches --help output identically');

  // --- 9. Desk-Level Spend & Token Velocity Phosphor Gauges ---
  console.log('\n--- 9. Desk-Level Spend & Token Velocity Phosphor Gauges ---');
  assert(htmlContent.includes('.desk-gauge'), 'world.html defines .desk-gauge container styling');
  assert(htmlContent.includes('.gauge-burn'), 'world.html defines .gauge-burn styling');
  assert(htmlContent.includes('.gauge-context'), 'world.html defines .gauge-context styling');
  assert(htmlContent.includes('.ctx-bar-track') && htmlContent.includes('.ctx-bar'), 'world.html defines .ctx-bar-track and .ctx-bar elements');
  assert(htmlContent.includes('.ctx-low') && htmlContent.includes('.ctx-mid') && htmlContent.includes('.ctx-warn') && htmlContent.includes('.ctx-crit'), 'world.html defines all 4 color thresholds (.ctx-low, .ctx-mid, .ctx-warn, .ctx-crit)');
  assert(htmlContent.includes('pulseCrit'), 'world.html defines @keyframes pulseCrit for red ceiling warning');
  assert(htmlContent.includes('renderDeskGauge'), 'world.html implements renderDeskGauge(s, now) helper');

  // Test renderDeskGauge in simulated VM
  let vmGaugeWorks = false;
  try {
    const mockContext = {
      window: {},
      h: (tag, attrs, ...children) => ({ tag, attrs, children }),
      Date: { now: () => 1700000000000 },
      console
    };
    vm.createContext(mockContext);
    const gaugeScript = `
      function k(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n); }
      ${htmlContent.match(/function renderDeskGauge[\s\S]*?\n\}/)[0]}
      const testSample = {
        metrics: { cost: 1.25, in: 48000, out: 1200 },
        ctx: 48000,
        model: "claude-sonnet-4.5"
      };
      renderDeskGauge(testSample, 1700000000000);
    `;
    const gaugeEl = vm.runInContext(gaugeScript, mockContext);
    vmGaugeWorks = Boolean(gaugeEl && gaugeEl.attrs && gaugeEl.attrs.class === 'desk-gauge');
  } catch (e) {
    console.error('VM renderDeskGauge error:', e);
  }
  assert(vmGaugeWorks, 'renderDeskGauge executes and renders DOM structure cleanly in simulated environment');

  // --- 10. Real-Time SSE Terminal / Log Streaming ---
  console.log('\n--- 10. Real-Time SSE Terminal / Log Streaming ---');
  const dashCode = fs.readFileSync(AGENT_DASH, 'utf8');
  assert(dashCode.includes('/api/logs/stream'), 'agent-dashboard.js handles dedicated /api/logs/stream SSE endpoint');
  assert(dashCode.includes('term_chunk') || dashCode.includes('log_line'), 'agent-dashboard.js supports term_chunk or log_line streaming events');
  assert(htmlContent.includes('handleTermSSE'), 'world.html implements handleTermSSE() dispatcher');
  assert(htmlContent.includes('appendTermLine') && htmlContent.includes('appendTermChunk'), 'world.html implements appendTermLine and appendTermChunk terminal methods');
  assert(htmlContent.includes('addEventListener("log_line"') || htmlContent.includes('d.type === "log_line"'), 'world.html registers SSE handler for log_line events');
  assert(htmlContent.includes('addEventListener("term_chunk"') || htmlContent.includes('d.type === "term_chunk"'), 'world.html registers SSE handler for term_chunk events');

  // --- 11. SQLite Coordination Engine (coordination.js) ---
  console.log('\n--- 11. SQLite Coordination Engine (coordination.js) ---');
  const coordDb = coordination.initCoordination();
  assert(Boolean(coordDb), 'coordination.initCoordination() initializes SQLite database');

  const unitFile = 'coordination-unit-test.ts';
  const unitLease1 = coordination.acquireLease('sess-unit-1', unitFile, 'exclusive_write', 1000);
  assert(unitLease1.ok === true && unitLease1.leaseId, 'coordination.acquireLease grants exclusive_write lease');

  const unitLease2 = coordination.acquireLease('sess-unit-2', unitFile, 'shared_read', 1000);
  assert(unitLease2.ok === false && unitLease2.error === 'CONTENTION' && unitLease2.blockingSession === 'sess-unit-1', 'coordination.acquireLease detects contention against exclusive_write');

  const unitRenew = coordination.renewLeases('sess-unit-1', 5000);
  assert(unitRenew.ok === true, 'coordination.renewLeases extends heartbeat TTL');

  const unitActive = coordination.getActiveLeases();
  assert(Array.isArray(unitActive) && unitActive.some((l) => l.file_path === unitFile), 'coordination.getActiveLeases lists active leases');

  const unitRel = coordination.releaseLease('sess-unit-1', unitFile);
  assert(unitRel.ok === true, 'coordination.releaseLease releases active lease');

  const unitReap = coordination.reapStaleLeases();
  assert(unitReap.ok === true, 'coordination.reapStaleLeases completes successfully');

  const unitBroadcast = coordination.broadcastIntent('sess-unit-1', 'Refactoring schema', [unitFile]);
  assert(unitBroadcast.ok === true, 'coordination.broadcastIntent records intent broadcast');

  // --- 12. Worktree Safety & Speculative Pre-Flight Tests (worktrees.js) ---
  console.log('\n--- 12. Worktree Safety & Speculative Pre-Flight Tests (worktrees.js) ---');
  const specPass = await wtModule.runSpeculativeTests({
    repo: ROOT,
    path: ROOT,
    command: 'node -e "process.exit(0)"'
  });
  assert(specPass.ok === true && specPass.passed === true, 'runSpeculativeTests returns passed: true on passing test command');

  const specFail = await wtModule.runSpeculativeTests({
    repo: ROOT,
    path: ROOT,
    command: 'node -e "process.exit(1)"'
  });
  assert(specFail.passed === false && specFail.code !== 0, 'runSpeculativeTests returns passed: false on failing test command');

  const mergeBlock = await wtModule.mergeWorktree({
    repo: ROOT,
    path: ROOT,
    branch: 'non-existent-test-branch-qa',
    runTests: true,
    testCommand: 'node -e "process.exit(1)"',
    force: false
  });
  assert(mergeBlock.ok === false && mergeBlock.blocked === true && mergeBlock.testsFailed === true, 'mergeWorktree blocks ghost merge when speculative tests fail without force');

  // --- 13. In-Flight Secret Redaction Proxy (agent-dashboard.js) ---
  console.log('\n--- 13. In-Flight Secret Redaction Proxy (agent-dashboard.js) ---');
  assert(typeof dashModule.sanitizeStream === 'function', 'agent-dashboard.js exports sanitizeStream() function');
  const dummyOai = ['sk', 'proj', '1234567890abcdef1234567890'].join('-');
  const dummyGhp = ['ghp', 'abcdefghijklmnopqrstuvwxyz123456'].join('_');
  const dummyGgl = ['AIzaSy', 'TestKey123456789012345678901234'].join('');
  const dummyAws = ['AKIA', '1234567890ABCDEF'].join('');
  const dummyBear = ['Bearer', 'secret_bearer_token_12345'].join(' ');

  const dirtySecretStr = [
    `OpenAI: ${dummyOai}`,
    `GitHub: ${dummyGhp}`,
    `Google: ${dummyGgl}`,
    `AWS: ${dummyAws}`,
    `Auth: ${dummyBear}`
  ].join('\n');
  const cleanSecretStr = dashModule.sanitizeStream(dirtySecretStr);
  assert(!cleanSecretStr.includes(dummyOai) && cleanSecretStr.includes('sk-[REDACTED]'), 'sanitizeStream scrubs OpenAI sk- keys');
  assert(!cleanSecretStr.includes(dummyGhp) && cleanSecretStr.includes('ghp_[REDACTED]'), 'sanitizeStream scrubs GitHub ghp_ tokens');
  assert(!cleanSecretStr.includes(dummyGgl) && cleanSecretStr.includes('AIza[REDACTED]'), 'sanitizeStream scrubs Google AIza keys');
  assert(!cleanSecretStr.includes(dummyAws) && cleanSecretStr.includes('AKIA[REDACTED]'), 'sanitizeStream scrubs AWS AKIA keys');
  assert(!cleanSecretStr.includes(dummyBear) && cleanSecretStr.includes('Bearer [REDACTED]'), 'sanitizeStream scrubs Bearer authorization tokens');

  // --- 14. Remote HMAC Webhook Verification (agent-dashboard.js) ---
  console.log('\n--- 14. Remote HMAC Webhook Verification (agent-dashboard.js) ---');
  assert(typeof dashModule.generateWebhookToken === 'function', 'agent-dashboard.js exports generateWebhookToken');
  assert(typeof dashModule.verifyWebhookToken === 'function', 'agent-dashboard.js exports verifyWebhookToken');
  const unitToken = dashModule.generateWebhookToken('sess-unit-qa', 'approve');
  assert(typeof unitToken === 'string' && unitToken.length === 64, 'generateWebhookToken produces 64-char SHA-256 HMAC hex token');
  assert(dashModule.verifyWebhookToken(unitToken, 'sess-unit-qa', 'approve') === true, 'verifyWebhookToken validates authentic token');
  assert(dashModule.verifyWebhookToken(unitToken, 'sess-unit-qa', 'reject') === false, 'verifyWebhookToken rejects mismatched decision');
  assert(dashModule.verifyWebhookToken(unitToken, 'other-session', 'approve') === false, 'verifyWebhookToken rejects mismatched session');
  assert(dashModule.verifyWebhookToken('tamperedtoken1234567890', 'sess-unit-qa', 'approve') === false, 'verifyWebhookToken rejects tampered token');

  // --- 15. Cognitive Memory Fabric (knowledge.js) ---
  console.log('\n--- 15. Cognitive Memory Fabric (knowledge.js) ---');
  assert(typeof knowledge.recordDecision === 'function', 'knowledge.js exports recordDecision');
  assert(typeof knowledge.recordGotcha === 'function', 'knowledge.js exports recordGotcha');
  assert(typeof knowledge.addTriple === 'function', 'knowledge.js exports addTriple');
  assert(typeof knowledge.readDecisions === 'function', 'knowledge.js exports readDecisions');
  assert(typeof knowledge.readGotchas === 'function', 'knowledge.js exports readGotchas');
  assert(typeof knowledge.readGraph === 'function', 'knowledge.js exports readGraph');
  assert(typeof knowledge.getKnowledgeSummary === 'function', 'knowledge.js exports getKnowledgeSummary');

  const adrRes = knowledge.recordDecision({
    title: 'Adopt SQLite Coordination',
    decision: 'Use Node 24 native DatabaseSync for stateful leases',
    rationale: 'Zero external dependencies and instant lock acquisition',
    status: 'accepted',
    sessionId: 'session-qa-mem'
  });
  assert(adrRes.ok === true && adrRes.adrId && adrRes.adrId.startsWith('ADR-'), 'recordDecision writes structured ADR with ADR-ID');

  const adrRead = knowledge.readDecisions();
  assert(adrRead.ok === true && Array.isArray(adrRead.adrs) && adrRead.adrs.some((a) => a.id === adrRes.adrId), 'readDecisions parses recorded ADRs from decisions.md');

  const gotchaRes = knowledge.recordGotcha({
    issue: 'Concurrent Worktree SQLite Access',
    constraint: 'Must enable WAL mode on database connections',
    severity: 'warning',
    component: 'coordination',
    sessionId: 'session-qa-mem'
  });
  assert(gotchaRes.ok === true, 'recordGotcha writes hazard and constraint to gotchas.md');

  const gotchaRead = knowledge.readGotchas();
  assert(gotchaRead.ok === true && gotchaRead.text && gotchaRead.text.includes('Concurrent Worktree SQLite Access'), 'readGotchas returns markdown text from gotchas.md');

  const tripleRes = knowledge.addTriple({
    subject: 'CoordinationEngine',
    predicate: 'dependsOn',
    object: 'Node24DatabaseSync',
    sessionId: 'session-qa-mem'
  });
  assert(tripleRes.ok === true, 'addTriple writes entity relationship triple to graph.jsonl');

  const graphRead = knowledge.readGraph();
  assert(graphRead.ok === true && Array.isArray(graphRead.triples) && graphRead.triples.some((t) => t.subject === 'CoordinationEngine'), 'readGraph parses entity triples from graph.jsonl');

  const knowSummary = knowledge.getKnowledgeSummary();
  assert(knowSummary.ok === true && typeof knowSummary.decisionsCount === 'number' && typeof knowSummary.triplesCount === 'number', 'getKnowledgeSummary returns combined counts for decisions and graph triples');

  // --- 16. Loop Thrashing Circuit Breaker UI ---
  console.log('\n--- 16. Loop Thrashing Circuit Breaker UI ---');
  assert(htmlContent.includes('.desk-loop-alert'), 'world.html defines .desk-loop-alert amber warning pulse styling');
  assert(htmlContent.includes('amberPulse'), 'world.html defines @keyframes amberPulse for loop thrashing alert');
  assert(alertsCode.includes('loopAlarm'), 'alerts.js defines loopAlarm() procedural 8-bit descending audio chime');
  assert(trayJsContent.includes('loop thrashing') || trayJsContent.includes('Loop thrashing'), 'tray.js identifies loop thrashing condition');
  assert(trayJsContent.includes('Nudge'), 'tray.js provides [💡 Nudge] action button');
  assert(trayJsContent.includes('Revert Commit'), 'tray.js provides [🔄 Revert Commit] action button');

  // --- Summary ---
  console.log('\n====================================================');
  console.log(` Test Results: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
