require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server: SocketIO } = require('socket.io');

const Session = require('./lib/session');
const CommandQueue = require('./lib/command-queue');
const AIHelper = require('./lib/ai-helper');
const { startTunnel } = require('./lib/tunnel');

// --- Config ---
const PORT = process.env.PORT || 3000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'teacher123';
const AGENT_TOKEN = process.env.AGENT_TOKEN || crypto.randomBytes(16).toString('hex');
const IS_CLOUD = !!(process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RENDER_EXTERNAL_URL || process.env.CLOUD_URL);

// --- State ---
const session = new Session();
const commandQueue = new CommandQueue();
let aiHelper = null;
let publicUrl = null;
let teacherSocket = null;

if (process.env.ANTHROPIC_API_KEY) {
  aiHelper = new AIHelper(process.env.ANTHROPIC_API_KEY);
}

// --- Express ---
const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Middleware ---
function requireAgentToken(req, res, next) {
  const token = req.headers['x-agent-token'];
  if (token !== AGENT_TOKEN) {
    return res.status(401).json({ error: 'Invalid agent token' });
  }
  next();
}

function requireDashboardAuth(req, res, next) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/dashboard_auth=([^;]+)/);
  if (match && match[1] === hashPassword(DASHBOARD_PASSWORD)) {
    return next();
  }
  res.redirect('/login');
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw + 'openclaw-salt').digest('hex').slice(0, 32);
}

// --- Public Routes ---

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', agentConnected: session.agentConnected });
});

// Login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === DASHBOARD_PASSWORD) {
    const hash = hashPassword(DASHBOARD_PASSWORD);
    res.setHeader('Set-Cookie', `dashboard_auth=${hash}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
  }
});

// Serve agent scripts with baked-in config
app.get('/api/agent-script/:os', (req, res) => {
  const os = req.params.os;
  const serverUrl = publicUrl || `http://localhost:${PORT}`;
  let filename;

  if (os === 'mac' || os === 'linux') {
    filename = 'agent.sh';
    res.setHeader('Content-Type', 'text/plain');
  } else if (os === 'windows') {
    filename = 'agent.ps1';
    res.setHeader('Content-Type', 'text/plain');
  } else {
    return res.status(400).json({ error: 'Invalid OS' });
  }

  const filePath = path.join(__dirname, 'agents', filename);
  try {
    let script = fs.readFileSync(filePath, 'utf-8');
    script = script.replace(/SERVER_URL_PLACEHOLDER/g, serverUrl);
    script = script.replace(/AGENT_TOKEN_PLACEHOLDER/g, AGENT_TOKEN);
    res.send(script);
  } catch (err) {
    res.status(500).json({ error: 'Agent script not found' });
  }
});

// Dashboard (requires login)
app.get('/dashboard', requireDashboardAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// --- Agent API Routes ---

app.post('/api/agent/register', requireAgentToken, (req, res) => {
  if (session.agentConnected) {
    session.reset();
  }
  session.registerAgent(req.body);

  if (teacherSocket) {
    teacherSocket.emit('agent-connected', { systemInfo: req.body });
  }

  console.log(`Agent connected: ${req.body.hostname || 'unknown'} (${req.body.os})`);
  res.json({ status: 'registered' });
});

app.get('/api/agent/poll', requireAgentToken, (req, res) => {
  if (!session.agentConnected) {
    return res.status(403).json({ error: 'Not registered' });
  }

  session.heartbeat();

  const nextCommand = commandQueue.dequeue();
  if (nextCommand) {
    if (teacherSocket) {
      teacherSocket.emit('command-executing', { id: nextCommand.id, command: nextCommand.command });
    }
    return res.json({ id: nextCommand.id, command: nextCommand.command });
  }

  res.status(204).end();
});

app.post('/api/agent/result', requireAgentToken, (req, res) => {
  const { id, stdout, stderr, exitCode, encoding } = req.body;

  let decodedStdout = stdout || '';
  let decodedStderr = stderr || '';

  if (encoding === 'base64') {
    try {
      decodedStdout = Buffer.from(stdout || '', 'base64').toString('utf-8');
      decodedStderr = Buffer.from(stderr || '', 'base64').toString('utf-8');
    } catch (e) {
      // Use raw if base64 decode fails
    }
  }

  const completed = commandQueue.completePending(id, {
    stdout: decodedStdout,
    stderr: decodedStderr,
    exitCode
  });

  if (completed) {
    session.addCommandResult(id, completed.command, {
      stdout: decodedStdout,
      stderr: decodedStderr,
      exitCode
    });
  }

  if (teacherSocket) {
    teacherSocket.emit('command-output', {
      id,
      command: completed ? completed.command : null,
      stdout: decodedStdout,
      stderr: decodedStderr,
      exitCode
    });
  }

  res.json({ status: 'received' });
});

app.post('/api/agent/heartbeat', requireAgentToken, (req, res) => {
  session.heartbeat();
  res.json({ status: 'ok' });
});

// --- Socket.IO (Dashboard) ---

const io = new SocketIO(server);

io.use((socket, next) => {
  const cookie = socket.handshake.headers.cookie || '';
  const match = cookie.match(/dashboard_auth=([^;]+)/);
  if (match && match[1] === hashPassword(DASHBOARD_PASSWORD)) {
    return next();
  }
  return next(new Error('Unauthorized'));
});

io.on('connection', (socket) => {
  console.log('Teacher dashboard connected');
  teacherSocket = socket;

  socket.emit('init', {
    agentConnected: session.agentConnected,
    systemInfo: session.systemInfo,
    commandHistory: session.commandHistory,
    publicUrl,
    queueStatus: commandQueue.getStatus(),
    hasAI: !!aiHelper
  });

  socket.on('run-command', ({ command }) => {
    if (!session.agentConnected) {
      socket.emit('error-msg', { message: 'ยังไม่มีนักเรียนเชื่อมต่อ' });
      return;
    }
    const entry = commandQueue.enqueue(command);
    socket.emit('command-queued', { id: entry.id, command });
  });

  socket.on('auto-install', async () => {
    if (!aiHelper) {
      socket.emit('error-msg', { message: 'ยังไม่ได้ตั้งค่า API Key กรุณาตั้งค่า ANTHROPIC_API_KEY' });
      return;
    }
    if (!session.agentConnected) {
      socket.emit('error-msg', { message: 'ยังไม่มีนักเรียนเชื่อมต่อ' });
      return;
    }

    aiHelper.resetConversation();
    session.installationState = 'gathering-info';
    socket.emit('ai-thinking', { message: 'AI กำลังวิเคราะห์ระบบ...' });

    try {
      const suggestion = await aiHelper.analyzeAndSuggest(session);
      socket.emit('ai-suggestion', {
        stepId: crypto.randomUUID(),
        command: suggestion.command,
        explanation: suggestion.explanation,
        isLast: suggestion.isLast
      });
    } catch (err) {
      socket.emit('ai-error', { error: err.message });
    }
  });

  socket.on('approve-step', async ({ stepId, command }) => {
    if (!command) {
      socket.emit('ai-thinking', { message: 'AI กำลังคิด...' });
      try {
        const suggestion = await aiHelper.analyzeAndSuggest(session);
        socket.emit('ai-suggestion', {
          stepId: crypto.randomUUID(),
          command: suggestion.command,
          explanation: suggestion.explanation,
          isLast: suggestion.isLast
        });
      } catch (err) {
        socket.emit('ai-error', { error: err.message });
      }
      return;
    }

    const entry = commandQueue.enqueue(command);
    socket.emit('command-queued', { id: entry.id, command });

    const waitForResult = () => {
      const checkInterval = setInterval(async () => {
        const lastEntry = session.commandHistory.find(h => h.id === entry.id);
        if (lastEntry) {
          clearInterval(checkInterval);

          if (aiHelper) {
            await aiHelper.feedResult(command, lastEntry.stdout, lastEntry.stderr, lastEntry.exitCode);
            socket.emit('ai-thinking', { message: 'AI กำลังวิเคราะห์ผลลัพธ์...' });

            try {
              const suggestion = await aiHelper.analyzeAndSuggest(session);
              if (suggestion.isLast) {
                session.installationState = 'complete';
                socket.emit('install-complete', { summary: suggestion.explanation });
              } else {
                socket.emit('ai-suggestion', {
                  stepId: crypto.randomUUID(),
                  command: suggestion.command,
                  explanation: suggestion.explanation,
                  isLast: false
                });
              }
            } catch (err) {
              socket.emit('ai-error', { error: err.message });
            }
          }
        }
      }, 1000);

      setTimeout(() => clearInterval(checkInterval), 300000);
    };

    waitForResult();
  });

  socket.on('reject-step', () => {
    socket.emit('ai-thinking', { message: 'ข้ามขั้นตอนนี้แล้ว สามารถพิมพ์คำสั่งเอง หรือกด Auto Install ใหม่ได้' });
  });

  socket.on('cancel', () => {
    commandQueue.clear();
    socket.emit('error-msg', { message: 'ล้างคิวคำสั่งแล้ว' });
  });

  socket.on('disconnect', () => {
    console.log('Teacher dashboard disconnected');
    teacherSocket = null;
  });
});

// --- Heartbeat checker ---
setInterval(() => {
  if (session.agentConnected && !session.isAgentAlive(30000)) {
    console.log('Agent heartbeat timeout - disconnecting');
    session.disconnectAgent();
    if (teacherSocket) {
      teacherSocket.emit('agent-disconnected', {});
    }
  }
}, 10000);

// --- Start ---
async function start() {
  server.listen(PORT, '0.0.0.0', async () => {
    console.log('');
    console.log('========================================');
    console.log('  OpenClaw Remote Installer');
    console.log('========================================');
    console.log('');

    // Determine public URL
    if (process.env.RAILWAY_PUBLIC_DOMAIN) {
      publicUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
      console.log(`  Cloud:     ${publicUrl}`);
      console.log(`  Platform:  Railway`);
    } else if (process.env.RENDER_EXTERNAL_URL) {
      publicUrl = process.env.RENDER_EXTERNAL_URL;
      console.log(`  Cloud:     ${publicUrl}`);
      console.log(`  Platform:  Render`);
    } else if (process.env.CLOUD_URL) {
      publicUrl = process.env.CLOUD_URL;
      console.log(`  Cloud:     ${publicUrl}`);
    } else {
      console.log(`  Local:     http://localhost:${PORT}`);
      // Start tunnel for local development
      try {
        const tunnel = await startTunnel(PORT);
        publicUrl = tunnel.url;
        console.log(`  Tunnel:    ${publicUrl}`);
        console.log(`  Provider:  ${tunnel.provider}`);
      } catch (err) {
        console.log(`  Tunnel:    FAILED (${err.message})`);
        publicUrl = `http://localhost:${PORT}`;
      }
    }

    console.log('');
    console.log(`  Dashboard: ${publicUrl}/dashboard`);
    console.log(`  Password:  ${DASHBOARD_PASSWORD}`);
    console.log('');
    console.log(`  Agent Token: ${AGENT_TOKEN}`);
    console.log('');
    console.log('  ส่ง URL นี้ให้นักเรียน: ' + publicUrl);
    console.log('  เปิด Dashboard ในเบราว์เซอร์ของคุณ');
    console.log('========================================');
    console.log('');
  });
}

start();
