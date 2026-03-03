require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server: SocketIO } = require('socket.io');

const { RoomManager } = require('./lib/room-manager');
const { startTunnel } = require('./lib/tunnel');

// --- Config ---
const PORT = process.env.PORT || 3000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'teacher123';
const IS_CLOUD = !!(process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RENDER_EXTERNAL_URL || process.env.CLOUD_URL);

// --- State ---
const roomManager = new RoomManager(process.env.ANTHROPIC_API_KEY || null);
let publicUrl = null;

// --- Express ---
const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Middleware ---
function requireAgentToken(req, res, next) {
  const token = req.headers['x-agent-token'];
  const room = roomManager.getRoomByToken(token);
  if (!room) {
    return res.status(401).json({ error: 'Invalid agent token' });
  }
  req.room = room;
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

function extractRoomId(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/room_id=([^;]+)/);
  return match ? match[1] : null;
}

// --- Public Routes ---

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', rooms: roomManager.rooms.size });
});

// Login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === DASHBOARD_PASSWORD) {
    const hash = hashPassword(DASHBOARD_PASSWORD);
    const room = roomManager.createRoom();

    res.setHeader('Set-Cookie', [
      `dashboard_auth=${hash}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
      `room_id=${room.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`
    ]);
    console.log(`Room ${room.id} created`);
    res.json({ success: true, roomId: room.id });
  } else {
    res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
  }
});

// Dashboard (requires login + valid room)
app.get('/dashboard', requireDashboardAuth, (req, res) => {
  const roomId = extractRoomId(req);
  if (!roomId || !roomManager.getRoom(roomId)) {
    res.setHeader('Set-Cookie', 'room_id=; Path=/; Max-Age=0');
    return res.redirect('/login');
  }
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// --- Room-Specific Student Routes ---

// Student landing page
app.get('/r/:roomId', (req, res) => {
  const room = roomManager.getRoom(req.params.roomId);
  if (!room) {
    return res.status(404).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#ffffff;color:#1e293b">
        <h2>ห้องเรียนไม่พบ หรือหมดเวลาแล้ว</h2>
        <p style="color:#64748b">กรุณาขอ URL ใหม่จากอาจารย์</p>
      </body></html>
    `);
  }
  res.sendFile(path.join(__dirname, 'public', 'student.html'));
});

// Room-specific agent script download
app.get('/r/:roomId/agent/:os', (req, res) => {
  const room = roomManager.getRoom(req.params.roomId);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

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
    script = script.replace(/AGENT_TOKEN_PLACEHOLDER/g, room.agentToken);
    res.send(script);
  } catch (err) {
    res.status(500).json({ error: 'Agent script not found' });
  }
});

// --- Agent API Routes ---

app.post('/api/agent/register', requireAgentToken, (req, res) => {
  const room = req.room;

  if (room.session.isSameAgent(req.body)) {
    // Same agent reconnecting - preserve history & AI context
    room.session.reconnectAgent(req.body);
    console.log(`Agent reconnected to room ${room.id}: ${req.body.hostname || 'unknown'} (${req.body.os})`);

    if (room.teacherSocket) {
      room.teacherSocket.emit('agent-reconnected', {
        systemInfo: req.body,
        commandHistory: room.session.commandHistory
      });
    }
  } else {
    // New/different agent - full reset
    if (room.session.agentConnected) {
      room.session.reset();
    }
    room.session.registerAgent(req.body);

    if (room.aiHelper) {
      room.aiHelper.resetConversation();
    }

    console.log(`Agent connected to room ${room.id}: ${req.body.hostname || 'unknown'} (${req.body.os})`);

    if (room.teacherSocket) {
      room.teacherSocket.emit('agent-connected', { systemInfo: req.body });
    }
  }

  res.json({ status: 'registered' });
});

app.get('/api/agent/poll', requireAgentToken, (req, res) => {
  const room = req.room;
  if (!room.session.agentConnected) {
    return res.status(403).json({ error: 'Not registered' });
  }

  room.session.heartbeat();

  const nextCommand = room.commandQueue.dequeue();
  if (nextCommand) {
    if (room.teacherSocket) {
      room.teacherSocket.emit('command-executing', { id: nextCommand.id, command: nextCommand.command });
    }
    return res.json({ id: nextCommand.id, command: nextCommand.command });
  }

  res.status(204).end();
});

app.post('/api/agent/result', requireAgentToken, (req, res) => {
  const room = req.room;
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

  const completed = room.commandQueue.completePending(id, {
    stdout: decodedStdout,
    stderr: decodedStderr,
    exitCode
  });

  if (completed) {
    room.session.addCommandResult(id, completed.command, {
      stdout: decodedStdout,
      stderr: decodedStderr,
      exitCode
    });
  }

  if (room.teacherSocket) {
    room.teacherSocket.emit('command-output', {
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
  req.room.session.heartbeat();
  res.json({ status: 'ok' });
});

// --- Dashboard Status API (fallback for Socket.IO) ---

app.get('/api/dashboard/status', requireDashboardAuth, (req, res) => {
  const roomId = extractRoomId(req);
  const room = roomManager.getRoom(roomId);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  const studentUrl = publicUrl ? `${publicUrl}/r/${room.id}` : `http://localhost:${PORT}/r/${room.id}`;
  res.json({
    roomId: room.id,
    studentUrl,
    agentConnected: room.session.agentConnected,
    systemInfo: room.session.systemInfo,
    hasAI: !!room.aiHelper,
    publicUrl
  });
});

// --- Socket.IO (Dashboard) ---

const io = new SocketIO(server, {
  transports: ['polling', 'websocket'],
  pingTimeout: 60000,
  pingInterval: 25000
});

io.use((socket, next) => {
  const cookie = socket.handshake.headers.cookie || '';

  const authMatch = cookie.match(/dashboard_auth=([^;]+)/);
  if (!authMatch || authMatch[1] !== hashPassword(DASHBOARD_PASSWORD)) {
    return next(new Error('Unauthorized'));
  }

  const roomMatch = cookie.match(/room_id=([^;]+)/);
  if (!roomMatch) {
    return next(new Error('No room'));
  }

  const room = roomManager.getRoom(roomMatch[1]);
  if (!room) {
    return next(new Error('Room expired'));
  }

  socket.roomId = room.id;
  return next();
});

io.on('connection', (socket) => {
  const room = roomManager.getRoom(socket.roomId);
  if (!room) {
    socket.emit('error-msg', { message: 'ห้องหมดอายุแล้ว' });
    socket.disconnect(true);
    return;
  }

  console.log(`Teacher connected to room ${room.id}`);
  room.teacherSocket = socket;

  const studentUrl = publicUrl ? `${publicUrl}/r/${room.id}` : `http://localhost:${PORT}/r/${room.id}`;

  socket.emit('init', {
    roomId: room.id,
    studentUrl,
    agentConnected: room.session.agentConnected,
    systemInfo: room.session.systemInfo,
    commandHistory: room.session.commandHistory,
    publicUrl,
    queueStatus: room.commandQueue.getStatus(),
    hasAI: !!room.aiHelper
  });

  socket.on('run-command', ({ command }) => {
    if (!room.session.agentConnected) {
      socket.emit('error-msg', { message: 'ยังไม่มีนักเรียนเชื่อมต่อ' });
      return;
    }
    const entry = room.commandQueue.enqueue(command);
    socket.emit('command-queued', { id: entry.id, command });
  });

  socket.on('auto-install', async () => {
    if (!room.aiHelper) {
      socket.emit('error-msg', { message: 'ยังไม่ได้ตั้งค่า API Key กรุณาตั้งค่า ANTHROPIC_API_KEY' });
      return;
    }
    if (!room.session.agentConnected) {
      socket.emit('error-msg', { message: 'ยังไม่มีนักเรียนเชื่อมต่อ' });
      return;
    }

    room.aiHelper.resetConversation();
    room.session.installationState = 'gathering-info';
    socket.emit('ai-thinking', { message: 'AI กำลังวิเคราะห์ระบบ...' });

    try {
      const suggestion = await room.aiHelper.analyzeAndSuggest(room.session);
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
        const suggestion = await room.aiHelper.analyzeAndSuggest(room.session);
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

    const entry = room.commandQueue.enqueue(command);
    socket.emit('command-queued', { id: entry.id, command });

    const waitForResult = () => {
      const checkInterval = setInterval(async () => {
        const lastEntry = room.session.commandHistory.find(h => h.id === entry.id);
        if (lastEntry) {
          clearInterval(checkInterval);

          if (room.aiHelper) {
            await room.aiHelper.feedResult(command, lastEntry.stdout, lastEntry.stderr, lastEntry.exitCode);
            socket.emit('ai-thinking', { message: 'AI กำลังวิเคราะห์ผลลัพธ์...' });

            try {
              const suggestion = await room.aiHelper.analyzeAndSuggest(room.session);
              if (suggestion.isLast) {
                room.session.installationState = 'complete';
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

  socket.on('ai-chat', async ({ message }) => {
    if (!room.aiHelper) {
      socket.emit('error-msg', { message: 'ยังไม่ได้ตั้งค่า API Key กรุณาตั้งค่า ANTHROPIC_API_KEY' });
      return;
    }
    if (!room.session.agentConnected) {
      socket.emit('error-msg', { message: 'ยังไม่มีนักเรียนเชื่อมต่อ' });
      return;
    }
    if (!message || !message.trim()) return;

    socket.emit('ai-user-message', { message: message.trim() });
    socket.emit('ai-thinking', { message: 'AI กำลังคิด...' });

    try {
      const suggestion = await room.aiHelper.chat(message.trim(), room.session);

      if (suggestion.isLast) {
        room.session.installationState = 'complete';
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
  });

  socket.on('reject-step', () => {
    socket.emit('ai-thinking', { message: 'ข้ามขั้นตอนนี้แล้ว สามารถพิมพ์คำสั่งเอง หรือกด Auto Install ใหม่ได้' });
  });

  socket.on('cancel', () => {
    room.commandQueue.clear();
    socket.emit('error-msg', { message: 'ล้างคิวคำสั่งแล้ว' });
  });

  socket.on('disconnect', () => {
    console.log(`Teacher disconnected from room ${room.id}`);
    room.teacherSocket = null;
  });
});

// --- Heartbeat checker (all rooms) ---
setInterval(() => {
  for (const [id, room] of roomManager.rooms) {
    if (room.session.agentConnected && !room.session.isAgentAlive(30000)) {
      console.log(`Agent heartbeat timeout in room ${id}`);
      room.session.disconnectAgent();
      if (room.teacherSocket) {
        room.teacherSocket.emit('agent-disconnected', {});
      }
    }
  }
}, 10000);

// --- Room cleanup (every 5 minutes) ---
setInterval(() => {
  roomManager.cleanup(2 * 60 * 60 * 1000); // 2 hours TTL
}, 5 * 60 * 1000);

// --- Start ---
async function start() {
  server.listen(PORT, '0.0.0.0', async () => {
    console.log('');
    console.log('========================================');
    console.log('  OpenClaw Remote Installer (Multi-Room)');
    console.log('========================================');
    console.log('');

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
    console.log('  อาจารย์แต่ละคน Login → สร้างห้อง → ส่ง URL ให้นักเรียน');
    console.log('========================================');
    console.log('');
  });
}

start();
