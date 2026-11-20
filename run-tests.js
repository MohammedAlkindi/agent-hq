// run-tests.js - Full verification suite for Agent HQ Multi-Agent & Animation Expansion
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
const TEST_PORT = 7795;

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
  console.log(' Starting Agent HQ Multi-Agent & Animation Test Suite');
  console.log('====================================================\n');

  // --- 1. Syntax Verification ---
  console.log('--- 1. Syntax Verification ---');
  const dashCheck = await runCommand('node', ['--check', AGENT_DASH]);
  assert(dashCheck.code === 0, 'agent-dashboard.js syntax is valid');

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

  // --- 2. HTML and Frontend Script Validation ---
  console.log('\n--- 2. Frontend HTML & Script Validation ---');
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

  // Verify visual creativity elements
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

  // --- 3. Backend Snapshot CLI Mode (--json) ---
  console.log('\n--- 3. Backend Snapshot CLI Mode (--json) ---');
  const jsonRun = await runCommand('node', [AGENT_DASH, '--json']);
  assert(jsonRun.code === 0, 'node agent-dashboard.js --json exits with code 0');

  let snapshot;
  try {
    snapshot = JSON.parse(jsonRun.stdout);
    assert(true, 'node --json produces valid parseable JSON');
  } catch (e) {
    assert(false, `node --json JSON parse failed: ${e.message}`);
  }

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

    // Verify session normalization schema
    const sample = snapshot.sessions[0];
    const requiredFields = ['id', 'harness', 'turns', 'state', 'model', 'metrics'];
    const hasAllFields = requiredFields.every((f) => sample && sample[f] !== undefined);
    assert(hasAllFields, `Sessions contain normalized schema fields: ${requiredFields.join(', ')}`);
  }

  // --- 4. Live Server HTTP & SSE Integration ---
  console.log('\n--- 4. Live Server HTTP & SSE Integration ---');
  const env = { ...process.env, AGENT_DASH_PORT: String(TEST_PORT) };
  const serverProc = cp.spawn('node', [AGENT_DASH], { env, stdio: ['ignore', 'pipe', 'pipe'] });

  let serverStarted = false;
  serverProc.stdout.on('data', (d) => {
    if (d.toString().includes(String(TEST_PORT))) serverStarted = true;
  });

  // Wait for server to start
  await new Promise((r) => setTimeout(r, 2000));

  try {
    // Test GET /
    const rootRes = await fetchHttp(`http://127.0.0.1:${TEST_PORT}/`);
    assert(rootRes.status === 200, `GET / returns HTTP 200 OK (size: ${rootRes.body.length})`);
    assert(rootRes.headers['content-type'] && rootRes.headers['content-type'].includes('text/html'), 'GET / Content-Type is text/html');
    assert(rootRes.body.includes('Agent HQ'), 'GET / HTML body contains Agent HQ title');

    // Test GET /api/state
    const stateRes = await fetchHttp(`http://127.0.0.1:${TEST_PORT}/api/state`);
    assert(stateRes.status === 200, 'GET /api/state returns HTTP 200 OK');
    const stateJson = JSON.parse(stateRes.body);
    assert(stateJson.sessions && stateJson.sessions.length > 0, `GET /api/state returns populated sessions (${stateJson.sessions.length})`);

    // Test GET /api/perf
    const perf1h = await fetchHttp(`http://127.0.0.1:${TEST_PORT}/api/perf?range=1h`);
    assert(perf1h.status === 200, 'GET /api/perf?range=1h returns HTTP 200 OK');
    const perf1hJson = JSON.parse(perf1h.body);
    assert(perf1hJson.range === '1h' && perf1hJson.kpi, 'GET /api/perf returns valid KPI performance metrics');

    const perf24h = await fetchHttp(`http://127.0.0.1:${TEST_PORT}/api/perf?range=24h`);
    assert(perf24h.status === 200, 'GET /api/perf?range=24h returns HTTP 200 OK');

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

  } finally {
    serverProc.kill('SIGKILL');
  }

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
