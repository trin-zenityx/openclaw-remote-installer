// --- Socket.IO Connection (uses cookie auth) ---
const socket = io();

// --- State ---
let agentConnected = false;
let connectedAt = null;
let uptimeInterval = null;

// --- DOM Elements ---
const terminal = document.getElementById('terminal');
const cmdInput = document.getElementById('cmd-input');
const runBtn = document.getElementById('run-btn');
const statusDot = document.querySelector('.status-dot');
const statusText = document.getElementById('status-text');
const sysinfoContent = document.getElementById('sysinfo-content');
const aiContent = document.getElementById('ai-content');
const aiBadge = document.getElementById('ai-badge');
const roomIdEl = document.getElementById('room-id');
const studentUrlEl = document.getElementById('student-url');
const uptimeEl = document.getElementById('uptime');
const autoInstallBtn = document.getElementById('auto-install-btn');

// --- DOM Helpers ---
function el(tag, attrs, children) {
  const elem = document.createElement(tag);
  if (attrs) {
    Object.entries(attrs).forEach(([key, val]) => {
      if (key === 'className') elem.className = val;
      else if (key === 'textContent') elem.textContent = val;
      else if (key.startsWith('on')) elem.addEventListener(key.slice(2).toLowerCase(), val);
      else elem.setAttribute(key, val);
    });
  }
  if (children) {
    (Array.isArray(children) ? children : [children]).forEach(child => {
      if (typeof child === 'string') elem.appendChild(document.createTextNode(child));
      else if (child) elem.appendChild(child);
    });
  }
  return elem;
}

function appendTerminal(text, cls = 'stdout') {
  const line = el('div', { className: `terminal-line ${cls}`, textContent: text });
  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;
}

function setConnected(connected) {
  agentConnected = connected;
  statusDot.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
  statusText.textContent = connected ? 'นักเรียนเชื่อมต่อแล้ว' : 'รอนักเรียนเชื่อมต่อ...';

  document.querySelectorAll('.action-btn').forEach(btn => btn.disabled = !connected);
  cmdInput.disabled = !connected;
  runBtn.disabled = !connected;

  if (connected) {
    connectedAt = Date.now();
    uptimeInterval = setInterval(updateUptime, 1000);
  } else {
    clearInterval(uptimeInterval);
    uptimeEl.textContent = '-';
  }
}

function updateUptime() {
  if (!connectedAt) return;
  const diff = Math.floor((Date.now() - connectedAt) / 1000);
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  uptimeEl.textContent = `${m} นาที ${s} วินาที`;
}

function renderSystemInfo(info) {
  if (!info) return;
  const rows = [
    ['OS', info.os],
    ['Arch', info.arch],
    ['Hostname', info.hostname],
    ['User', info.user],
    ['Node.js', info.nodeVersion || 'ยังไม่ติดตั้ง'],
    ['npm', info.npmVersion || 'ยังไม่ติดตั้ง'],
    ['Shell', info.shell],
  ];

  if (info.os === 'windows') {
    rows.push(['WSL2', info.wsl2Status || 'ไม่ทราบ']);
    rows.push(['PowerShell', info.psVersion || 'ไม่ทราบ']);
  }

  const grid = el('div', { className: 'sysinfo-grid' });
  rows.forEach(([label, value]) => {
    const row = el('div', { className: 'sysinfo-row' }, [
      el('span', { className: 'label', textContent: label }),
      el('span', { className: 'value', textContent: value || '-' })
    ]);
    const valueEl = row.querySelector('.value');
    if (value === 'ยังไม่ติดตั้ง' || value === 'not installed' || value === 'ไม่ทราบ' || value === 'unknown') {
      valueEl.style.color = 'var(--red)';
    }
    grid.appendChild(row);
  });

  sysinfoContent.textContent = '';
  sysinfoContent.appendChild(grid);
}

function setAIBadge(state) {
  aiBadge.className = `ai-badge ${state}`;
  aiBadge.textContent = state === 'thinking' ? 'กำลังคิด...' : 'พร้อม';
}

function addAIMessage(text, cls = 'info') {
  const msg = el('div', { className: `ai-message ${cls}`, textContent: text });
  aiContent.appendChild(msg);
  aiContent.scrollTop = aiContent.scrollHeight;
}

function showAISuggestion(data) {
  setAIBadge('ready');

  const container = el('div', { className: 'ai-suggestion' });
  container.appendChild(el('div', { className: 'explanation', textContent: data.explanation }));

  if (data.command) {
    container.appendChild(el('div', { className: 'suggested-cmd', textContent: `$ ${data.command}` }));
  }

  const actions = el('div', { className: 'actions' });

  const approveBtn = el('button', {
    className: 'approve-btn',
    textContent: data.command ? 'อนุมัติ' : 'ดำเนินการต่อ',
    onClick: () => {
      actions.textContent = '';
      const span = el('span', { textContent: 'อนุมัติแล้ว' });
      span.style.cssText = 'color:var(--green);font-size:13px';
      actions.appendChild(span);
      socket.emit('approve-step', { stepId: data.stepId, command: data.command });
    }
  });

  const rejectBtn = el('button', {
    className: 'reject-btn',
    textContent: data.command ? 'ปฏิเสธ' : 'หยุด',
    onClick: () => {
      actions.textContent = '';
      const span = el('span', { textContent: 'ปฏิเสธแล้ว' });
      span.style.cssText = 'color:var(--text-muted);font-size:13px';
      actions.appendChild(span);
      socket.emit('reject-step', { stepId: data.stepId });
    }
  });

  actions.appendChild(approveBtn);
  actions.appendChild(rejectBtn);
  container.appendChild(actions);

  aiContent.appendChild(container);
  aiContent.scrollTop = aiContent.scrollHeight;
}

// --- Socket Events ---

socket.on('connect', () => {
  console.log('Dashboard connected');
});

socket.on('connect_error', (err) => {
  if (err.message === 'Unauthorized' || err.message === 'No room' || err.message === 'Room expired') {
    window.location.href = '/login';
    return;
  }
  appendTerminal('เชื่อมต่อไม่สำเร็จ: ' + err.message, 'stderr');
});

socket.on('init', (data) => {
  // Room info
  if (data.roomId) {
    roomIdEl.textContent = data.roomId;
  }
  if (data.studentUrl) {
    studentUrlEl.textContent = data.studentUrl;
  }

  if (data.agentConnected && data.systemInfo) {
    setConnected(true);
    renderSystemInfo(data.systemInfo);
    appendTerminal('นักเรียนเชื่อมต่ออยู่แล้ว', 'info');
  }

  if (data.commandHistory && data.commandHistory.length > 0) {
    data.commandHistory.forEach(entry => {
      appendTerminal(entry.command, 'command');
      if (entry.stdout) appendTerminal(entry.stdout, 'stdout');
      if (entry.stderr) appendTerminal(entry.stderr, 'stderr');
      const exitCls = entry.exitCode === 0 ? 'exit-ok' : 'exit-fail';
      appendTerminal(`Exit code: ${entry.exitCode}`, exitCls);
    });
  }

  if (!data.hasAI) {
    aiContent.textContent = '';
    addAIMessage('AI ยังไม่พร้อม กรุณาตั้งค่า ANTHROPIC_API_KEY เพื่อเปิดใช้งาน AI ช่วยติดตั้ง', 'info');
    autoInstallBtn.disabled = true;
  }
});

socket.on('agent-connected', (data) => {
  setConnected(true);
  renderSystemInfo(data.systemInfo);
  terminal.textContent = '';
  appendTerminal('นักเรียนเชื่อมต่อแล้ว!', 'info');
  if (data.systemInfo) {
    appendTerminal(`OS: ${data.systemInfo.os} | Node: ${data.systemInfo.nodeVersion} | Host: ${data.systemInfo.hostname}`, 'info');
  }
});

socket.on('agent-disconnected', () => {
  setConnected(false);
  appendTerminal('นักเรียนตัดการเชื่อมต่อ', 'stderr');
});

socket.on('room-expired', () => {
  appendTerminal('ห้องเรียนหมดเวลาแล้ว กรุณาเข้าสู่ระบบใหม่', 'stderr');
  setTimeout(() => { window.location.href = '/login'; }, 3000);
});

socket.on('command-queued', (data) => {
  appendTerminal(data.command, 'command');
});

socket.on('command-executing', () => {});

socket.on('command-output', (data) => {
  if (data.stdout) appendTerminal(data.stdout, 'stdout');
  if (data.stderr) appendTerminal(data.stderr, 'stderr');
  const exitCls = data.exitCode === 0 ? 'exit-ok' : 'exit-fail';
  appendTerminal(`Exit code: ${data.exitCode}`, exitCls);
});

socket.on('ai-thinking', (data) => {
  setAIBadge('thinking');
  addAIMessage(data.message, 'info');
});

socket.on('ai-suggestion', (data) => {
  showAISuggestion(data);
});

socket.on('ai-error', (data) => {
  setAIBadge('ready');
  addAIMessage('AI Error: ' + data.error, 'error');
});

socket.on('install-complete', (data) => {
  setAIBadge('ready');
  const msg = el('div', { className: 'ai-message', textContent: 'ติดตั้งเสร็จสมบูรณ์! ' + (data.summary || '') });
  msg.style.color = 'var(--green)';
  aiContent.appendChild(msg);
  appendTerminal('=== ติดตั้งเสร็จสมบูรณ์! ===', 'exit-ok');
});

socket.on('error-msg', (data) => {
  appendTerminal(data.message, 'stderr');
});

// --- Status Polling Fallback (in case Socket.IO events are lost) ---

let statusPollInterval = null;

function startStatusPolling() {
  if (statusPollInterval) return;
  statusPollInterval = setInterval(async () => {
    try {
      const res = await fetch('/api/dashboard/status');
      if (!res.ok) {
        if (res.status === 404) {
          // Room expired
          window.location.href = '/login';
        }
        return;
      }
      const data = await res.json();

      // Sync agent status if out of sync
      if (data.agentConnected && !agentConnected) {
        console.log('Status poll: agent connected (Socket.IO event was missed)');
        setConnected(true);
        if (data.systemInfo) renderSystemInfo(data.systemInfo);
        appendTerminal('นักเรียนเชื่อมต่อแล้ว! (sync)', 'info');
      } else if (!data.agentConnected && agentConnected) {
        console.log('Status poll: agent disconnected (Socket.IO event was missed)');
        setConnected(false);
        appendTerminal('นักเรียนตัดการเชื่อมต่อ (sync)', 'stderr');
      }
    } catch (e) {
      // Network error, ignore
    }
  }, 5000); // Poll every 5 seconds
}

startStatusPolling();

// --- Actions ---

function runCommand() {
  const cmd = cmdInput.value.trim();
  if (!cmd) return;
  socket.emit('run-command', { command: cmd });
  cmdInput.value = '';
  cmdInput.focus();
}

window.runQuickCommand = function(cmd) {
  socket.emit('run-command', { command: cmd });
  appendTerminal(cmd, 'command');
};

window.autoInstall = function() {
  aiContent.textContent = '';
  socket.emit('auto-install');
};

window.copyStudentUrl = function() {
  const url = studentUrlEl.textContent;
  if (!url || url === '-') return;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('copy-url-btn');
    btn.textContent = 'คัดลอกแล้ว!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'คัดลอก'; btn.classList.remove('copied'); }, 2000);
  });
};

function clearTerminal() {
  terminal.textContent = '';
  if (agentConnected) {
    appendTerminal('ล้าง Terminal แล้ว', 'info');
  }
}

window.runCommand = runCommand;
window.clearTerminal = clearTerminal;
