/**
 * Agent 启动器
 * 运行: node launcher.js
 * 功能: 一键启动/停止 Agent 服务，提供控制 API
 * API: http://localhost:3457
 *   GET  /health  ->  { running: true, agentUrl: "http://localhost:3456" }
 *   POST /start   ->  启动 Agent 服务
 *   POST /stop    ->  停止 Agent 服务
 */
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const AGENT_DIR = path.join(__dirname, 'simple-agent');
const AGENT_PORT = 3456;
const LAUNCHER_PORT = 3457;

let agentProcess = null;
let agentOnline = false;

function startAgent() {
  if (agentProcess) {
    try { agentProcess.kill('SIGTERM'); } catch {}
    agentProcess = null;
    agentOnline = false;
  }

  const cmd = process.platform === 'win32' ? 'node.exe' : 'node';
  agentProcess = spawn(cmd, ['server.js'], {
    cwd: AGENT_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    env: { ...process.env, PORT: String(AGENT_PORT) }
  });

  agentProcess.stdout.on('data', (d) => {
    const s = d.toString().trim();
    if (s) console.log(`[Agent] ${s}`);
    // 检测中英文启动成功的标志
    if (s.includes('listening') || s.includes('running') || s.includes('port') ||
        s.includes('运行') || s.includes('启动') || s.includes('localhost')) {
      agentOnline = true;
    }
  });

  agentProcess.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s) console.log(`[Agent:err] ${s}`);
  });

  agentProcess.on('close', (code) => {
    console.log(`[Agent] 已退出 (code: ${code})`);
    agentProcess = null;
    agentOnline = false;
  });

  agentProcess.on('error', (err) => {
    console.error(`[Agent] 启动失败:`, err.message);
    agentProcess = null;
    agentOnline = false;
  });

  console.log(`[Launcher] Agent 服务启动中... (端口 ${AGENT_PORT})`);
}

function stopAgent() {
  if (agentProcess) {
    agentProcess.kill('SIGTERM');
    agentProcess = null;
    agentOnline = false;
    console.log(`[Launcher] Agent 服务已停止`);
  }
}

// 简单 CORS 响应
function jsonRes(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

// Launcher HTTP API
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (method === 'GET' && url === '/health') {
    jsonRes(res, { running: agentProcess !== null, agentOnline, agentUrl: `http://localhost:${AGENT_PORT}` });
    return;
  }

  if (method === 'POST' && url === '/start') {
    startAgent();
    jsonRes(res, { status: 'started', message: 'Agent 服务启动中，请稍候...' });
    return;
  }

  if (method === 'POST' && url === '/stop') {
    stopAgent();
    jsonRes(res, { status: 'stopped' });
    return;
  }

  jsonRes(res, { error: 'Not Found' }, 404);
});

server.listen(LAUNCHER_PORT, () => {
  console.log('='.repeat(50));
  console.log('  AI 面试助手 · Agent 启动器');
  console.log('='.repeat(50));
  console.log();
  console.log(`  控制面板: http://localhost:${LAUNCHER_PORT}`);
  console.log(`  Agent端口: ${AGENT_PORT}`);
  console.log();
  console.log(`  可用 API:`);
  console.log(`    GET  /health  查看运行状态`);
  console.log(`    POST /start   启动 Agent`);
  console.log(`    POST /stop    停止 Agent`);
  console.log();
  console.log(`  请在网页「设置」→「Agent 服务」中：`);
  console.log(`  1. 服务地址填写: http://localhost:${LAUNCHER_PORT}`);
  console.log(`  2. 使用「一键启动」按钮控制 Agent`);
  console.log();
});
