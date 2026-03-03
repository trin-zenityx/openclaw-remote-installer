const crypto = require('crypto');
const Session = require('./session');
const CommandQueue = require('./command-queue');
const AIHelper = require('./ai-helper');

class Room {
  constructor(id, apiKey) {
    this.id = id;
    this.agentToken = crypto.randomBytes(16).toString('hex');
    this.session = new Session();
    this.commandQueue = new CommandQueue();
    this.aiHelper = apiKey ? new AIHelper(apiKey) : null;
    this.teacherSocket = null;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
  }

  touch() {
    this.lastActivity = Date.now();
  }
}

class RoomManager {
  constructor(apiKey) {
    this.rooms = new Map();       // roomId -> Room
    this.tokenIndex = new Map();  // agentToken -> roomId
    this.apiKey = apiKey;
  }

  createRoom() {
    const id = crypto.randomBytes(3).toString('hex'); // 6-char hex
    const room = new Room(id, this.apiKey);
    this.rooms.set(id, room);
    this.tokenIndex.set(room.agentToken, id);
    return room;
  }

  getRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (room) room.touch();
    return room || null;
  }

  getRoomByToken(agentToken) {
    const roomId = this.tokenIndex.get(agentToken);
    if (!roomId) return null;
    return this.getRoom(roomId);
  }

  destroyRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (room) {
      this.tokenIndex.delete(room.agentToken);
      this.rooms.delete(roomId);
    }
  }

  cleanup(ttlMs = 2 * 60 * 60 * 1000) {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      if (now - room.lastActivity > ttlMs) {
        console.log(`Room ${id} expired (inactive ${Math.floor((now - room.lastActivity) / 60000)} min)`);
        if (room.teacherSocket) {
          room.teacherSocket.emit('room-expired', {});
          room.teacherSocket.disconnect(true);
        }
        this.destroyRoom(id);
      }
    }
  }
}

module.exports = { RoomManager, Room };
