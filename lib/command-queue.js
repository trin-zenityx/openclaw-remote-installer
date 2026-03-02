const crypto = require('crypto');

class CommandQueue {
  constructor() {
    this.queue = [];
    this.pendingCommand = null;
  }

  enqueue(command) {
    const id = crypto.randomUUID();
    const entry = { id, command, createdAt: Date.now() };
    this.queue.push(entry);
    return entry;
  }

  dequeue() {
    if (this.queue.length === 0) return null;
    this.pendingCommand = this.queue.shift();
    return this.pendingCommand;
  }

  completePending(id, result) {
    if (this.pendingCommand && this.pendingCommand.id === id) {
      const completed = { ...this.pendingCommand, result };
      this.pendingCommand = null;
      return completed;
    }
    return null;
  }

  hasPending() {
    return this.pendingCommand !== null;
  }

  hasQueued() {
    return this.queue.length > 0;
  }

  clear() {
    this.queue = [];
    this.pendingCommand = null;
  }

  getStatus() {
    return {
      queued: this.queue.length,
      pending: this.pendingCommand ? this.pendingCommand.command : null
    };
  }
}

module.exports = CommandQueue;
