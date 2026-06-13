document.addEventListener('DOMContentLoaded', () => {
  const refreshMetricsBtn = document.getElementById('refreshMetricsBtn');
  const activeSessionsVal = document.getElementById('activeSessionsVal');
  const connectedParticipantsVal = document.getElementById('connectedParticipantsVal');
  const totalSessionsVal = document.getElementById('totalSessionsVal');
  const healthRateVal = document.getElementById('healthRateVal');
  const healthRateLabel = document.getElementById('healthRateLabel');
  
  const liveSessionsList = document.getElementById('liveSessionsList');
  const logTicker = document.getElementById('logTicker');

  // Load metrics initially
  fetchMetrics();

  // Poll metrics every 3 seconds
  const pollingInterval = setInterval(fetchMetrics, 3000);

  refreshMetricsBtn.addEventListener('click', fetchMetrics);

  async function fetchMetrics() {
    try {
      const response = await fetch('/api/admin/metrics');
      if (!response.ok) throw new Error('Failed to retrieve metrics');

      const data = await response.json();
      
      // Update KPI metrics
      activeSessionsVal.textContent = data.activeSessionsCount;
      connectedParticipantsVal.textContent = data.connectedParticipantsCount;
      totalSessionsVal.textContent = data.totalSessionsCount;

      // Calculate health & error rate based on last 50 events
      calculateSystemHealth(data.recentEvents);

      // Render items
      renderActiveSessions(data.activeSessions);
      renderEventLogs(data.recentEvents);

    } catch (err) {
      console.error('Error fetching admin metrics:', err);
    }
  }

  function calculateSystemHealth(events) {
    if (!events || events.length === 0) {
      healthRateVal.textContent = '0%';
      healthRateVal.style.color = '#fff';
      healthRateLabel.innerHTML = '<i class="fa-solid fa-circle-check"></i> System Initialized';
      return;
    }

    const totalEvents = events.length;
    // Count error-like events
    const errorEvents = events.filter(e => 
      e.type === 'error' || 
      e.type === 'participant_left_timeout' || 
      e.type.includes('fail')
    ).length;

    const errorRate = Math.round((errorEvents / totalEvents) * 100);
    
    if (errorRate > 15) {
      healthRateVal.textContent = `${errorRate}%`;
      healthRateVal.style.color = 'var(--accent-red)';
      healthRateLabel.innerHTML = '<i class="fa-solid fa-triangle-exclamation" style="color: var(--accent-red);"></i> Degraded Performance';
    } else if (errorRate > 0) {
      healthRateVal.textContent = `${errorRate}%`;
      healthRateVal.style.color = 'var(--accent-pink)';
      healthRateLabel.innerHTML = '<i class="fa-solid fa-circle-exclamation" style="color: var(--accent-pink);"></i> Minor Alerts Logged';
    } else {
      healthRateVal.textContent = '0%';
      // Reset color to gradient or white
      healthRateVal.style.color = 'var(--accent-emerald)';
      healthRateLabel.innerHTML = '<i class="fa-solid fa-shield-halved" style="color: var(--accent-emerald);"></i> All Systems Nominal';
    }
  }

  function renderActiveSessions(activeSessions) {
    if (!activeSessions || activeSessions.length === 0) {
      liveSessionsList.innerHTML = `
        <div style="text-align: center; padding: 2rem; color: var(--color-text-muted);">
          <p>No support sessions are active right now.</p>
        </div>
      `;
      return;
    }

    liveSessionsList.innerHTML = '';

    activeSessions.forEach(session => {
      const card = document.createElement('div');
      card.className = 'glass-panel history-card';

      // Uptime
      const start = new Date(session.createdAt);
      const diffMs = new Date() - start;
      const diffMins = Math.floor(diffMs / 60000);
      const diffSecs = Math.floor((diffMs % 60000) / 1000);
      const durationStr = `${diffMins}m ${diffSecs}s`;

      // Build participant listing
      let participantsHtml = '';
      if (session.participants && session.participants.length > 0) {
        session.participants.forEach(p => {
          const badgeClass = p.role === 'Agent' ? 'badge-agent' : 'badge-customer';
          participantsHtml += `
            <span class="badge ${badgeClass}" style="font-size: 0.7rem; padding: 0.15rem 0.5rem; margin-top: 0.25rem;">
              ${p.username}
            </span>
          `;
        });
      } else {
        participantsHtml = '<span style="font-style: italic; font-size: 0.8rem; color: var(--color-text-muted);">Empty Room</span>';
      }

      card.innerHTML = `
        <div class="history-info" style="flex: 1;">
          <div style="display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;">
            <span class="history-title" style="font-size: 0.95rem; font-family: monospace;">Room: ${session.id.substring(0, 8)}...</span>
            <span class="badge badge-active"><i class="fa-solid fa-clock"></i> ${durationStr}</span>
          </div>
          <div style="font-size: 0.8rem; color: var(--color-text-muted); margin-top: 0.25rem;">
            Created by Agent: <strong>${session.agentId}</strong>
          </div>
          <div style="display: flex; gap: 0.4rem; flex-wrap: wrap; margin-top: 0.4rem; align-items: center;">
            <span style="font-size: 0.8rem; color: var(--color-text-muted);">In-Call:</span>
            ${participantsHtml}
          </div>
        </div>
        <div class="history-actions">
          <button class="btn btn-danger terminate-btn" data-id="${session.id}" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;">
            <i class="fa-solid fa-ban"></i> Terminate
          </button>
        </div>
      `;

      liveSessionsList.appendChild(card);
    });

    // Add termination event listeners
    document.querySelectorAll('.terminate-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        if (confirm(`Are you sure you want to force terminate session ${id.substring(0, 8)}?`)) {
          try {
            const res = await fetch(`/api/admin/sessions/${id}/terminate`, {
              method: 'POST'
            });
            if (!res.ok) throw new Error('Failed to terminate session');
            fetchMetrics(); // reload
          } catch (err) {
            alert(err.message);
          }
        }
      });
    });
  }

  function renderEventLogs(events) {
    if (!events || events.length === 0) {
      logTicker.innerHTML = `
        <div style="color: var(--color-text-muted); text-align: center; margin-top: 5rem;">
          No events logged yet.
        </div>
      `;
      return;
    }

    logTicker.innerHTML = '';

    events.forEach(event => {
      const logDiv = document.createElement('div');
      logDiv.className = 'log-entry';

      const time = new Date(event.timestamp).toLocaleTimeString();
      const detailsStr = JSON.stringify(event.details);

      logDiv.innerHTML = `
        <span class="log-time">[${time}]</span>
        <span class="log-type ${event.type}">${event.type.toUpperCase()}</span>
        <span class="log-details" style="color: var(--color-text-muted); flex: 1; word-break: break-all;">
          Room ${event.sessionId ? event.sessionId.substring(0,8) : 'GLOBAL'} - ${detailsStr}
        </span>
      `;

      logTicker.appendChild(logDiv);
    });
  }

  // Cleanup polling on page unload
  window.addEventListener('beforeunload', () => {
    clearInterval(pollingInterval);
  });
});
