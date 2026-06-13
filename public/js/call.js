// Parse URL query parameters
const urlParams = new URLSearchParams(window.location.search);
const inviteToken = urlParams.get('token');
let username = urlParams.get('username');
let userRole = urlParams.get('role') || 'Customer'; // Default to Customer

let sessionId = null;
let socket = null;
let localStream = null;
let remoteStream = null;
let peerConnection = null;

// WebRTC Negotiation & ICE Queuing state to resolve null remoteDescription races
let remoteDescriptionSet = false;
let queuedCandidates = [];

// Audio context and recorder variables (Agent only)
let audioContext = null;
let audioDestNode = null;
let canvasElement = null;
let canvasCtx = null;
let mixedStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let mixLoopId = null;

// Screen sharing state
let isScreenSharing = false;
let screenStream = null;

// Audio Analysers for Real-time border glows
let localAudioContext = null;
let localAnalyser = null;
let localVolumeLoopId = null;
let remoteAudioContext = null;
let remoteAnalyser = null;
let remoteVolumeLoopId = null;

// UI Elements
const loadingOverlay = document.getElementById('loadingOverlay');
const overlayTitle = document.getElementById('overlayTitle');
const overlayMessage = document.getElementById('overlayMessage');
const joinCredentialsBox = document.getElementById('joinCredentialsBox');
const joinForm = document.getElementById('joinForm');
const usernameInput = document.getElementById('usernameInput');

const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const remoteVideoWrapper = document.getElementById('remoteVideoWrapper');
const videoGrid = document.getElementById('videoGrid');

const toggleMicBtn = document.getElementById('toggleMicBtn');
const toggleCamBtn = document.getElementById('toggleCamBtn');
const screenShareBtn = document.getElementById('screenShareBtn');
const recordCallBtn = document.getElementById('recordCallBtn');
const toggleChatBtn = document.getElementById('toggleChatBtn');
const unreadDot = document.getElementById('unreadDot');
const hangUpBtn = document.getElementById('hangUpBtn');

const chatPanel = document.getElementById('chatPanel');
const chatMessages = document.getElementById('chatMessages');
const chatMessageInput = document.getElementById('chatMessageInput');
const sendChatBtn = document.getElementById('sendChatBtn');
const attachFileBtn = document.getElementById('attachFileBtn');
const fileInput = document.getElementById('fileInput');
const uploadProgress = document.getElementById('uploadProgress');
const participantCount = document.getElementById('participantCount');

const callTimer = document.getElementById('callTimer');
const recordingStatusBadge = document.getElementById('recordingStatusBadge');
const roleBadge = document.getElementById('roleBadge');

// Local track states
let isMicMuted = false;
let isCamOff = false;
let isRecording = false;
let unreadMessagesCount = 0;
let callDurationSeconds = 0;
let timerInterval = null;

// --- AUDIO SYNTHESIZER SOUND FEEDBACK ---

function playAudioFeedback(type) {
  try {
    const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtxClass();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    const now = ctx.currentTime;
    
    if (type === 'join') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.15);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.3);
      osc.start(now);
      osc.stop(now + 0.3);
    } 
    else if (type === 'leave') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, now);
      osc.frequency.exponentialRampToValueAtTime(293.66, now + 0.2);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.35);
      osc.start(now);
      osc.stop(now + 0.35);
    } 
    else if (type === 'message') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(650, now);
      osc.frequency.exponentialRampToValueAtTime(320, now + 0.08);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.08);
      osc.start(now);
      osc.stop(now + 0.08);
    } 
    else if (type === 'record') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1200, now);
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.setValueAtTime(0, now + 0.06);
      gain.gain.setValueAtTime(0.1, now + 0.08);
      gain.gain.linearRampToValueAtTime(0, now + 0.2);
      osc.start(now);
      osc.stop(now + 0.2);
    }
  } catch (err) {
    console.warn('Audio synthesis failed:', err);
  }
}

// --- INITIALIZATION ---

if (!inviteToken) {
  showOverlayError('Missing Invitation Token', 'Please use a valid support invitation link.');
} else {
  validateSessionAndInit();
}

async function validateSessionAndInit() {
  try {
    overlayTitle.textContent = 'Verifying Invitation...';
    overlayMessage.textContent = 'Connecting to support servers...';

    const response = await fetch(`/api/sessions/validate/${inviteToken}`);
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Invalid session invitation');
    }

    const data = await response.json();
    sessionId = data.sessionId;

    if (username) {
      startMediaAndConnect();
    } else {
      overlayTitle.textContent = 'Join Support Call';
      overlayMessage.textContent = 'Enter your name to join the session.';
      loadingOverlay.classList.add('show');
      joinCredentialsBox.style.display = 'block';
      
      joinForm.addEventListener('submit', (e) => {
        e.preventDefault();
        username = usernameInput.value.trim();
        if (username) {
          joinCredentialsBox.style.display = 'none';
          startMediaAndConnect();
        }
      });
    }

  } catch (err) {
    showOverlayError('Verification Failed', err.message);
  }
}

function showOverlayError(title, message) {
  overlayTitle.textContent = title;
  overlayMessage.textContent = message;
  overlayTitle.style.color = 'var(--accent-red)';
  joinCredentialsBox.style.display = 'none';
  const spinner = document.querySelector('.overlay .spinner');
  if (spinner) spinner.style.display = 'none';
}

async function startMediaAndConnect() {
  try {
    overlayTitle.textContent = 'Configuring Audio/Video Devices...';
    overlayMessage.textContent = 'Please allow camera and microphone access.';

    renderRoleBadge();

    if (userRole === 'Agent') {
      recordCallBtn.style.display = 'flex';
    }

    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 }
      }
    });

    localVideo.srcObject = localStream;
    
    startVolumeAnalysis(localStream, 'local');

    loadingOverlay.classList.remove('show');
    initializeSocket();

  } catch (err) {
    console.error('Failed to get media devices:', err);
    showOverlayError(
      'Media Device Access Error',
      'This platform requires microphone and camera permissions. Please check browser settings and reload.'
    );
  }
}

function renderRoleBadge() {
  if (userRole === 'Agent') {
    roleBadge.innerHTML = `<span class="badge badge-agent"><i class="fa-solid fa-user-shield"></i> Agent</span>`;
  } else {
    roleBadge.innerHTML = `<span class="badge badge-customer"><i class="fa-solid fa-user"></i> Customer</span>`;
  }
}

// --- REAL-TIME VOLUME MONITOR & BORDER GLOW VISUALIZER ---

function startVolumeAnalysis(stream, type) {
  try {
    if (type === 'local') {
      if (localVolumeLoopId) clearInterval(localVolumeLoopId);
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      localAudioContext = new AudioCtxClass();
      localAnalyser = localAudioContext.createAnalyser();
      const source = localAudioContext.createMediaStreamSource(stream);
      source.connect(localAnalyser);
      localAnalyser.fftSize = 64;
      
      const bufferLength = localAnalyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      const wrapper = document.getElementById('localVideoWrapper');
      
      localVolumeLoopId = setInterval(() => {
        if (isMicMuted) {
          wrapper.style.boxShadow = '';
          wrapper.style.borderColor = '';
          wrapper.classList.remove('speaking-active');
          return;
        }
        
        localAnalyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const avg = sum / bufferLength;
        
        if (avg > 15) {
          wrapper.classList.add('speaking-active');
          const glowSize = Math.min(30, Math.max(5, avg * 0.45));
          const spreadSize = Math.min(10, avg * 0.15);
          wrapper.style.boxShadow = `0 0 ${glowSize}px ${spreadSize}px rgba(99, 102, 241, 0.8)`;
          wrapper.style.borderColor = 'rgba(99, 102, 241, 0.9)';
        } else {
          wrapper.classList.remove('speaking-active');
          wrapper.style.boxShadow = '';
          wrapper.style.borderColor = '';
        }
      }, 50);
    } 
    else if (type === 'remote') {
      if (remoteVolumeLoopId) clearInterval(remoteVolumeLoopId);
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      remoteAudioContext = new AudioCtxClass();
      remoteAnalyser = remoteAudioContext.createAnalyser();
      const source = remoteAudioContext.createMediaStreamSource(stream);
      source.connect(remoteAnalyser);
      remoteAnalyser.fftSize = 64;
      
      const bufferLength = remoteAnalyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      const wrapper = document.getElementById('remoteVideoWrapper');
      
      remoteVolumeLoopId = setInterval(() => {
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0 || !audioTracks[0].enabled) {
          wrapper.style.boxShadow = '';
          wrapper.style.borderColor = '';
          wrapper.classList.remove('speaking-active');
          return;
        }
        
        remoteAnalyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const avg = sum / bufferLength;
        
        if (avg > 15) {
          wrapper.classList.add('speaking-active');
          const glowSize = Math.min(30, Math.max(5, avg * 0.45));
          const spreadSize = Math.min(10, avg * 0.15);
          wrapper.style.boxShadow = `0 0 ${glowSize}px ${spreadSize}px rgba(236, 72, 153, 0.8)`;
          wrapper.style.borderColor = 'rgba(236, 72, 153, 0.9)';
        } else {
          wrapper.classList.remove('speaking-active');
          wrapper.style.boxShadow = '';
          wrapper.style.borderColor = '';
        }
      }, 50);
    }
  } catch (err) {
    console.warn('Failed to start volume analysis:', err);
  }
}

function stopVolumeAnalysis(type) {
  if (type === 'local' && localVolumeLoopId) {
    clearInterval(localVolumeLoopId);
    localVolumeLoopId = null;
    if (localAudioContext) {
      localAudioContext.close();
      localAudioContext = null;
    }
  } else if (type === 'remote' && remoteVolumeLoopId) {
    clearInterval(remoteVolumeLoopId);
    remoteVolumeLoopId = null;
    if (remoteAudioContext) {
      remoteAudioContext.close();
      remoteAudioContext = null;
    }
  }
}

// --- SOCKET.IO & SIGNALING SETUP ---

function initializeSocket() {
  socket = io();

  socket.on('connect', () => {
    console.log('Connected to signaling server with socket ID:', socket.id);
    
    socket.emit('join_session', {
      sessionId,
      username,
      role: userRole
    });
  });

  socket.on('session_ready', ({ participants, messages, recordingStatus }) => {
    console.log('Session joined successfully. Other active participants:', participants);
    
    chatMessages.innerHTML = '';
    messages.forEach(addMessageBubble);
    scrollToBottom();

    handleRecordingStatusUpdate(recordingStatus);

    if (participants.length > 0) {
      updateRemotePlaceholder(participants[0].username, participants[0].role);
      
      if (userRole === 'Agent') {
        initiateWebRTCCall(participants[0].socketId);
      }
    }
  });

  socket.on('participant_joined', ({ socketId, username: peerName, role: peerRole }) => {
    console.log(`Participant joined: ${peerName} (${peerRole})`);
    
    playAudioFeedback('join');
    updateRemotePlaceholder(peerName, peerRole);
    updateParticipantCount(2);

    if (userRole === 'Agent') {
      initiateWebRTCCall(socketId);
    }
    
    startTimer();
  });

  socket.on('participant_disconnected', ({ username: peerName }) => {
    console.log(`Participant disconnected: ${peerName}. Waiting for reconnect...`);
    document.getElementById('remoteLabel').textContent = `${peerName} (Reconnecting...)`;
    remoteVideoWrapper.classList.remove('active-speaker');
    stopVolumeAnalysis('remote');
  });

  socket.on('participant_left', ({ username: peerName }) => {
    console.log(`Participant left permanently: ${peerName}`);
    playAudioFeedback('leave');
    
    remoteVideo.srcObject = null;
    remoteVideoWrapper.style.display = 'none';
    videoGrid.classList.add('single-video');
    updateParticipantCount(1);
    stopVolumeAnalysis('remote');
    
    if (userRole === 'Agent' && isRecording) {
      toggleRecording();
    }

    stopTimer();
  });

  socket.on('participant_reconnected', ({ username: peerName }) => {
    console.log(`Participant reconnected: ${peerName}`);
    playAudioFeedback('join');
    document.getElementById('remoteLabel').textContent = peerName;
  });

  socket.on('webrtc_offer', async ({ senderSocketId, offer }) => {
    console.log('Received WebRTC offer');
    await handleWebRTCOffer(senderSocketId, offer);
  });

  socket.on('webrtc_answer', async ({ answer }) => {
    console.log('Received WebRTC answer');
    await handleWebRTCAnswer(answer);
  });

  socket.on('webrtc_ice_candidate', async ({ candidate }) => {
    await handleRemoteIceCandidate(candidate);
  });

  socket.on('receive_message', (msg) => {
    addMessageBubble(msg);
    scrollToBottom();

    if (msg.sender !== username) {
      playAudioFeedback('message');
    }

    if (chatPanel.style.display === 'none') {
      unreadMessagesCount++;
      unreadDot.style.display = 'block';
    }
  });

  socket.on('recording_status_changed', ({ status }) => {
    handleRecordingStatusUpdate(status);
  });

  socket.on('session_ended', ({ reason }) => {
    console.log('Session ended by server.');
    cleanUpCall();
    showOverlayError('Session Ended', reason || 'The support session has been completed.');
    loadingOverlay.classList.add('show');
  });

  socket.on('error_message', (msg) => {
    alert(msg);
  });

  socket.on('disconnect', (reason) => {
    console.warn('Socket disconnected:', reason);
    overlayTitle.textContent = 'Reconnecting to Session...';
    overlayMessage.textContent = 'Your network dropped. Attempting to restore connection...';
    loadingOverlay.classList.add('show');
  });
}

function updateParticipantCount(count) {
  participantCount.innerHTML = `<i class="fa-solid fa-users"></i> ${count} Connected`;
}

function updateRemotePlaceholder(name, role) {
  document.getElementById('remoteLabel').textContent = name;
  const placeholderText = document.querySelector('#remotePlaceholder .placeholder-text');
  placeholderText.textContent = `Connecting audio/video with ${name}...`;
  
  remoteVideoWrapper.style.display = 'flex';
  videoGrid.classList.remove('single-video');
  updateParticipantCount(2);
}

// --- WEBRTC CONFIG & LOOPBACK COMPATIBILITY ---

// WebRTC loopback is protected in some browsers on localhost if 'relay' only policy is set.
// We dynamically permit direct candidates on localhost, but strictly enforce TURN relay for external addresses!
const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const pcConfig = {
  iceServers: [
    {
      urls: 'stun:stun.l.google.com:19302'
    },
    {
      urls: `turn:${isLocal ? '127.0.0.1' : window.location.hostname}:3478`,
      username: 'supportagent',
      credential: 'supportpass'
    }
  ],
  iceTransportPolicy: isLocal ? 'all' : 'relay'
};

function createPeerConnection(targetSocketId) {
  if (peerConnection) {
    peerConnection.close();
  }

  console.log('Creating RTCPeerConnection with config:', pcConfig);
  peerConnection = new RTCPeerConnection(pcConfig);
  
  remoteDescriptionSet = false;
  queuedCandidates = [];

  // Add local media tracks
  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  // Listen for remote tracks and bind them securely
  peerConnection.ontrack = (event) => {
    console.log('Received remote track:', event.track.kind);
    
    if (!remoteStream) {
      remoteStream = new MediaStream();
      remoteVideo.srcObject = remoteStream;
    }
    
    if (!remoteStream.getTracks().some(t => t.id === event.track.id)) {
      remoteStream.addTrack(event.track);
    }
    
    if (event.track.kind === 'video') {
      document.getElementById('remotePlaceholder').style.display = 'none';
      remoteVideo.play().catch(e => console.warn('Play remote video failed:', e));
    }
    
    if (event.track.kind === 'audio') {
      startVolumeAnalysis(remoteStream, 'remote');
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc_ice_candidate', {
        targetSocketId,
        candidate: event.candidate
      });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    console.log('WebRTC Connection State:', peerConnection.connectionState);
  };
}

async function initiateWebRTCCall(targetSocketId) {
  createPeerConnection(targetSocketId);
  
  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('webrtc_offer', {
      targetSocketId,
      offer
    });
  } catch (err) {
    console.error('Error creating WebRTC offer:', err);
  }
}

async function handleWebRTCOffer(senderSocketId, offer) {
  createPeerConnection(senderSocketId);
  
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    await processQueuedCandidates(); // Process any ICE candidates received early
    
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    
    socket.emit('webrtc_answer', {
      targetSocketId: senderSocketId,
      answer
    });
  } catch (err) {
    console.error('Error processing WebRTC offer:', err);
  }
}

async function handleWebRTCAnswer(answer) {
  if (peerConnection) {
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      await processQueuedCandidates(); // Process any ICE candidates received early
    } catch (err) {
      console.error('Error setting remote answer:', err);
    }
  }
}

// Queue remote ICE candidates that arrive before RemoteDescription is configured
async function handleRemoteIceCandidate(candidate) {
  if (peerConnection && remoteDescriptionSet) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error('Error adding remote ICE candidate:', e);
    }
  } else {
    queuedCandidates.push(candidate);
  }
}

// Empty the queued candidates once RemoteDescription is active
async function processQueuedCandidates() {
  remoteDescriptionSet = true;
  console.log(`Processing ${queuedCandidates.length} queued ICE candidates`);
  while (queuedCandidates.length > 0) {
    const candidate = queuedCandidates.shift();
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error('Error adding queued ICE candidate:', e);
    }
  }
}

// --- CALL CONTROLS ---

// Mic Mute Control
toggleMicBtn.addEventListener('click', () => {
  isMicMuted = !isMicMuted;
  localStream.getAudioTracks().forEach(track => {
    track.enabled = !isMicMuted;
  });
  
  const micIcon = toggleMicBtn.querySelector('i');
  if (isMicMuted) {
    toggleMicBtn.classList.add('active');
    micIcon.className = 'fa-solid fa-microphone-slash';
    document.getElementById('localMicStatus').innerHTML = '<i class="fa-solid fa-microphone-slash" style="color: var(--accent-red);"></i>';
  } else {
    toggleMicBtn.classList.remove('active');
    micIcon.className = 'fa-solid fa-microphone';
    document.getElementById('localMicStatus').innerHTML = '<i class="fa-solid fa-microphone"></i>';
  }
});

// Camera Toggle Control
toggleCamBtn.addEventListener('click', () => {
  if (isScreenSharing) {
    toggleScreenSharing();
    return;
  }

  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(track => {
    track.enabled = !isCamOff;
  });

  const camIcon = toggleCamBtn.querySelector('i');
  const localPlaceholder = document.getElementById('localPlaceholder');

  if (isCamOff) {
    toggleCamBtn.classList.add('active');
    camIcon.className = 'fa-solid fa-video-slash';
    document.getElementById('localCamStatus').innerHTML = '<i class="fa-solid fa-video-slash" style="color: var(--accent-red);"></i>';
    localPlaceholder.style.display = 'flex';
    localPlaceholder.querySelector('.placeholder-avatar').textContent = username.charAt(0).toUpperCase();
  } else {
    toggleCamBtn.classList.remove('active');
    camIcon.className = 'fa-solid fa-video';
    document.getElementById('localCamStatus').innerHTML = '<i class="fa-solid fa-video"></i>';
    localPlaceholder.style.display = 'none';
  }
});

// Screen Share Toggle
screenShareBtn.addEventListener('click', toggleScreenSharing);

async function toggleScreenSharing() {
  if (!peerConnection) {
    alert('Screen sharing requires another participant to be connected.');
    return;
  }

  const videoSender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
  if (!videoSender) return;

  if (!isScreenSharing) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];
      
      await videoSender.replaceTrack(screenTrack);
      localVideo.srcObject = screenStream;
      
      screenTrack.onended = () => {
        revertToCamera(videoSender);
      };

      screenShareBtn.classList.add('active');
      isScreenSharing = true;

    } catch (err) {
      console.warn('Screen sharing cancelled/failed:', err);
    }
  } else {
    revertToCamera(videoSender);
  }
}

async function revertToCamera(videoSender) {
  if (screenStream) {
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
  }

  try {
    const cameraTrack = localStream.getVideoTracks()[0];
    await videoSender.replaceTrack(cameraTrack);
    localVideo.srcObject = localStream;
  } catch (err) {
    console.error('Failed to restore camera track:', err);
  }

  screenShareBtn.classList.remove('active');
  isScreenSharing = false;
  
  if (isCamOff) {
    localStream.getVideoTracks().forEach(t => t.enabled = false);
  }
}

// Hangup Call
hangUpBtn.addEventListener('click', () => {
  if (confirm(userRole === 'Agent' ? 'Are you sure you want to end the session for everyone?' : 'Are you sure you want to leave the call?')) {
    if (userRole === 'Agent') {
      socket.emit('end_session', { sessionId });
    } else {
      cleanUpCall();
      window.location.href = '/index.html';
    }
  }
});

function cleanUpCall() {
  stopTimer();
  stopVolumeAnalysis('local');
  stopVolumeAnalysis('remote');
  
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  if (socket) {
    socket.disconnect();
  }
  if (mixLoopId) {
    clearInterval(mixLoopId);
  }
}

// --- CALL RECORDING (AGENT ONLY) ---

recordCallBtn.addEventListener('click', () => {
  if (!remoteStream) {
    alert('Cannot record call: Customer must be joined first.');
    return;
  }
  toggleRecording();
});

function toggleRecording() {
  isRecording = !isRecording;
  playAudioFeedback('record');

  if (isRecording) {
    startCanvasAudioMixing();
    
    recordedChunks = [];
    let options = { mimeType: 'video/webm;codecs=vp8,opus' };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      options = { mimeType: 'video/webm' };
    }

    try {
      mediaRecorder = new MediaRecorder(mixedStream, options);
    } catch (err) {
      console.error('Failed to create MediaRecorder:', err);
      alert('Media recording not supported on this browser.');
      isRecording = false;
      return;
    }

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        recordedChunks.push(e.data);
      }
    };

    mediaRecorder.onstop = async () => {
      console.log('Recording stopped. Uploading file...');
      clearInterval(mixLoopId);
      
      socket.emit('recording_status', { sessionId, status: 'processing' });
      
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      await uploadRecordingBlob(blob);
    };

    mediaRecorder.start(1000);
    recordCallBtn.classList.add('active');
    
    socket.emit('recording_status', { sessionId, status: 'in_progress' });

  } else {
    mediaRecorder.stop();
    recordCallBtn.classList.remove('active');
  }
}

function startCanvasAudioMixing() {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  audioDestNode = audioContext.createMediaStreamDestination();

  if (localStream.getAudioTracks().length > 0) {
    const localAudioSource = audioContext.createMediaStreamSource(localStream);
    localAudioSource.connect(audioDestNode);
  }

  if (remoteStream && remoteStream.getAudioTracks().length > 0) {
    const remoteAudioSource = audioContext.createMediaStreamSource(remoteStream);
    remoteAudioSource.connect(audioDestNode);
  }

  canvasElement = document.createElement('canvas');
  canvasElement.width = 1280;
  canvasElement.height = 720;
  canvasCtx = canvasElement.getContext('2d');

  const localVideoEl = document.getElementById('localVideo');
  const remoteVideoEl = document.getElementById('remoteVideo');

  mixLoopId = setInterval(() => {
    canvasCtx.fillStyle = '#060913';
    canvasCtx.fillRect(0, 0, 1280, 720);

    if (remoteStream && remoteStream.getVideoTracks().length > 0 && !remoteStream.getVideoTracks()[0].muted) {
      canvasCtx.drawImage(remoteVideoEl, 0, 0, 1280, 720);
    } else {
      canvasCtx.fillStyle = '#0d1222';
      canvasCtx.fillRect(0, 0, 1280, 720);
      canvasCtx.fillStyle = '#fff';
      canvasCtx.font = '30px sans-serif';
      canvasCtx.textAlign = 'center';
      canvasCtx.fillText('Customer camera is off', 640, 360);
    }

    if (localStream && !isCamOff) {
      canvasCtx.strokeStyle = '#ffffff';
      canvasCtx.lineWidth = 4;
      canvasCtx.strokeRect(938, 518, 324, 184);
      canvasCtx.drawImage(localVideoEl, 940, 520, 320, 180);
    } else {
      canvasCtx.fillStyle = '#090d16';
      canvasCtx.fillRect(940, 520, 320, 180);
      canvasCtx.strokeStyle = '#ffffff';
      canvasCtx.lineWidth = 4;
      canvasCtx.strokeRect(938, 518, 324, 184);
      canvasCtx.fillStyle = '#fff';
      canvasCtx.font = '14px sans-serif';
      canvasCtx.textAlign = 'center';
      canvasCtx.fillText('Agent camera is off', 1100, 610);
    }
  }, 33);

  const canvasVideoStream = canvasElement.captureStream(30);
  
  mixedStream = new MediaStream();
  mixedStream.addTrack(canvasVideoStream.getVideoTracks()[0]);
  if (audioDestNode.stream.getAudioTracks().length > 0) {
    mixedStream.addTrack(audioDestNode.stream.getAudioTracks()[0]);
  }
}

async function uploadRecordingBlob(blob) {
  const formData = new FormData();
  const filename = `recording-${sessionId}-${Date.now()}.webm`;
  formData.append('recordingFile', blob, filename);
  formData.append('sessionId', sessionId);

  try {
    const response = await fetch('/api/recordings/upload', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) throw new Error('Upload request failed');

    const data = await response.json();
    console.log('Recording uploaded successfully:', data);
    socket.emit('recording_status', { sessionId, status: 'ready' });
  } catch (err) {
    console.error('Failed to upload recording:', err);
    socket.emit('recording_status', { sessionId, status: 'error' });
  }
}

function handleRecordingStatusUpdate(status) {
  if (status === 'in_progress') {
    recordingStatusBadge.style.display = 'flex';
    recordingStatusBadge.innerHTML = '<div class="recording-dot"></div><span>REC</span>';
    if (userRole === 'Agent') {
      recordCallBtn.classList.add('active');
    }
  } else if (status === 'processing') {
    recordingStatusBadge.style.display = 'flex';
    recordingStatusBadge.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>PROCESSING</span>';
  } else if (status === 'ready') {
    recordingStatusBadge.style.display = 'none';
    if (userRole === 'Agent') {
      recordCallBtn.classList.remove('active');
      alert('Your call recording is processed and available for download on the dashboard!');
    }
  } else {
    recordingStatusBadge.style.display = 'none';
    if (userRole === 'Agent') {
      recordCallBtn.classList.remove('active');
    }
  }
}

// --- CALL TIMER ---

function startTimer() {
  if (timerInterval) return;
  
  callTimer.style.color = '#fff';
  timerInterval = setInterval(() => {
    callDurationSeconds++;
    const mins = String(Math.floor(callDurationSeconds / 60)).padStart(2, '0');
    const secs = String(callDurationSeconds % 60).padStart(2, '0');
    callTimer.querySelector('span').textContent = `${mins}:${secs}`;
  }, 1000);
}

// --- IN-CALL CHAT & FILE UPLOAD ---

toggleChatBtn.addEventListener('click', () => {
  const isHidden = chatPanel.style.display === 'none';
  if (isHidden) {
    chatPanel.style.display = 'flex';
    unreadMessagesCount = 0;
    unreadDot.style.display = 'none';
    scrollToBottom();
  } else {
    chatPanel.style.display = 'none';
  }
});

sendChatBtn.addEventListener('click', sendChatMessage);
chatMessageInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    sendChatMessage();
  }
});

function sendChatMessage() {
  const text = chatMessageInput.value.trim();
  if (!text) return;

  socket.emit('send_message', {
    sessionId,
    text
  });
  
  chatMessageInput.value = '';
}

attachFileBtn.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;

  uploadProgress.style.display = 'block';
  
  const formData = new FormData();
  formData.append('chatFile', file);

  try {
    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) throw new Error('Upload failed');

    const data = await response.json();
    
    socket.emit('send_message', {
      sessionId,
      text: `Sent a file: ${data.fileName}`,
      fileUrl: data.fileUrl,
      fileName: data.fileName
    });

  } catch (err) {
    alert('File upload failed: ' + err.message);
  } finally {
    uploadProgress.style.display = 'none';
    fileInput.value = '';
  }
});

function addMessageBubble(msg) {
  const wrapper = document.createElement('div');
  const isSelf = msg.sender === username;
  wrapper.className = `msg-wrapper ${isSelf ? 'self' : 'other'}`;

  const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const metaHtml = `<span class="msg-meta">${msg.sender} (${msg.role}) • ${timeStr}</span>`;
  
  let bubbleHtml = `<div class="msg-bubble">${msg.text}</div>`;
  
  if (msg.fileUrl) {
    const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(msg.fileUrl);
    let previewHtml = '';
    
    if (isImage) {
      previewHtml = `<img src="${msg.fileUrl}" alt="${msg.fileName}" style="max-width: 100%; border-radius: 8px; margin-top: 0.5rem; display: block; border: 1px solid rgba(255,255,255,0.1);">`;
    }

    bubbleHtml = `
      <div class="msg-bubble">
        <div class="file-attachment">
          <i class="fa-solid fa-file-arrow-down file-attachment-icon"></i>
          <a href="${msg.fileUrl}" target="_blank" download="${msg.fileName}">${msg.fileName}</a>
        </div>
        ${previewHtml}
      </div>
    `;
  }

  wrapper.innerHTML = metaHtml + bubbleHtml;
  chatMessages.appendChild(wrapper);
}

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
