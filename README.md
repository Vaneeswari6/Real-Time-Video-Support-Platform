# AuraSupport - Real-Time Video Support Platform
### 🏆 AtomQuest Hackathon 1.0 - Grand Finale Submission

AuraSupport is a high-fidelity, self-hosted real-time video calling platform designed for customer support teams. It operates entirely on self-owned infrastructure, ensuring complete control over communication data and security. 

All media streams are strictly routed through our co-located server relay, and the platform implements real-time chat, file sharing, reconnect handling, call recording, and full observability.

---

## 🏗️ Architecture & Technology Choices

### System Architecture Flow (WebRTC + TURN + Canvas Mixing)

<img width="1091" height="905" alt="image" src="https://github.com/user-attachments/assets/a16e1bf7-94cf-443c-83da-0382c9cec2e8" />


### Technical Design Choices

1. **Media Routing & Relaying (No P2P Bypass)**:
   - To strictly comply with the rule that media must route through a server, we co-locate a pure-JS STUN/TURN server (`node-turn`) inside our Node.js process on port `3478`.
   - The client WebRTC configuration uses `iceTransportPolicy: 'relay'`. This instructs browsers to reject all `host` (local IP) and `srflx` (STUN reflexive) candidates, forcing all encrypted audio/video traffic through the co-located relay.
2. **Client-Side Stream Mixing (Zero-Crash Recording)**:
   - Decoding WebRTC streams on the server requires heavy native C++ decoders (FFmpeg/GStreamer wrappers) which are highly unstable in multi-tenant environments.
   - We utilize the Agent's browser resources: drawing local and remote video elements onto a `<canvas>` element at 30 FPS (Picture-in-Picture layout) and mixing audio tracks using the `Web Audio API`. The compiled stream is recorded via `MediaRecorder` and posted to the server.
3. **Audit Trail & State Store**:
   - We implemented a lightweight, async file-based JSON store (`db.js`) to record sessions, chat logs, and operational events. This guarantees zero database driver compilation issues on Windows while maintaining an audit trail.

---

## 🌟 Key Features

### Core Capabilities (Must-Have)
- **Session Management**: Agents can create support rooms, producing a tokenized shareable link. Rooms can be closed cleanly, shutting down all sockets.
- **Role Enforcement**: Agents have administrative controls (Record Call, Terminate Session). Customers join via tokens and have no access to administrative tools.
- **Audio & Video Relaying**: Full real-time audio and video running over WebRTC, restricted to server TURN relaying. Controls for camera toggle and microphone mute.
- **In-Call Chat**: Synchronized chat room for real-time text message exchange. Chat history is saved and retrievable after calls end.

### Premium & Hackathon-Win Features (Good-to-Have/Bonus)
- **Real-Time Voice Visualizers**: Web Audio API analysers measure voice amplitudes. Video wrappers display glowing neon borders that pulse in real-time sync with participant speech (Blue for Agent, Pink for Customer).
- **Interactive Audio Feedback**: Programmatic synthesizer chimes play for session join, departure, chat receipt, and recording state toggles, creating a rich sensory experience with zero asset files.
- **Native Screen Sharing**: The control bar contains a desktop share toggle. Clicking it swaps the camera track with a display capture stream in the active WebRTC connection without renegotiation delay.
- **Call Recording**: Programmatic mixing creates high-quality WebM recordings of both video and audio. Available for download from the Agent Dashboard.
- **File Sharing in Chat**: Participants can upload documents or images directly in the chat panel.
- **Reconnect Grace Window (15 Seconds)**: If a client socket disconnects unexpectedly, the server holds the state. The remaining participant sees a `Reconnecting...` status. If the user joins back within 15 seconds, the call resumes immediately.
- **Ops Dashboard**: A live administrator panel displaying operational KPIs, connected participants, and a tailing System Event Log.
- **Observability**: A metrics endpoint (`/api/admin/metrics`) exposing live rates.

---

## 🚀 Installation & Local Execution

### Prerequisites
- [Node.js](https://nodejs.org/) (Version 16 or higher recommended)

### Setup Instructions
1. **Clone or Extract** the project directory:
   ```bash
   cd realtime-video-support
   ```
2. **Install Dependencies**:
   ```bash
   npm install
   ```
3. **Start the Platform**:
   ```bash
   npm start
   ```
   *The console will log:*
   - `STUN/TURN server is running on port 3478`
   - `Web application server is running on http://localhost:3000`

---

## 🧪 Step-by-Step Testing Guide

### 1. Local Browser Test (Same Machine)
- Open **Tab A** to `http://localhost:3000` (Agent Dashboard).
- Click **Generate Session Invite** and copy the Customer Invite Link.
- Click **Launch Session** to join as the Agent.
- Open **Tab B** (in Incognito or a separate browser window), paste the Customer Invite Link, enter a name, and click **Join Call**.
- Grant camera/mic permissions. You are now connected via the local TURN server!

### 2. Testing with Friends (Over the Internet)
Browsers require a **Secure Context (HTTPS)** to allow camera and microphone access. To invite a friend on another device:
1. Run a local secure tunnel (like [Ngrok](https://ngrok.com/)):
   ```bash
   ngrok http 3000
   ```
2. Use the public HTTPS URL generated by Ngrok (e.g. `https://xxxx.ngrok-free.app`) to access the Agent Dashboard.
3. Generate the session invite. The link will automatically reflect the secure public address, allowing your friend to join.

---

## 📊 Operations & Observability Panel
Navigate to `http://localhost:3000/admin.html` to:
- Monitor total historical and active calls.
- Inspect connected user listings.
- Read live system audit logs.
- Click **Terminate** to force-end a session remotely.
- Access the scraped JSON metrics raw feed at `http://localhost:3000/api/admin/metrics`.
