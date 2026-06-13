const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const dbPath = path.join(__dirname, 'data', 'db.json');

let cache = {
  sessions: [],
  events: [],
  messages: []
};

// Initialize the database and read existing contents
async function init() {
  try {
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const data = await fs.readFile(dbPath, 'utf8');
    cache = JSON.parse(data);
    if (!cache.sessions) cache.sessions = [];
    if (!cache.events) cache.events = [];
    if (!cache.messages) cache.messages = [];
  } catch (err) {
    await save();
  }
}

// Write the cache back to disk
async function save() {
  try {
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    await fs.writeFile(dbPath, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write database file:', err);
  }
}

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

async function createSession(agentId) {
  const session = {
    id: crypto.randomUUID(),
    agentId: agentId || 'Agent',
    token: generateToken(),
    status: 'active',
    createdAt: new Date().toISOString(),
    endedAt: null,
    participants: [], // List of { socketId, username, role, joinedAt }
    recording: {
      status: 'none', // none, in_progress, processing, ready, error
      filePath: null,
      fileName: null
    }
  };
  cache.sessions.push(session);
  await save();
  await logEvent(session.id, 'session_created', { agentId });
  return session;
}

async function getSession(id) {
  return cache.sessions.find(s => s.id === id) || null;
}

async function getSessionByToken(token) {
  return cache.sessions.find(s => s.token === token) || null;
}

async function getSessions() {
  return cache.sessions;
}

async function getActiveSessions() {
  return cache.sessions.filter(s => s.status === 'active');
}

async function endSession(id) {
  const session = cache.sessions.find(s => s.id === id);
  if (session && session.status === 'active') {
    session.status = 'ended';
    session.endedAt = new Date().toISOString();
    await save();
    await logEvent(id, 'session_ended', { reason: 'Clean termination' });
    return session;
  }
  return null;
}

async function addParticipant(id, socketId, username, role) {
  const session = cache.sessions.find(s => s.id === id);
  if (session && session.status === 'active') {
    // Check if participant already exists in current list
    const exists = session.participants.some(p => p.socketId === socketId);
    if (!exists) {
      session.participants.push({
        socketId,
        username,
        role,
        joinedAt: new Date().toISOString()
      });
      await save();
      await logEvent(id, 'participant_joined', { socketId, username, role });
    }
    return session;
  }
  return null;
}

async function removeParticipant(id, socketId) {
  const session = cache.sessions.find(s => s.id === id);
  if (session) {
    const participant = session.participants.find(p => p.socketId === socketId);
    if (participant) {
      session.participants = session.participants.filter(p => p.socketId !== socketId);
      await save();
      await logEvent(id, 'participant_left', {
        socketId,
        username: participant.username,
        role: participant.role
      });
    }
    return session;
  }
  return null;
}

async function saveMessage(sessionId, sender, role, text, fileUrl = null, fileName = null) {
  const message = {
    id: crypto.randomUUID(),
    sessionId,
    sender,
    role,
    text,
    fileUrl,
    fileName,
    timestamp: new Date().toISOString()
  };
  cache.messages.push(message);
  await save();
  await logEvent(sessionId, 'chat_message', { sender, role, hasFile: !!fileUrl });
  return message;
}

async function getMessages(sessionId) {
  return cache.messages.filter(m => m.sessionId === sessionId);
}

async function logEvent(sessionId, type, details = {}) {
  const event = {
    id: crypto.randomUUID(),
    sessionId,
    type, // session_created, participant_joined, participant_left, session_ended, chat_message, recording_started, recording_stopped, recording_ready, error
    details,
    timestamp: new Date().toISOString()
  };
  cache.events.push(event);
  await save();
  return event;
}

async function getEvents(sessionId) {
  if (sessionId) {
    return cache.events.filter(e => e.sessionId === sessionId);
  }
  return cache.events;
}

async function updateRecordingStatus(id, status, fileName = null, filePath = null) {
  const session = cache.sessions.find(s => s.id === id);
  if (session) {
    session.recording = session.recording || {};
    session.recording.status = status;
    if (fileName) session.recording.fileName = fileName;
    if (filePath) session.recording.filePath = filePath;
    await save();
    await logEvent(id, 'recording_status_updated', { status, fileName });
    return session;
  }
  return null;
}

module.exports = {
  init,
  createSession,
  getSession,
  getSessionByToken,
  getSessions,
  getActiveSessions,
  endSession,
  addParticipant,
  removeParticipant,
  saveMessage,
  getMessages,
  logEvent,
  getEvents,
  updateRecordingStatus
};
