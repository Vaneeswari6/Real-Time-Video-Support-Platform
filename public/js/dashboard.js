document.addEventListener('DOMContentLoaded', () => {
  const createSessionForm = document.getElementById('createSessionForm');
  const agentNameInput = document.getElementById('agentName');
  const inviteResult = document.getElementById('inviteResult');
  const inviteUrlDiv = document.getElementById('inviteUrl');
  const inviteTokenDiv = document.getElementById('inviteToken');
  const copyInviteBtn = document.getElementById('copyInviteBtn');
  const joinAgentCallBtn = document.getElementById('joinAgentCallBtn');
  const historyList = document.getElementById('historyList');
  const refreshHistoryBtn = document.getElementById('refreshHistoryBtn');

  let activeSessionToken = '';

  // Load session history on startup
  fetchHistory();

  createSessionForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const agentId = agentNameInput.value.trim() || 'Agent';

    try {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ agentId })
      });

      if (!response.ok) throw new Error('Failed to create session');

      const session = await response.json();
      activeSessionToken = session.token;

      // Generate shareable links
      const currentOrigin = window.location.origin;
      const customerInviteUrl = `${currentOrigin}/call.html?token=${session.token}`;
      
      inviteUrlDiv.textContent = customerInviteUrl;
      inviteTokenDiv.textContent = session.token;
      
      // Update agent join button to point to the call page with token and username
      joinAgentCallBtn.href = `/call.html?token=${session.token}&username=${encodeURIComponent(agentId)}&role=Agent`;
      
      inviteResult.style.display = 'block';

      // Refresh list
      fetchHistory();
    } catch (err) {
      console.error(err);
      alert('Error creating session: ' + err.message);
    }
  });

  // Copy invitation link to clipboard
  copyInviteBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const urlText = inviteUrlDiv.textContent;
    if (!urlText) return;

    navigator.clipboard.writeText(urlText)
      .then(() => {
        const originalHtml = copyInviteBtn.innerHTML;
        copyInviteBtn.innerHTML = '<i class="fa-solid fa-check" style="color: var(--accent-emerald);"></i>';
        setTimeout(() => {
          copyInviteBtn.innerHTML = originalHtml;
        }, 2000);
      })
      .catch(err => {
        console.error('Failed to copy text: ', err);
      });
  });

  // Refresh history button
  refreshHistoryBtn.addEventListener('click', fetchHistory);

  // Fetch session history list
  async function fetchHistory() {
    try {
      const response = await fetch('/api/sessions/history');
      if (!response.ok) throw new Error('Failed to load history');

      const sessions = await response.json();
      renderHistory(sessions);
    } catch (err) {
      console.error(err);
      historyList.innerHTML = `
        <div style="text-align: center; color: var(--accent-red); padding: 1.5rem;">
          <i class="fa-solid fa-triangle-exclamation" style="font-size: 1.5rem; margin-bottom: 0.5rem;"></i>
          <p>Failed to load session history.</p>
        </div>
      `;
    }
  }

  // Render session history items
  function renderHistory(sessions) {
    if (!sessions || sessions.length === 0) {
      historyList.innerHTML = `
        <div style="text-align: center; padding: 3rem; color: var(--color-text-muted);">
          <i class="fa-regular fa-folder-open" style="font-size: 2.5rem; margin-bottom: 1rem; color: rgba(255,255,255,0.15);"></i>
          <p>No support session history found.</p>
        </div>
      `;
      return;
    }

    historyList.innerHTML = '';
    
    sessions.forEach(session => {
      const card = document.createElement('div');
      card.className = 'glass-panel history-card';

      const createdDate = new Date(session.createdAt).toLocaleString();
      const isEnded = session.status === 'ended';
      
      let badgeHtml = '';
      if (!isEnded) {
        badgeHtml = `<span class="badge badge-active"><i class="fa-solid fa-circle-play"></i> Active</span>`;
      } else {
        badgeHtml = `<span class="badge badge-ended"><i class="fa-solid fa-circle-stop"></i> Ended</span>`;
      }

      // Calculate duration
      let durationStr = 'In Progress';
      if (session.endedAt) {
        const start = new Date(session.createdAt);
        const end = new Date(session.endedAt);
        const diffMs = end - start;
        const diffMins = Math.floor(diffMs / 60000);
        const diffSecs = Math.floor((diffMs % 60000) / 1000);
        durationStr = `${diffMins}m ${diffSecs}s`;
      }

      // Action buttons
      let actionsHtml = '';
      
      // Invite URL to re-join if active
      if (!isEnded) {
        actionsHtml += `
          <a href="/call.html?token=${session.token}&username=Support%20Agent&role=Agent" class="btn btn-secondary" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;" title="Join call">
            <i class="fa-solid fa-door-open"></i> Join
          </a>
        `;
      }

      // Recording download button if available
      if (session.recording && session.recording.status === 'ready') {
        actionsHtml += `
          <a href="${session.recording.filePath}" download="${session.recording.fileName}" class="btn btn-primary" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;" title="Download Recording">
            <i class="fa-solid fa-download"></i> Rec
          </a>
        `;
      } else if (session.recording && session.recording.status === 'in_progress') {
        actionsHtml += `
          <span class="badge" style="background: rgba(239, 68, 68, 0.15); color: var(--accent-red); border: 1px solid rgba(239, 68, 68, 0.3); font-size: 0.75rem;">
            <i class="fa-solid fa-record-vinyl fa-spin"></i> Recording
          </span>
        `;
      }

      card.innerHTML = `
        <div class="history-info">
          <div style="display: flex; align-items: center; gap: 0.75rem;">
            <span class="history-title">Session with ${session.agentId}</span>
            ${badgeHtml}
          </div>
          <div class="history-meta">
            <span><i class="fa-solid fa-calendar-days"></i> ${createdDate}</span>
            <span><i class="fa-solid fa-clock"></i> ${durationStr}</span>
            <span><i class="fa-solid fa-ticket"></i> Token: <code style="background: rgba(0,0,0,0.2); padding: 0.1rem 0.3rem; border-radius: 4px;">${session.token.substring(0,8)}...</code></span>
          </div>
        </div>
        <div class="history-actions">
          ${actionsHtml}
        </div>
      `;

      historyList.appendChild(card);
    });
  }
});
