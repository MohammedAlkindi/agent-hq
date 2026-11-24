// run-tests.js - Full verification suite for Agent HQ Multi-Agent & 5-Frontier Evolution
const fs = require('fs');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const vm = require('vm');
const os = require('os');

// Everything the suite writes goes to a throwaway folder: never into the repository (.state, .hq/knowledge) and
// never into the real ~/worktrees. These variables are read when the modules load, so they are set first.
const TEST_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-test-'));
process.env.AGENT_HQ_STATE_DIR = TEST_STATE;
process.env.AGENT_HQ_STATE = path.join(TEST_STATE, 'dispatcher');
process.env.AGENT_HQ_WORKTREES = path.join(TEST_STATE, 'worktrees');
process.env.AGENT_HQ_KNOWLEDGE_DIR = path.join(TEST_STATE, 'knowledge');

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
let skipped = 0;
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

// A check that needs real sessions on this machine is skipped, not failed, when there are none.
function skip(message) {
  skipped++;
  console.log(`  [SKIP] ${message}`);
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
    if (snapshot.sessions.length === 0) {
      skip('Claude and Antigravity sessions detected: no real sessions on this machine');
    } else {
      assert(claudeSessions.length > 0, `Claude sessions detected and normalized (${claudeSessions.length})`);
      assert(agySessions.length > 0, `Antigravity sessions detected and normalized (${agySessions.length})`);
    }

    const sample = snapshot.sessions[0];
    sampleSid = sample ? sample.id : '';
    const requiredFields = ['id', 'harness', 'turns', 'state', 'model', 'metrics'];
    const hasAllFields = requiredFields.every((f) => sample && sample[f] !== undefined);
    if (sample) assert(hasAllFields, `Sessions contain normalized schema fields: ${requiredFields.join(', ')}`);
    else skip('session schema fields: no real sessions on this machine');
  }

  // --- 7. Live Server HTTP, Endpoints & SSE Integration ---
  console.log('\n--- 7. Live Server HTTP & REST API Integration ---');
  const env = { ...process.env, AGENT_DASH_PORT: String(TEST_PORT) };
  // two drafts the webhook tests can act on (the server reads drafts.json when it starts)
  fs.mkdirSync(process.env.AGENT_HQ_STATE, { recursive: true });
  fs.writeFileSync(path.join(process.env.AGENT_HQ_STATE, 'drafts.json'), JSON.stringify({
    'sess-webhook-qa:1': { key: 'sess-webhook-qa:1', id: 'sess-webhook-qa', title: 'qa', kind: 'desktop', since: 1, at: Date.now(), reply: 'Yes, continue.', wouldSend: false },
    'sess-webhook-qb:1': { key: 'sess-webhook-qb:1', id: 'sess-webhook-qb', title: 'qb', kind: 'desktop', since: 1, at: Date.now(), reply: 'Go ahead.', wouldSend: false },
  }));
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
    if (stateJson.sessions && stateJson.sessions.length > 0) assert(true, `GET /api/state returns populated sessions (${stateJson.sessions.length})`);
    else skip('GET /api/state populated sessions: no real sessions on this machine');

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

    // --- Coordination API: every state-changing route needs the page token (or the local token) and a same-origin request ---
    const testFile = 'test-coordination-target.js';
    const apiPost = (p, body, headers) => fetchHttp(`http://127.0.0.1:${TEST_PORT}${p}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const noToken = await apiPost('/api/leases/acquire', { sessionId: 'session-x', filePath: testFile }, { 'Content-Type': 'application/json' });
    assert(noToken.status === 403, 'POST /api/leases/acquire without a token is refused with 403 (it used to be open to any web page)');
    const badToken = await apiPost('/api/leases/acquire', { sessionId: 'session-x', filePath: testFile }, { 'Content-Type': 'application/json', 'x-agents-token': 'not-the-token' });
    assert(badToken.status === 403, 'POST /api/leases/acquire with a wrong token is refused with 403');
    const foreign = await apiPost('/api/intent/broadcast', { sessionId: 'session-x', message: 'hello' }, { ...authHeaders, Origin: 'http://evil.example' });
    assert(foreign.status === 403, 'POST /api/intent/broadcast from a foreign Origin is refused even with the right token');
    const localTokenFile = path.join(TEST_STATE, 'local-api-token');
    assert(fs.existsSync(localTokenFile), 'the server created a local API token file for scripts and hooks on this machine');
    const localTok = fs.readFileSync(localTokenFile, 'utf8').trim();
    const viaLocal = await apiPost('/api/leases/acquire', { sessionId: 'session-local', filePath: 'local-token-file.js', ttlMs: 2000 }, { 'Content-Type': 'application/json', 'x-agents-token': localTok });
    assert(viaLocal.status === 200, 'a local script holding the token file value can call the lease API');

    // POST /api/leases/acquire
    const acqRes1 = await apiPost('/api/leases/acquire', { sessionId: 'session-qa-1', filePath: testFile, type: 'exclusive_write', ttlMs: 5000 }, authHeaders);
    assert(acqRes1.status === 200, 'POST /api/leases/acquire returns 200 OK on first lease grant');
    const acq1Json = JSON.parse(acqRes1.body);
    assert(acq1Json.ok === true && acq1Json.leaseId, 'POST /api/leases/acquire grants lease with leaseId');

    // POST /api/leases/acquire contention
    const acqRes2 = await apiPost('/api/leases/acquire', { sessionId: 'session-qa-2', filePath: testFile, type: 'shared_read' }, authHeaders);
    assert(acqRes2.status === 409, 'POST /api/leases/acquire returns 409 Conflict under file contention');
    const acq2Json = JSON.parse(acqRes2.body);
    assert(acq2Json.error === 'CONTENTION' && acq2Json.blockingSession === 'session-qa-1', 'Contention correctly identifies blockingSession');

    // GET /api/leases/active
    const leasesRes = await fetchHttp(`http://127.0.0.1:${TEST_PORT}/api/leases/active`);
    assert(leasesRes.status === 200, 'GET /api/leases/active returns 200 OK');
    const leasesJson = JSON.parse(leasesRes.body);
    assert(leasesJson.ok === true && Array.isArray(leasesJson.leases) && leasesJson.leases.some((l) => l.file_path === testFile), 'Active leases array lists currently acquired lease');

    // POST /api/leases/release
    const relRes = await apiPost('/api/leases/release', { sessionId: 'session-qa-1', filePath: testFile }, authHeaders);
    assert(relRes.status === 200, 'POST /api/leases/release returns 200 OK');
    const relJson = JSON.parse(relRes.body);
    assert(relJson.ok === true, 'Lease released successfully');

    // POST /api/intent/broadcast
    const intentRes = await apiPost('/api/intent/broadcast', { sessionId: 'session-qa-1', message: 'Refactoring auth router', files: ['auth.js', 'user.js'] }, authHeaders);
    assert(intentRes.status === 200, 'POST /api/intent/broadcast returns 200 OK');
    const intentJson = JSON.parse(intentRes.body);
    assert(intentJson.ok === true, 'Intent broadcast recorded successfully');

    // The unauthenticated routes that pushed arbitrary text into every open terminal stream are gone
    const inject1 = await fetchHttp(`http://127.0.0.1:${TEST_PORT}/api/stream/broadcast?sid=x&text=injected`);
    const inject2 = await fetchHttp(`http://127.0.0.1:${TEST_PORT}/api/logs/emit?sid=x&text=injected`);
    assert(inject1.status === 404 && inject2.status === 404, 'GET /api/stream/broadcast and /api/logs/emit no longer exist (they injected text into the terminal stream)');

    // Remote approval links: a GET shows a page and changes nothing; one POST with a valid, unused token acts once
    const hook = (sid, key, decision) => ({ token: dashModule.generateWebhookToken(sid, decision), sid, key, decision });
    const webhookUrl = `http://127.0.0.1:${TEST_PORT}/api/dispatch/webhook-approve`;
    const badWebhookRes = await fetchHttp(`${webhookUrl}?token=bad-token&sid=sess-webhook-qa&decision=approve`);
    assert(badWebhookRes.status === 403, 'GET /api/dispatch/webhook-approve rejects an invalid token with 403');
    const rj = hook('sess-webhook-qa', 'sess-webhook-qa:1', 'reject');
    const pageRes = await fetchHttp(`${webhookUrl}?token=${rj.token}&sid=${rj.sid}&decision=reject&key=${encodeURIComponent(rj.key)}`);
    assert(pageRes.status === 200 && pageRes.headers['content-type'].includes('text/html') && pageRes.body.includes('<form') && pageRes.body.includes('Yes, continue.'), 'GET with a valid token shows a confirmation page with the draft and a form, and does nothing else');
    const draftsAfterGet = JSON.parse(fs.readFileSync(path.join(process.env.AGENT_HQ_STATE, 'drafts.json'), 'utf8'));
    assert(!draftsAfterGet['sess-webhook-qa:1'].sent, 'the GET did not mark the draft sent');
    const form = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
    const rejRes = await fetchHttp(webhookUrl, form(rj));
    assert(rejRes.status === 200 && JSON.parse(rejRes.body).decision === 'reject', 'POST with a valid token rejects the draft');
    const replay = await fetchHttp(webhookUrl, form(rj));
    assert(replay.status === 403 && JSON.parse(replay.body).error === 'ALREADY_USED', 'the same link cannot be used twice (replay refused)');
    const ap = hook('sess-webhook-qb', 'sess-webhook-qb:1', 'approve');
    const wrongDecision = await fetchHttp(webhookUrl, form({ ...ap, decision: 'reject' }));
    assert(wrongDecision.status === 403, 'a token made for approve cannot reject (decision is part of the signature)');
    const apRes = await fetchHttp(webhookUrl, form(ap));
    const apJson = JSON.parse(apRes.body);
    assert(apRes.status === 200 && apJson.decision === 'approve' && typeof apJson.dispatched === 'boolean', 'POST approve answers with the real delivery outcome (dispatched true or false), not a blanket "approved"');
    const noDraft = hook('sess-webhook-qc', 'sess-webhook-qc:1', 'approve');
    const noDraftRes = await fetchHttp(webhookUrl, form(noDraft));
    assert(noDraftRes.status === 404, 'approving a link whose draft is gone sends nothing (it used to send the literal text "Approved")');
    const foreignHook = await fetchHttp(webhookUrl, { ...form(hook('sess-webhook-qa', 'sess-webhook-qa:1', 'approve')), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://evil.example' } });
    assert(foreignHook.status === 403, 'a webhook POST from a foreign Origin is refused');

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

  const mergeMissing = await wtModule.mergeWorktree({
    repo: ROOT,
    path: ROOT,
    branch: 'non-existent-test-branch-qa',
    runTests: true,
    testCommand: 'node -e "process.exit(1)"',
    force: false
  });
  assert(mergeMissing.ok === false && /does not exist/.test(mergeMissing.msg), 'mergeWorktree refuses a branch that does not exist and runs nothing');

  assert(typeof wtModule.pruneInactiveWorktrees === 'function', 'worktrees.js exports pruneInactiveWorktrees');
  const pruneTestRes = await wtModule.pruneInactiveWorktrees({ maxAgeHours: 999999 });
  assert(pruneTestRes && pruneTestRes.ok === true && Array.isArray(pruneTestRes.pruned), 'pruneInactiveWorktrees runs safely and returns pruned array');

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
  assert(/^\d{10,16}\.[0-9a-f]{64}$/.test(unitToken), 'generateWebhookToken produces "<expiry>.<sha-256 hmac>" (bound to session, decision and expiry)');
  assert(dashModule.verifyWebhookToken(unitToken, 'sess-unit-qa', 'approve') === true, 'verifyWebhookToken validates authentic token');
  assert(dashModule.verifyWebhookToken(unitToken, 'sess-unit-qa', 'reject') === false, 'verifyWebhookToken rejects mismatched decision');
  assert(dashModule.verifyWebhookToken(unitToken, 'other-session', 'approve') === false, 'verifyWebhookToken rejects mismatched session');
  assert(dashModule.verifyWebhookToken('tamperedtoken1234567890', 'sess-unit-qa', 'approve') === false, 'verifyWebhookToken rejects tampered token');
  const expired = dashModule.generateWebhookToken('sess-unit-qa', 'approve', undefined, -1000);
  assert(dashModule.verifyWebhookToken(expired, 'sess-unit-qa', 'approve') === false, 'verifyWebhookToken rejects an expired token');
  const secretOnDisk = fs.readFileSync(path.join(TEST_STATE, 'webhook-secret'), 'utf8').trim();
  assert(secretOnDisk.length === 64 && secretOnDisk !== 'agent-hq-dispatch-secret-2026', 'the webhook secret is random and created per install, not the public default string');
  const crypto = require('crypto');
  const legacySidOnly = crypto.createHmac('sha256', secretOnDisk).update('sess-unit-qa').digest('hex');
  const legacyDefault = crypto.createHmac('sha256', 'agent-hq-dispatch-secret-2026').update('sess-unit-qa:approve').digest('hex');
  assert(dashModule.verifyWebhookToken(legacySidOnly, 'sess-unit-qa', 'approve') === false && dashModule.verifyWebhookToken(legacyDefault, 'sess-unit-qa', 'approve') === false, 'the old decision-less token and the old default-secret token are no longer accepted');

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
  assert(trayJsContent.includes('s.loop') && !trayJsContent.includes('errLog.length >= 3'), 'tray.js uses the detector result (s.loop), not "3 failed calls in 24 hours"');
  assert(trayJsContent.includes('Nudge'), 'tray.js provides [💡 Nudge] action button');
  assert(!trayJsContent.includes('btn-revert') && !trayJsContent.includes('revertAgentCommit'), 'tray.js has no Revert Commit button (it called a server route that never existed)');

  // --- 17. Loop and repeat-failure detectors (detectors.js) ---
  console.log('\n--- 17. Loop and Repeat-Failure Detectors (detectors.js) ---');
  const detectors = require(path.join(ROOT, 'detectors.js'));
  const ev = (name, input, ok = true, err = '', out = 'o') => ({
    name, hash: detectors.hashOf(JSON.stringify(input)), ok,
    err: ok ? '' : detectors.hashOf(err), out: ok ? detectors.hashOf(out) : '', poll: detectors.isPoll(name, input),
  });
  assert(detectors.detect([]) === null && detectors.detect(null) === null, 'detect() returns null for no events');
  assert(detectors.detect([ev('Bash', { command: 'a' }, false, 'x'), ev('Read', { p: 1 }, false, 'y'), ev('Grep', { q: 1 }, false, 'z')]) === null,
    'three failed calls to different tools are NOT a loop (the old rule flagged this)');
  const same3 = detectors.detect([1, 2, 3].map((i) => ev('Read', { file: 'a' }, true, '', 'out' + i)));
  assert(same3 && same3.id === 'possible_loop' && same3.severity === 'watch', 'three identical calls give a "watch" level possible_loop');
  const same4 = detectors.detect([1, 2, 3, 4].map(() => ev('Read', { file: 'a' })));
  assert(same4 && same4.id === 'hard_loop' && same4.severity === 'alarm', 'four identical call-and-result pairs give an alarm level hard_loop');
  const same5 = detectors.detect([1, 2, 3, 4, 5].map((i) => ev('Read', { file: 'a' }, true, '', 'out' + i)));
  assert(same5 && same5.id === 'hard_loop', 'five identical calls give hard_loop even when the results differ');
  const err3 = detectors.detect([1, 2, 3].map(() => ev('Bash', { command: 'make' }, false, 'error: missing file')));
  assert(err3 && err3.id === 'repeat_error' && err3.severity === 'alarm', 'the same failure three times in a row gives repeat_error');
  const brokenRun = detectors.detect([ev('Bash', { command: 'make' }, false, 'e'), ev('Bash', { command: 'make' }, false, 'e'), ev('Bash', { command: 'make' }, true), ev('Bash', { command: 'make' }, false, 'e')]);
  assert(!brokenRun || brokenRun.id !== 'repeat_error', 'a success in between resets the run of failures (no repeat_error)');
  const polls = detectors.detect([1, 2, 3, 4, 5, 6].map(() => ev('Bash', { command: 'git status' })));
  assert(polls === null, 'repeated polling commands (git status) are not a loop');
  const alt = detectors.detect(['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b'].map((f) => ev('Read', { file: f })));
  assert(alt && alt.id === 'alternating' && alt.severity === 'watch', 'A,B,A,B,A,B,A,B gives alternating');
  assert(detectors.detect([ev('Read', { file: 'a' }), ev('Read', { file: 'b' }), ev('Read', { file: 'c' }), ev('Read', { file: 'd' })]) === null, 'distinct calls are not flagged');

  // The same detectors end to end: synthetic transcripts through the Claude adapter
  const { ClaudeAdapter } = require(path.join(ROOT, 'adapters', 'claude.js'));
  const projectsRoot = path.join(TEST_STATE, 'claude-projects');
  const projDir = path.join(projectsRoot, 'proj');
  fs.mkdirSync(projDir, { recursive: true });
  const jl = (o) => JSON.stringify(o) + '\n';
  const mkTranscript = (id, calls) => {
    let t = Date.now() - 60000;
    let s = jl({ type: 'user', timestamp: new Date(t).toISOString(), cwd: ROOT, message: { role: 'user', content: 'fix the build' } });
    calls.forEach((c, i) => {
      t += 3000;
      const tid = `${id}-t${i}`;
      s += jl({ type: 'assistant', timestamp: new Date(t).toISOString(), cwd: ROOT, message: { id: `${id}-m${i}`, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: tid, name: c.name, input: c.input }], stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 20 } } });
      s += jl({ type: 'user', timestamp: new Date(t + 500).toISOString(), cwd: ROOT, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: c.text, is_error: !!c.err }] } });
    });
    fs.writeFileSync(path.join(projDir, id + '.jsonl'), s);
  };
  mkTranscript('looping-session', [1, 2, 3, 4, 5].map(() => ({ name: 'Bash', input: { command: 'npm run build' }, text: 'error TS2304', err: true })));
  mkTranscript('normal-session', [
    { name: 'Bash', input: { command: 'a' }, text: 'boom', err: true }, { name: 'Read', input: { file: 'x' }, text: 'nope', err: true },
    { name: 'Grep', input: { q: 'y' }, text: 'bad', err: true }, { name: 'Edit', input: { f: 'z' }, text: 'fail', err: true },
  ]);
  const adapterScan = new ClaudeAdapter({ projectsDir: projectsRoot }).scan(Date.now(), new Map());
  const loopS = adapterScan.find((s) => s.id === 'looping-session');
  const normS = adapterScan.find((s) => s.id === 'normal-session');
  assert(loopS && loopS.loop && loopS.loop.id === 'hard_loop' && loopS.loop.severity === 'alarm', 'the Claude adapter reports a hard_loop for five identical failing builds in one turn');
  assert(normS && normS.loop === null && normS.errLog.length >= 3, 'four failures of four different tools: the adapter reports no loop (the old rule called this "loop thrashing")');

  // --- 18. Delivery: one human action, one delivery (stubbed claude CLI) ---
  console.log('\n--- 18. Delivery Is Exactly Once And Tells The Truth ---');
  const DEL_PORT = TEST_PORT + 1;
  const delHome = path.join(TEST_STATE, 'del-home');
  fs.mkdirSync(delHome, { recursive: true });
  const delSid = '11111111-2222-3333-4444-555555555555';
  const delKey = delSid + ':1';
  const delState = path.join(TEST_STATE, 'del-dispatcher');
  fs.mkdirSync(delState, { recursive: true });
  fs.writeFileSync(path.join(delState, 'drafts.json'), JSON.stringify({ [delKey]: { key: delKey, id: delSid, title: 'stub agent', kind: 'background', since: 1, at: Date.now(), reply: 'Yes, go ahead with option B.', wouldSend: false } }));
  const delLog = path.join(TEST_STATE, 'del-stub.log');
  const delProc = cp.spawn(process.execPath, ['--require', path.join(ROOT, 'test-fixtures', 'stub-claude-preload.js'), AGENT_DASH], {
    env: { ...process.env, AGENT_DASH_PORT: String(DEL_PORT), USERPROFILE: delHome, HOME: delHome, AGENT_HQ_STATE: delState, STUB_LOG: delLog, STUB_SID: delSid },
    stdio: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { up = (await fetchHttp(`http://127.0.0.1:${DEL_PORT}/api/ping`)).status === 200; } catch {}
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    assert(up, 'delivery test server started with the stubbed claude CLI');
    await new Promise((r) => setTimeout(r, 1500));
    const delPage = await fetchHttp(`http://127.0.0.1:${DEL_PORT}/`);
    const delTok = (/const TOKEN = "([0-9a-f]{36})";/.exec(delPage.body) || [])[1] || '';
    const delHeaders = { 'Content-Type': 'application/json', 'x-agents-token': delTok };
    const sendDraft = () => fetchHttp(`http://127.0.0.1:${DEL_PORT}/api/dispatch/send`, { method: 'POST', headers: delHeaders, body: JSON.stringify({ sid: delSid, key: delKey, reply: 'Yes, go ahead with option B.', idem: 'draft:' + delKey }) });
    const [s1, s2] = await Promise.all([sendDraft(), sendDraft()]); // a double click
    const j1 = JSON.parse(s1.body), j2 = JSON.parse(s2.body);
    assert(s1.status === 200 && s2.status === 200, 'POST /api/dispatch/send answers 200 (it used to answer 500 "sentText is not defined" after sending)');
    assert(j1.ok === true && j2.ok === true, 'both responses of a double click report success');
    assert([j1, j2].filter((j) => j.duplicate).length === 1, 'exactly one of the two simultaneous sends is recognized as a duplicate');
    const s3 = JSON.parse((await sendDraft()).body);
    assert(s3.ok === true && s3.duplicate === true, 'a third send of the same draft is answered without sending again');
    const calls = fs.readFileSync(delLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const resumes = calls.filter((c) => c.args.includes('--resume'));
    assert(resumes.length === 1, `one human action produced exactly one delivery (--resume calls: ${resumes.length})`);
    const queuedRes = await fetchHttp(`http://127.0.0.1:${DEL_PORT}/api/dispatch/send`, { method: 'POST', headers: delHeaders, body: JSON.stringify({ sid: delSid, text: 'A second, different message', idem: 'other-1' }) });
    const qj = JSON.parse(queuedRes.body);
    assert(qj.ok === true && qj.queued === true, 'a message sent while the agent is working is queued, not delivered over its running turn');
    assert(fs.readFileSync(delLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => c.args.includes('--resume')).length === 1, 'the queued message did not run claude --resume or claude stop on the busy agent');
    const noTok = await fetchHttp(`http://127.0.0.1:${DEL_PORT}/api/dispatch/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid: delSid, text: 'x' }) });
    assert(noTok.status === 403, 'a send without the page token is refused (this is why the old Nudge button silently did nothing)');
  } finally {
    delProc.kill('SIGKILL');
  }
  const codexAdapter = require(path.join(ROOT, 'adapters', 'codex.js')).CodexAdapter;
  const agyAdapter = require(path.join(ROOT, 'adapters', 'antigravity.js')).AntigravityAdapter;
  const cxSend = await new codexAdapter().deliver('abcdef12', 'hello');
  assert(cxSend.ok === false && cxSend.unsupported === true, 'Codex deliver() says it is unsupported instead of reporting a send that did not happen');
  const cxStop = await new codexAdapter().stop('abcdef12');
  assert(cxStop.ok === false && cxStop.unsupported === true, 'Codex stop() says it is unsupported instead of reporting a stop that did not happen');
  const trayCode = fs.readFileSync(path.join(UI_DIR, 'tray.js'), 'utf8');
  assert(!trayCode.includes('/api/worktree/revert'), 'tray.js no longer calls the /api/worktree/revert route that never existed');
  assert(/post\("\/api\/dispatch\/send"/.test(trayCode), 'the Nudge action sends through post(), which carries the page token');
  const dispatchUi = fs.readFileSync(path.join(UI_DIR, 'dispatch.js'), 'utf8');
  assert(!/api\/prompt/.test(dispatchUi.slice(dispatchUi.indexOf('async function acceptAndSendDraft'), dispatchUi.indexOf('async function rateDraft'))), 'acceptAndSendDraft has no second route to fall back to (a second send delivered the reply twice)');

  // --- 19. Dispatcher failure handling ---
  console.log('\n--- 19. Dispatcher Failure Handling And Implicit Labels ---');
  const disp = require(DISPATCHER_JS);
  const loginFail = { out: JSON.stringify({ result: 'Not logged in · Please run /login', total_cost_usd: 0 }), err: '' };
  assert(disp.internals.failureKind(loginFail, { result: 'Not logged in · Please run /login' }) === 'auth', 'a "Not logged in" result is classified as an auth failure');
  assert(disp.internals.failureKind({ out: '', err: 'rate limit exceeded' }, null) === 'limit', 'a rate limit message is classified as a limit failure');
  const longFail = disp.internals.describeFailure({ out: '', err: '' }, { result: 'x'.repeat(2000) });
  assert(longFail.length === 600, 'a failure message is kept up to 600 characters (it used to be cut at 300, before the cause)');
  assert(disp.internals.describeFailure({ out: '', err: '' }, { result: 'Not logged in' }).includes('Not logged in'), 'the failure message includes the CLI result text');
  assert(disp.internals.backoffMs(1) === 60e3 && disp.internals.backoffMs(2) === 120e3 && disp.internals.backoffMs(20) === 30 * 60e3, 'retry backoff doubles from one minute and is capped at 30 minutes');
  assert(disp.internals.similarity('Yes, go ahead with option B.', 'yes go ahead with option b') >= 0.9, 'similarity ignores case and punctuation');
  assert(disp.internals.similarity('run the tests', 'delete the database') < 0.5, 'unrelated messages are not similar');
  const dstate = disp.state(Date.now());
  assert(dstate && 'offline' in dstate && 'consecutiveFailures' in dstate, 'dispatcher state reports offline and consecutiveFailures');

  // --- 20. Worktree safety (temporary repositories) ---
  console.log('\n--- 20. Worktree Safety: Create, Merge, Prune, Cleanup ---');
  const git = (args, cwd) => cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const mkRepo = (name) => {
    const r = path.join(TEST_STATE, 'repos', name);
    fs.mkdirSync(r, { recursive: true });
    git(['init', '-q', '-b', 'main'], r);
    git(['config', 'user.name', 't'], r); git(['config', 'user.email', 't@t'], r); git(['config', 'core.autocrlf', 'false'], r);
    // The machine's own git setup (global hooks such as a commit-message guard, commit signing) must not decide
    // whether these throwaway repositories can commit.
    git(['config', 'core.hooksPath', path.join(TEST_STATE, 'no-hooks')], r); git(['config', 'commit.gpgsign', 'false'], r);
    fs.writeFileSync(path.join(r, 'package.json'), JSON.stringify({ name, scripts: { test: 'node test.js' } }));
    fs.writeFileSync(path.join(r, 'lib.js'), 'exports.f = (a) => a * 2;\n');
    fs.writeFileSync(path.join(r, 'caller1.js'), "const {f} = require('./lib'); exports.run = () => f(2);\n");
    fs.writeFileSync(path.join(r, 'test.js'), "const c1 = require('./caller1'); process.exit(c1.run() === 4 ? 0 : 1);\n");
    git(['add', '.'], r);
    git(['commit', '-q', '-m', 'init'], r);
    return r;
  };
  const rev = (r, ref) => git(['rev-parse', ref], r);
  const branchList = (r) => git(['branch', '--list'], r).replace(/[*+]/g, '').split('\n').map((s) => s.trim()).filter(Boolean);
  const commitIn = (dir, file, text, msg) => { fs.writeFileSync(path.join(dir, file), text); git(['add', '.'], dir); git(['commit', '-q', '-m', msg], dir); };

  const wtA = mkRepo('wt-a');
  const c1 = await wtModule.createWorktree({ repo: wtA, name: 'same first six words' });
  const c2 = await wtModule.createWorktree({ repo: wtA, name: 'same first six words' });
  assert(c1.ok && c2.ok && c1.path !== c2.path && c1.branch !== c2.branch, 'two worktrees made from the same prompt words get different folders and branches');
  const s1c = await wtModule.createWorktree({ repo: wtA, sid: 'sess-fixed' });
  const s2c = await wtModule.createWorktree({ repo: wtA, sid: 'sess-fixed' });
  assert(s1c.ok && s2c.ok && s2c.reused === true && s1c.path === s2c.path, 'the same session id gets its own worktree back, marked reused');
  const wtB = mkRepo('wt-b');
  const other = await wtModule.createWorktree({ repo: wtB, sid: 'sess-fixed' });
  assert(other.ok === false, 'a folder that belongs to another repository is never handed out as this repository\'s worktree');

  // merge refuses to run in the wrong place
  const mA = await wtModule.createWorktree({ repo: wtA, sid: 'merge-clean' });
  commitIn(mA.path, 'feature.js', 'module.exports = 1;\n', 'add feature');
  const mainTip0 = rev(wtA, 'main');
  git(['checkout', '-q', '-b', 'elsewhere'], wtA);
  const wrong = await wtModule.mergeWorktree({ repo: wtA, path: mA.path, branch: mA.branch });
  assert(wrong.ok === false && wrong.wrongBranch === true, 'mergeWorktree refuses when the checkout is not on the target branch');
  assert(rev(wtA, 'main') === mainTip0 && rev(wtA, 'elsewhere') === mainTip0 && !fs.existsSync(path.join(wtA, 'feature.js')), 'nothing was merged into the wrong branch');
  git(['checkout', '-q', 'main'], wtA);
  fs.appendFileSync(path.join(wtA, 'lib.js'), '// local edit\n');
  const dirty = await wtModule.mergeWorktree({ repo: wtA, path: mA.path, branch: mA.branch });
  assert(dirty.ok === false && dirty.dirty === true, 'mergeWorktree refuses when the checkout has uncommitted changes to tracked files');
  git(['checkout', '--', 'lib.js'], wtA);
  const mergedOk = await wtModule.mergeWorktree({ repo: wtA, path: mA.path, branch: mA.branch });
  assert(mergedOk.ok === true && fs.existsSync(path.join(wtA, 'feature.js')), 'mergeWorktree merges a clean branch into the checked-out target');
  assert(!fs.existsSync(mA.path) && !branchList(wtA).includes(mA.branch), 'after a successful merge the worktree and its merged branch are removed');

  // a conflict is rolled back, not left in the user's checkout
  const mC = await wtModule.createWorktree({ repo: wtA, sid: 'merge-conflict' });
  commitIn(mC.path, 'lib.js', 'exports.f = (a) => a * 3;\n', 'agent changes f');
  commitIn(wtA, 'lib.js', 'exports.f = (a) => a * 4;\n', 'main changes f');
  const conf = await wtModule.mergeWorktree({ repo: wtA, path: mC.path, branch: mC.branch });
  assert(conf.ok === false && conf.conflict === true && conf.files.includes('lib.js'), 'a conflicting merge reports the conflicted files');
  assert(!fs.existsSync(path.join(wtA, '.git', 'MERGE_HEAD')) && git(['status', '--porcelain'], wtA) === '', 'a conflicting merge is rolled back: no MERGE_HEAD, clean tree');
  assert(fs.existsSync(mC.path) && branchList(wtA).includes(mC.branch), 'after a failed merge the agent worktree and branch are still there');

  // the speculative test runs on the MERGED tree
  const wtG = mkRepo('wt-ghost');
  const gA = await wtModule.createWorktree({ repo: wtG, sid: 'ghost-agent' });
  commitIn(gA.path, 'lib.js', 'exports.f = (a, b) => a * 2 + b;\n', 'f takes b');
  commitIn(gA.path, 'caller1.js', "const {f} = require('./lib'); exports.run = () => f(2, 0);\n", 'update caller');
  commitIn(wtG, 'caller2.js', "const {f} = require('./lib'); exports.run = () => f(2) + 1;\n", 'main adds a caller of the old signature');
  commitIn(wtG, 'test.js', "const c1 = require('./caller1'), c2 = require('./caller2'); process.exit(c1.run() === 4 && c2.run() === 5 ? 0 : 1);\n", 'main tests both callers');
  const tipBefore = rev(wtG, 'main');
  const branchOnly = await wtModule.runSpeculativeTests({ repo: wtG, path: gA.path });
  assert(branchOnly.passed === true, 'precondition: the agent branch passes its own tests');
  const ghost = await wtModule.mergeWorktree({ repo: wtG, path: gA.path, branch: gA.branch, runTests: true });
  assert(ghost.ok === false && ghost.blocked === true && ghost.testsFailed === true, 'mergeWorktree({runTests}) blocks a merge whose RESULT fails the tests, though the branch alone passes (semantic conflict)');
  assert(rev(wtG, 'main') === tipBefore && fs.existsSync(gA.path) && branchList(wtG).includes(gA.branch), 'a blocked merge changes nothing: same main tip, worktree and branch kept');
  assert(!fs.readdirSync(path.join(process.env.AGENT_HQ_WORKTREES, '.landing')).length, 'the scratch worktree used for the merge test is removed');

  // prune and cleanup never destroy work
  const wtP = mkRepo('wt-prune');
  const pRoot = await wtModule.findRepoRoot(wtP);
  const unmergedWt = await wtModule.createWorktree({ repo: wtP, sid: 'unmerged' });
  commitIn(unmergedWt.path, 'important.js', '// work\n', 'agent work');
  const unmergedTip = rev(unmergedWt.path, 'HEAD');
  const mergedWt = await wtModule.createWorktree({ repo: wtP, sid: 'already-merged' });
  commitIn(mergedWt.path, 'done.js', '// done\n', 'done');
  git(['merge', '-q', '--ff-only', mergedWt.branch], wtP);
  const dirtyWt = await wtModule.createWorktree({ repo: wtP, sid: 'dirty-one' });
  fs.writeFileSync(path.join(dirtyWt.path, 'untracked.txt'), 'not committed');
  const liveWt = await wtModule.createWorktree({ repo: wtP, sid: 'live-one' });
  const dry = await wtModule.pruneInactiveWorktrees({ maxAgeHours: 0, repoFilter: pRoot, protect: [liveWt.path], dryRun: true });
  assert(dry.pruned.length === 2 && dry.pruned.every((p) => p.dryRun), 'prune dry run lists exactly the two removable worktrees');
  assert(fs.existsSync(unmergedWt.path) && fs.existsSync(mergedWt.path), 'a dry run removes nothing');
  const pr = await wtModule.pruneInactiveWorktrees({ maxAgeHours: 0, repoFilter: pRoot, protect: [liveWt.path] });
  assert(!fs.existsSync(unmergedWt.path), 'prune removes the idle worktree whose branch has unmerged commits from disk');
  assert(branchList(wtP).includes(unmergedWt.branch) && rev(wtP, unmergedWt.branch) === unmergedTip, 'prune KEEPS that branch and its unmerged commit (it used to delete it with branch -D)');
  assert(!fs.existsSync(mergedWt.path) && !branchList(wtP).includes(mergedWt.branch), 'prune removes a fully merged worktree and its branch (the merged check used to be dead because of git\'s "+" marker)');
  assert(fs.existsSync(dirtyWt.path) && pr.skipped.some((s) => s.name === 'dirty-one'), 'prune skips a worktree with uncommitted or untracked files');
  assert(fs.existsSync(liveWt.path) && pr.skipped.some((s) => s.name === 'live-one' && /live session/.test(s.reason)), 'prune skips a worktree a live session is working in');
  const cl = await wtModule.cleanupWorktree({ repo: wtP, path: dirtyWt.path, branch: dirtyWt.branch });
  assert(cl.ok === false && fs.existsSync(path.join(dirtyWt.path, 'untracked.txt')), 'cleanupWorktree refuses to delete untracked files without force');
  const clKeep = await wtModule.cleanupWorktree({ repo: wtP, path: path.join(TEST_STATE, 'not-a-worktree-dir'), branch: 'nope' });
  assert(clKeep.ok === true && clKeep.removed === false, 'cleanupWorktree on a path that does not exist is a harmless no-op');

  // --- Summary ---
  console.log('\n====================================================');
  console.log(` Test Results: ${passed} PASSED, ${failed} FAILED, ${skipped} SKIPPED`);
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
