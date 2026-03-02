class Session {
  constructor() {
    this.reset();
  }

  reset() {
    this.agentConnected = false;
    this.systemInfo = null;
    this.commandHistory = [];
    this.installationState = 'idle'; // idle | gathering-info | installing | complete | error
    this.aiConversation = [];
    this.connectedAt = null;
    this.lastHeartbeat = null;
  }

  registerAgent(systemInfo) {
    this.agentConnected = true;
    this.systemInfo = systemInfo;
    this.connectedAt = Date.now();
    this.lastHeartbeat = Date.now();
    this.commandHistory = [];
    this.aiConversation = [];
    this.installationState = 'idle';
  }

  disconnectAgent() {
    this.agentConnected = false;
  }

  heartbeat() {
    this.lastHeartbeat = Date.now();
  }

  isAgentAlive(timeoutMs = 30000) {
    if (!this.agentConnected) return false;
    if (!this.lastHeartbeat) return false;
    return (Date.now() - this.lastHeartbeat) < timeoutMs;
  }

  addCommandResult(id, command, result) {
    this.commandHistory.push({
      id,
      command,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timestamp: Date.now()
    });
  }

  getContextForAI() {
    const history = this.commandHistory.map(entry => {
      let output = '';
      if (entry.stdout) output += entry.stdout;
      if (entry.stderr) output += `\n[stderr] ${entry.stderr}`;
      return `$ ${entry.command}\nExit code: ${entry.exitCode}\n${output}`;
    }).join('\n\n');

    return {
      systemInfo: this.systemInfo,
      commandHistory: history,
      historyEntries: this.commandHistory
    };
  }
}

module.exports = Session;
