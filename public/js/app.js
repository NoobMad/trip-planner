/* ============================================
   TripPlannerAI — Shared client helpers
   ============================================ */
const App = (() => {
  async function api(path, options = {}) {
    const opts = { ...options, headers: { ...(options.headers || {}) } };

    if (opts.body && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }

    const res = await fetch(path, opts);

    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }

    if (res.status === 401) {
      window.location.href = '/login.html';
      throw new Error('Not authenticated');
    }

    if (!res.ok) {
      throw new Error((data && data.error) || `Request failed (${res.status})`);
    }

    return data;
  }

  // Silent auth probe — never redirects or throws on public pages.
  async function checkAuth() {
    try {
      const res = await fetch('/auth/status', { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      const data = await res.json();
      return data.authenticated ? data : null;
    } catch (_) {
      return null;
    }
  }

  function toast(message, type = 'info', timeout = 4000) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const icons = {
      success: 'bi-check-circle-fill',
      error: 'bi-exclamation-triangle-fill',
      info: 'bi-info-circle-fill'
    };

    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `
      <i class="bi ${icons[type] || icons.info}"></i>
      <span>${escapeHtml(message)}</span>
      <button class="toast-close" type="button" aria-label="Dismiss">&times;</button>
    `;

    container.appendChild(el);

    const remove = () => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(20px)';
      el.style.transition = 'all 200ms ease';
      setTimeout(() => el.remove(), 200);
    };

    el.querySelector('.toast-close').addEventListener('click', remove);
    if (timeout) setTimeout(remove, timeout);
  }

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function money(value) {
    const num = Number(value) || 0;
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: num >= 100 || num === 0 ? 0 : 2
    }).format(num);
  }

  function formatDate(value, opts = {}) {
    if (!value) return '';
    // SQLite CURRENT_TIMESTAMP is UTC without a zone marker.
    const normalized = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
      ? `${value.replace(' ', 'T')}Z`
      : value;
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...opts });
  }

  function dateRange(start, end) {
    if (!start && !end) return '';
    if (start && end) {
      return `${formatDate(start)} – ${formatDate(end, { year: 'numeric' })}`;
    }
    return formatDate(start || end, { year: 'numeric' });
  }

  function initials(name) {
    return String(name || '?')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join('');
  }

  const MOOD_EMOJI = {
    adventurous: '🏔️',
    relaxing: '🏝️',
    cultural: '⛩️',
    romantic: '🌅',
    foodie: '🍜',
    party: '🎉'
  };

  function tripEmoji(trip) {
    if (!trip) return '✈️';
    return MOOD_EMOJI[trip.mood] || '✈️';
  }

  function statusClass(status) {
    return `status-${['planned', 'ongoing', 'completed'].includes(status) ? status : 'planned'}`;
  }

  function pluralize(count, singular, plural) {
    return `${count} ${count === 1 ? singular : plural || singular + 's'}`;
  }

  return {
    api,
    checkAuth,
    toast,
    escapeHtml,
    money,
    formatDate,
    dateRange,
    initials,
    tripEmoji,
    statusClass,
    pluralize
  };
})();
