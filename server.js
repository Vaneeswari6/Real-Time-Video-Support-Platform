const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Turn = require('node-turn');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;
const TURN_PORT = process.env.TURN_PORT || 3478;

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});

const upload = multer({ storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

// Keep track of reconnect timeouts
// Key: sessionId:username:role -> timeout ID
const reconnectTimeouts = new Map();
// Key: socket.id -> { sessionId, username, role }
const activeSockets = new Map();

// --- REST API ENDPOINTS ---

// Create a new support session (Agent only)
app.post('/api/sessions', async (req, res) => {
  try {
    const { agentId } = req.body;
    const session = await db.createSession(agentId);
    res.status(201).json(session);
  } catch (error) {
    console.error('Error creating session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// Validate session invite token
app.get('/api/sessions/validate/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const session = await db.getSessionByToken(token);
    
    if (!session) {
      return res.status(404).json({ valid: false, error: 'Invalid invitation token' });
    }
    
    if (session.status !== 'active') {
      return res.status(400).json({ valid: false, error: 'This session has already ended' });
    }
    
    res.json({
      valid: true,
      sessionId: session.id,
      agentId: session.agentId,
      createdAt: session.createdAt
    });
  } catch (error) {
    console.error('Error validating token:', error);
    res.status(500).json({ error: 'Failed to validate token' });
  }
});

// Get session history (Agent dashboard)
app.get('/api/sessions/history', async (req, res) => {
  try {
    const sessions = await db.getSessions();
    // Sort descending by creation date
    sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch session history' });
  }
});

// Get messages for a session
app.get('/api/sessions/:id/messages', async (req, res) => {
  try {
    const messages = await db.getMessages(req.params.id);
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Upload file to chat
app.post('/api/upload', upload.single('chatFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({
      fileUrl,
      fileName: req.file.originalname,
      size: req.file.size
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// Upload call recording
app.post('/api/recordings/upload', upload.single('recordingFile'), async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!req.file) {
      return res.status(400).json({ error: 'No recording file uploaded' });
    }
    if (!sessionId) {
      return res.status(400).json({ error: 'Missing session ID' });
    }
    
    const filePath = `/uploads/${req.file.filename}`;
    const session = await db.updateRecordingStatus(sessionId, 'ready', req.file.originalname, filePath);
    res.json({ success: true, session });
  } catch (error) {
    console.error('Error uploading recording:', error);
    res.status(500).json({ error: 'Failed to save recording' });
  }
});

// Admin metrics & observability
app.get('/api/admin/metrics', async (req, res) => {
  try {
    const allSessions = await db.getSessions();
    const activeSessions = allSessions.filter(s => s.status === 'active');
    
    let totalConnected = 0;
    activeSessions.forEach(s => {
      totalConnected += s.participants.length;
    });

    const events = await db.getEvents();
    // Get last 50 events
    const recentEvents = events.slice(-50).reverse();

    res.json({
      activeSessionsCount: activeSessions.length,
      totalSessionsCount: allSessions.length,
      connectedParticipantsCount: totalConnected,
      activeSessions: activeSessions.map(s => ({
        id: s.id,
        agentId: s.agentId,
        createdAt: s.createdAt,
        participantsCount: s.participants.length,
        recordingStatus: s.recording.status,
        participants: s.participants
      })),
      recentEvents
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

// Force end a session (Admin action)
app.post('/api/admin/sessions/:id/terminate', async (req, res) => {
  try {
    const { id } = req.params;
    const session = await db.endSession(id);
    
    if (session) {
      // Notify all connected sockets in that room
      io.to(id).emit('session_ended', { reason: 'Terminated by Admin' });
      await db.logEvent(id, 'session_terminated_by_admin');
      res.json({ success: true, session });
    } else {
      res.status(404).json({ error: 'Session not found or already ended' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to terminate session' });
  }
});

// --- SOCKET.IO CALL HANDLING & SIGNALING ---

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('join_session', async ({ sessionId, username, role }) => {
    try {
      const session = await db.getSession(sessionId);
      if (!session || session.status !== 'active') {
        socket.emit('error_message', 'Session is not active or does not exist.');
        return;
      }

      // Check if user has an active reconnect timeout and clear it
      const reconnectKey = `${sessionId}:${username}:${role}`;
      if (reconnectTimeouts.has(reconnectKey)) {
        clearTimeout(reconnectTimeouts.get(reconnectKey));
        reconnectTimeouts.delete(reconnectKey);
        await db.logEvent(sessionId, 'participant_reconnected', { username, role });
      }

      // Add socket info mapping
      activeSockets.set(socket.id, { sessionId, username, role });

      // Join socket.io room
      socket.join(sessionId);

      // Add participant to DB
      const updatedSession = await db.addParticipant(sessionId, socket.id, username, role);

      // Notify others in room
      socket.to(sessionId).emit('participant_joined', {
        socketId: socket.id,
        username,
        role,
        session: updatedSession
      });

      // Send the current participant list and history to the joined user
      const messages = await db.getMessages(sessionId);
      socket.emit('session_ready', {
        participants: updatedSession.participants.filter(p => p.socketId !== socket.id),
        messages,
        recordingStatus: updatedSession.recording.status
      });

    } catch (err) {
      console.error('Error on join_session:', err);
      socket.emit('error_message', 'An error occurred while joining the session.');
    }
  });

  // WebRTC Signalling forwarders
  socket.on('webrtc_offer', ({ targetSocketId, offer }) => {
    io.to(targetSocketId).emit('webrtc_offer', {
      senderSocketId: socket.id,
      offer
    });
  });

  socket.on('webrtc_answer', ({ targetSocketId, answer }) => {
    io.to(targetSocketId).emit('webrtc_answer', {
      senderSocketId: socket.id,
      answer
    });
  });

  socket.on('webrtc_ice_candidate', ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit('webrtc_ice_candidate', {
      senderSocketId: socket.id,
      candidate
    });
  });

  // In-Call Chat message
  socket.on('send_message', async ({ sessionId, text, fileUrl, fileName }) => {
    const user = activeSockets.get(socket.id);
    if (!user || user.sessionId !== sessionId) return;

    try {
      const msg = await db.saveMessage(sessionId, user.username, user.role, text, fileUrl, fileName);
      // Broadcast message to everyone in the room (including sender)
      io.to(sessionId).emit('receive_message', msg);
    } catch (err) {
      console.error('Error saving message:', err);
    }
  });

  // Call recording control (Agent only)
  socket.on('recording_status', async ({ sessionId, status }) => {
    const user = activeSockets.get(socket.id);
    if (!user || user.role !== 'Agent') return;

    await db.updateRecordingStatus(sessionId, status);
    // Notify room of recording status change
    io.to(sessionId).emit('recording_status_changed', { status });
  });

  // End call cleanly
  socket.on('end_session', async ({ sessionId }) => {
    const user = activeSockets.get(socket.id);
    if (!user) return;

    // Only agents can end sessions
    if (user.role !== 'Agent') {
      socket.emit('error_message', 'Only agents are authorized to end sessions.');
      return;
    }

    try {
      await db.endSession(sessionId);
      // Broadcast to room to disconnect
      io.to(sessionId).emit('session_ended', { reason: 'Call ended by Agent' });
    } catch (err) {
      console.error('Error ending session:', err);
    }
  });

  // Disconnect handler with Reconnect Grace Window (15 seconds)
  socket.on('disconnect', async () => {
    const userInfo = activeSockets.get(socket.id);
    if (!userInfo) return;

    const { sessionId, username, role } = userInfo;
    activeSockets.delete(socket.id);

    // Notify room that the user has disconnected (temporarily)
    socket.to(sessionId).emit('participant_disconnected', {
      socketId: socket.id,
      username,
      role
    });

    const reconnectKey = `${sessionId}:${username}:${role}`;
    
    // Set 15-second grace window timeout
    const timeoutId = setTimeout(async () => {
      reconnectTimeouts.delete(reconnectKey);
      
      // Officially remove from database session and log as left
      await db.removeParticipant(sessionId, socket.id);
      
      // Notify other participants they officially left
      io.to(sessionId).emit('participant_left', {
        socketId: socket.id,
        username,
        role
      });
      
      await db.logEvent(sessionId, 'participant_left_timeout', { username, role });
    }, 15000);

    reconnectTimeouts.set(reconnectKey, timeoutId);
  });
});

// --- START STUN/TURN SERVER ---

const turnServer = new Turn({
  authMech: 'long-term',
  credentials: {
    'supportagent': 'supportpass',
    'supportcustomer': 'supportpass'
  },
  listeningPort: Number(TURN_PORT),
  listeningIp: '0.0.0.0'
});

try {
  turnServer.start();
  console.log(`STUN/TURN server is running on port ${TURN_PORT}`);
} catch (err) {
  console.error('Failed to start TURN server:', err);
}

// --- START WEB SERVER ---

db.init().then(() => {
  server.listen(PORT, () => {
    console.log(`Web application server is running on http://localhost:${PORT}`);
  });
});
