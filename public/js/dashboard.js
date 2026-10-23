/* ============================================
   TripPlannerAI — Dashboard client
   ============================================ */
(() => {
  const { api, toast, escapeHtml, money, formatDate, dateRange, initials, tripEmoji, statusClass, pluralize } = App;
  const e = escapeHtml;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const VIEWS = ['overview', 'plan', 'trips', 'trip', 'suggestions', 'saved', 'preferences'];
  const META = {
    overview: ['Overview', 'A snapshot of your travel plans.'],
    plan: ['Plan a trip', 'Tell us the basics and we will draft the rest.'],
    trips: ['My trips', 'Every itinerary you have generated.'],
    trip: ['Trip itinerary', 'Your day-by-day plan.'],
    suggestions: ['Suggestions', 'Destinations matched to your mood, group, and budget.'],
    saved: ['Saved places', 'Your personal travel wishlist.'],
    preferences: ['Preferences', 'Defaults we apply to every new itinerary.']
  };

  const state = {
    user: null,
    preferences: null,
    trips: [],
    recentTrips: [],
    stats: null,
    currentTrip: null,
    suggestions: null,
    filters: { search: '', status: 'all' },
    loadingSuggestions: false,
    loadingPlan: false
  };

  /* ---------------- Utilities ---------------- */

  function selectedValues(container) {
    return $$('.chip.selected', container).map((chip) => chip.dataset.value);
  }

  function setSelected(container, values = []) {
    const wanted = new Set(values || []);
    $$('.chip', container).forEach((chip) => {
      chip.classList.toggle('selected', wanted.has(chip.dataset.value));
    });
  }

  function wireChips(container, { single = false } = {}) {
    if (!container) return;
    container.addEventListener('click', (event) => {
      const chip = event.target.closest('.chip');
      if (!chip) return;
      if (single) {
        $$('.chip', container).forEach((c) => c.classList.remove('selected'));
        chip.classList.add('selected');
      } else {
        chip.classList.toggle('selected');
      }
    });
  }

  function addDays(dateString, days) {
    const date = new Date(`${dateString}T00:00:00`);
    if (Number.isNaN(date.getTime())) return null;
    date.setDate(date.getDate() + days);
    return date;
  }

  function dayLabel(startDate, dayNumber) {
    const date = startDate ? addDays(startDate, dayNumber - 1) : null;
    if (!date) return '';
    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  }

  function budgetTotal(itinerary, duration) {
    const b = (itinerary && itinerary.estimated_budget) || {};
    if (Number(b.total_estimated)) return Number(b.total_estimated);
    const perDay = ['accommodation_per_night', 'food_per_day', 'activities_per_day', 'transport_per_day']
      .reduce((sum, key) => sum + (Number(b[key]) || 0), 0);
    return perDay * (Number(duration) || 1);
  }

  function dayCount(trip) {
    const itinerary = (trip && trip.itinerary) || {};
    if (Array.isArray(itinerary.days) && itinerary.days.length) return itinerary.days.length;
    return Number(trip && trip.duration_days) || 1;
  }

  function closeSidebar() {
    $('#sidebar').classList.remove('open');
    $('#sidebarOverlay').classList.remove('active');
  }

  /* ---------------- Routing ---------------- */

  function currentRoute() {
    const raw = decodeURIComponent(window.location.hash.replace(/^#/, '')) || 'overview';
    const parts = raw.split('/');
    const name = parts.shift();
    return { name: VIEWS.includes(name) ? name : 'overview', param: parts.join('/') };
  }

  function setActiveNav(view) {
    $$('.sidebar-link[data-nav]').forEach((link) => {
      link.classList.toggle('active', link.dataset.nav === view);
    });
  }

  async function renderRoute() {
    const { name, param } = currentRoute();

    VIEWS.forEach((view) => {
      $(`#view-${view}`).classList.toggle('d-none', view !== name);
    });

    const meta = META[name];
    $('#pageTitle').textContent = meta[0];
    $('#pageSubtitle').textContent = meta[1];

    setActiveNav(name === 'trip' ? 'trips' : name);
    closeSidebar();
    window.scrollTo({ top: 0 });

    try {
      if (name === 'overview') await loadOverview();
      else if (name === 'trips') await loadTrips();
      else if (name === 'trip') await loadTrip(param);
      else if (name === 'suggestions') await loadSuggestions(false);
      else if (name === 'saved') await loadSaved();
      else if (name === 'preferences') await loadPreferences();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  /* ---------------- User ---------------- */

  async function loadUser() {
    const data = await api('/auth/me');
    state.user = data.user;
    state.preferences = data.preferences || null;

    const name = state.user.name || 'Traveler';
    $('#userName').textContent = name;
    $('#userEmail').textContent = state.user.email || '';
    $('#userAvatar').innerHTML = state.user.avatar
      ? `<img src="${e(state.user.avatar)}" alt="${e(name)}">`
      : e(initials(name));
  }

  function applyPreferencesToPlanForm() {
    const prefs = state.preferences;
    if (!prefs) return;

    if (prefs.budget_range) setSelected($('#budgetChips'), [prefs.budget_range]);
    if (prefs.favorite_activities) {
      try {
        const favorites = JSON.parse(prefs.favorite_activities);
        if (Array.isArray(favorites)) setSelected($('#interestChips'), favorites);
      } catch (_) { /* stored value was not JSON — ignore */ }
    }
  }

  /* ---------------- Overview ---------------- */

  async function loadOverview() {
    const [stats, trips] = await Promise.all([
      api('/api/trips/stats/dashboard'),
      api('/api/trips')
    ]);

    state.stats = stats.stats;
    state.recentTrips = stats.recentTrips || [];
    state.trips = trips.trips || [];

    $('#statTotalTrips').textContent = stats.stats.totalTrips;
    $('#statPlanned').textContent = stats.stats.plannedTrips;
    $('#statCompleted').textContent = stats.stats.completedTrips;
    $('#statActivities').textContent = stats.stats.totalActivities;
    $('#savedCount').textContent = stats.stats.savedPlaces;

    renderRecentTrips();
    renderTopDestinations();
  }

  function renderRecentTrips() {
    const container = $('#recentTrips');

    if (!state.recentTrips.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🌍</div>
          <div class="empty-title">No trips yet</div>
          <p class="empty-text">Your first itinerary is about a minute away.</p>
          <a class="btn-glow btn-sm mt-2" href="#plan"><i class="bi bi-magic me-1"></i>Plan a trip</a>
        </div>`;
      return;
    }

    container.innerHTML = state.recentTrips.map((trip) => `
      <a class="trip-list-item" href="#trip/${encodeURIComponent(trip.id)}">
        <div class="trip-emoji">${tripEmoji(trip)}</div>
        <div class="trip-info">
          <div class="trip-name">${e(trip.destination)}</div>
          <div class="trip-meta">${e(pluralize(dayCount(trip), 'day'))}${
            trip.start_date ? ` · ${e(dateRange(trip.start_date, trip.end_date))}` : ''
          }</div>
        </div>
        <span class="trip-status ${statusClass(trip.status)}">${e(trip.status)}</span>
      </a>
    `).join('');
  }

  function renderTopDestinations() {
    const container = $('#topDestinations');
    const top = (state.stats && state.stats.topDestinations) || [];

    if (!top.length) {
      container.innerHTML = '<p class="text-muted-soft mb-0">No trips yet — destinations will appear here.</p>';
      return;
    }

    const max = Math.max(...top.map((item) => item.count));
    container.innerHTML = top.map((item) => `
      <div class="dest-row">
        <div class="d-flex justify-content-between align-items-center mb-1">
          <span class="dest-name">${e(item.destination)}</span>
          <span class="dest-count">${item.count} ${item.count === 1 ? 'trip' : 'trips'}</span>
        </div>
        <div class="dest-bar"><span style="width:${Math.max(8, Math.round((item.count / max) * 100))}%"></span></div>
      </div>
    `).join('');
  }

  /* ---------------- Trips ---------------- */

  async function loadTrips() {
    const data = await api('/api/trips');
    state.trips = data.trips || [];
    renderTrips();
  }

  function filteredTrips() {
    const term = state.filters.search.trim().toLowerCase();
    return state.trips.filter((trip) => {
      const matchesStatus = state.filters.status === 'all' || trip.status === state.filters.status;
      const matchesTerm = !term
        || String(trip.destination).toLowerCase().includes(term)
        || String((trip.itinerary && trip.itinerary.summary) || '').toLowerCase().includes(term);
      return matchesStatus && matchesTerm;
    });
  }

  function renderTrips() {
    const grid = $('#tripsGrid');
    const empty = $('#tripsEmpty');
    const trips = filteredTrips();

    if (!trips.length) {
      grid.innerHTML = '';
      empty.classList.remove('d-none');

      if (state.trips.length) {
        empty.querySelector('.empty-title').textContent = 'No trips match those filters';
        empty.querySelector('.empty-text').textContent = 'Try a different destination or status.';
        empty.querySelector('.btn-glow').classList.add('d-none');
      } else {
        empty.querySelector('.empty-title').textContent = 'No trips here yet';
        empty.querySelector('.empty-text').textContent = 'Generate your first itinerary and it will show up right here.';
        empty.querySelector('.btn-glow').classList.remove('d-none');
      }
      return;
    }

    empty.classList.add('d-none');

    grid.innerHTML = trips.map((trip) => {
      const days = dayCount(trip);
      const summary = (trip.itinerary && trip.itinerary.summary) || '';
      const interests = Array.isArray(trip.interests) ? trip.interests : [];

      return `
        <div class="col-md-6 col-xxl-4">
          <article class="trip-card">
            <div class="trip-card-top">
              <div class="trip-emoji">${tripEmoji(trip)}</div>
              <span class="trip-status ${statusClass(trip.status)}">${e(trip.status)}</span>
            </div>

            <h3 class="trip-card-title">${e(trip.destination)}</h3>
            <p class="trip-card-meta">
              <i class="bi bi-clock"></i> ${e(pluralize(days, 'day'))}
              ${trip.start_date ? ` · <i class="bi bi-calendar3"></i> ${e(dateRange(trip.start_date, trip.end_date))}` : ''}
            </p>
            ${summary ? `<p class="trip-card-summary">${e(summary)}</p>` : ''}

            <div class="trip-card-tags">
              <span class="meta-tag">${e(trip.mood)}</span>
              <span class="meta-tag">${e(trip.group_type)}</span>
              <span class="meta-tag">${e(trip.budget)}</span>
              ${interests.slice(0, 2).map((tag) => `<span class="meta-tag">${e(tag)}</span>`).join('')}
            </div>

            <div class="trip-card-actions">
              <a class="trip-card-link" href="#trip/${encodeURIComponent(trip.id)}">
                View itinerary <i class="bi bi-arrow-right"></i>
              </a>
              <button class="btn-icon-danger" type="button" title="Delete trip"
                      data-delete-trip="${e(trip.id)}" data-trip-name="${e(trip.destination)}">
                <i class="bi bi-trash3"></i>
              </button>
            </div>
          </article>
        </div>`;
    }).join('');
  }

  async function deleteTrip(id, name) {
    const ok = window.confirm(`Delete the trip to ${name}? This cannot be undone.`);
    if (!ok) return;

    try {
      await api(`/api/trips/${encodeURIComponent(id)}`, { method: 'DELETE' });
      state.trips = state.trips.filter((trip) => trip.id !== id);
      state.recentTrips = state.recentTrips.filter((trip) => trip.id !== id);
      renderTrips();
      toast('Trip deleted.', 'success');
      if (currentRoute().name === 'trip') window.location.hash = '#trips';
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  /* ---------------- Trip detail ---------------- */

  async function loadTrip(id) {
    if (!id) {
      window.location.hash = '#trips';
      return;
    }

    const detail = $('#tripDetail');
    detail.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><div class="loading-text">Loading itinerary…</div></div>';

    const data = await api(`/api/trips/${encodeURIComponent(id)}`);
    state.currentTrip = data;
    renderTrip(data);
  }

  function activityIndex(activities) {
    const map = new Map();
    (activities || []).forEach((activity) => {
      const key = `${activity.day_number}|${String(activity.time_slot || '').trim().toLowerCase()}`;
      if (!map.has(key)) map.set(key, activity);
    });
    return map;
  }

  function renderTrip({ trip, activities }) {
    const itinerary = trip.itinerary || {};
    const days = Array.isArray(itinerary.days) ? itinerary.days : [];
    const lookup = activityIndex(activities);
    const itineraryDays = days.length
      ? days
      : groupActivitiesIntoDays(activities);

    const totalActivities = Array.isArray(activities) ? activities.length : 0;
    const doneActivities = Array.isArray(activities) ? activities.filter((a) => a.is_completed).length : 0;
    const percent = totalActivities ? Math.round((doneActivities / totalActivities) * 100) : 0;

    const budget = itinerary.estimated_budget || {};
    const total = budgetTotal(itinerary, itineraryDays.length || trip.duration_days);
    const needsRealPlaces = itinerary.ai_generated === false || looksGeneric(itineraryDays);

    $('#tripDetail').innerHTML = `
      ${needsRealPlaces ? `
        <div class="ai-notice" role="status">
          <i class="bi bi-exclamation-triangle-fill"></i>
          <div>
            <strong>This plan uses generic slots, not named places.</strong>
            The AI was unavailable when it was generated. Hit <em>Regenerate</em> for a version with
            actual museums, restaurants and neighbourhoods.
          </div>
        </div>` : ''}

      <div class="itinerary-header">
        <div class="d-flex flex-wrap justify-content-between gap-3">
          <div>
            <h2 class="itinerary-destination">${tripEmoji(trip)} ${e(trip.destination)}</h2>
            ${itinerary.summary ? `<p class="itinerary-summary">${e(itinerary.summary)}</p>` : ''}
          </div>
          <div class="trip-header-actions">
            <button class="btn-outline-glow btn-sm" type="button" id="regenerateBtn" title="Build a fresh itinerary with different places">
              <i class="bi bi-arrow-repeat"></i> Regenerate
            </button>
            <select class="form-select-custom" id="tripStatusSelect" aria-label="Trip status">
              ${['planned', 'ongoing', 'completed'].map((status) => `
                <option value="${status}" ${trip.status === status ? 'selected' : ''}>${status.charAt(0).toUpperCase() + status.slice(1)}</option>
              `).join('')}
            </select>
            <button class="btn-icon-danger" type="button" id="deleteTripBtn" title="Delete trip">
              <i class="bi bi-trash3"></i>
            </button>
          </div>
        </div>

        <div class="itinerary-meta">
          ${trip.start_date ? `<span class="meta-tag"><i class="bi bi-calendar3"></i> ${e(dateRange(trip.start_date, trip.end_date))}</span>` : ''}
          <span class="meta-tag"><i class="bi bi-clock"></i> ${e(pluralize(itineraryDays.length, 'day'))}</span>
          <span class="meta-tag"><i class="bi bi-people"></i> ${e(trip.group_type)}</span>
          <span class="meta-tag"><i class="bi bi-wallet2"></i> ${e(trip.budget)}</span>
          <span class="meta-tag"><i class="bi bi-stars"></i> ${e(trip.mood)}</span>
        </div>

        <div class="trip-progress">
          <div class="d-flex justify-content-between">
            <span class="progress-label" id="tripProgressText">${doneActivities} of ${totalActivities} activities done</span>
            <span class="progress-percent">${percent}%</span>
          </div>
          <div class="progress-track"><span id="tripProgressBar" style="width:${percent}%"></span></div>
        </div>

        ${trip.notes ? `<p class="trip-notes"><i class="bi bi-journal-text"></i> ${e(trip.notes)}</p>` : ''}
      </div>

      <div class="row g-4">
        <div class="col-xl-8">
          ${itineraryDays.length
            ? itineraryDays.map((day, index) => renderDay(day, index, trip.start_date, lookup)).join('')
            : `<div class="dash-card"><div class="empty-state">
                 <div class="empty-icon">🗺️</div>
                 <div class="empty-title">No days in this itinerary</div>
                 <p class="empty-text">This trip was saved without a day-by-day plan.</p>
               </div></div>`}
        </div>

        <div class="col-xl-4">
          ${renderBudgetCard(budget, total, itineraryDays.length || trip.duration_days)}
          ${Array.isArray(itinerary.highlights) && itinerary.highlights.length ? `
            <div class="dash-card mb-4">
              <div class="dash-card-header"><span class="dash-card-title">Highlights</span></div>
              ${itinerary.highlights.map((item) => `
                <div class="highlight-item"><span class="highlight-dot"></span><span class="highlight-text">${e(item)}</span></div>
              `).join('')}
            </div>` : ''}
          ${Array.isArray(itinerary.packing_tips) && itinerary.packing_tips.length ? `
            <div class="dash-card mb-4">
              <div class="dash-card-header"><span class="dash-card-title">Packing tips</span></div>
              ${itinerary.packing_tips.map((item) => `
                <div class="tip-item"><i class="bi bi-bag-check tip-icon"></i><span class="tip-text">${e(item)}</span></div>
              `).join('')}
            </div>` : ''}
          ${Array.isArray(itinerary.local_tips) && itinerary.local_tips.length ? `
            <div class="dash-card">
              <div class="dash-card-header"><span class="dash-card-title">Local tips</span></div>
              ${itinerary.local_tips.map((item) => `
                <div class="tip-item"><i class="bi bi-lightbulb tip-icon"></i><span class="tip-text">${e(item)}</span></div>
              `).join('')}
            </div>` : ''}
        </div>
      </div>
    `;

  }

  // Legacy trips saved before the specific-place prompt stored rows like
  // "Breakfast in Kyoto" — flag them so the UI can offer a regeneration.
  function looksGeneric(days) {
    const names = (days || [])
      .flatMap((day) => (Array.isArray(day.activities) ? day.activities : []))
      .map((activity) => String(activity.name || '').trim());

    if (!names.length) return false;

    const generic = names.filter((name) =>
      /^(breakfast|lunch|dinner|brunch|snack|morning exploration|morning walk|afternoon activity|evening discovery|evening stroll|sightseeing)\b/i.test(name)
    ).length;

    return generic >= Math.ceil(names.length / 2);
  }

  async function regenerateTrip(button) {
    if (!state.currentTrip) return;
    const trip = state.currentTrip.trip;

    const ok = window.confirm(`Rebuild the itinerary for ${trip.destination} with fresh places? Activity checkmarks will reset.`);
    if (!ok) return;

    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Regenerating…';

    try {
      const result = await api(`/api/trips/${encodeURIComponent(trip.id)}/regenerate`, { method: 'POST' });
      const detail = await api(`/api/trips/${encodeURIComponent(trip.id)}`);
      state.currentTrip = detail;
      renderTrip(detail);

      if (result.aiGenerated === false) {
        toast('AI is still busy — this is a fresh starter outline. Try again in a minute.', 'info', 7000);
      } else {
        toast('Fresh itinerary ready with new places. ✨', 'success');
      }
    } catch (error) {
      button.disabled = false;
      button.innerHTML = original;
      toast(error.message, 'error', 8000);
    }
  }

  function groupActivitiesIntoDays(activities) {
    const groups = new Map();
    (activities || []).forEach((activity) => {
      const key = activity.day_number;
      if (!groups.has(key)) groups.set(key, { day: key, theme: `Day ${key}`, activities: [] });
      groups.get(key).activities.push(activity);
    });

    return Array.from(groups.values()).map((group) => ({
      day: group.day,
      theme: group.theme,
      activities: group.activities.map((activity) => ({
        time: activity.time_slot,
        name: activity.activity_name,
        description: activity.description,
        location: activity.location,
        estimated_cost: activity.estimated_cost,
        category: activity.category,
        __id: activity.id,
        __done: !!activity.is_completed
      }))
    }));
  }

  function renderDay(day, index, startDate, lookup) {
    const activities = day.activities || [];
    const dateLabel = dayLabel(startDate, day.day || index + 1);

    return `
      <div class="day-card">
        <div class="day-header" data-day-toggle="${index}" role="button" tabindex="0">
          <div class="day-badge">
            <div class="day-number">${day.day || index + 1}</div>
            <div>
              <div class="day-title">${e(day.theme || `Day ${day.day || index + 1}`)}</div>
              ${dateLabel ? `<div class="day-sub">${e(dateLabel)}</div>` : ''}
            </div>
          </div>
          <i class="bi bi-chevron-down day-chevron ${index === 0 ? 'open' : ''}"></i>
        </div>
        <div class="day-body ${index === 0 ? '' : 'd-none'}" data-day-body="${index}">
          ${activities.length ? activities.map((activity) => renderActivity(activity, day.day || index + 1, lookup)).join('')
            : '<p class="text-muted-soft mb-0">No activities for this day.</p>'}
        </div>
      </div>`;
  }

  function renderActivity(activity, dayNumber, lookup) {
    const key = `${dayNumber}|${String(activity.time || '').trim().toLowerCase()}`;
    const saved = activity.__id ? null : lookup.get(key);
    const id = activity.__id || (saved && saved.id);
    const done = activity.__done !== undefined ? activity.__done : !!(saved && saved.is_completed);

    return `
      <div class="activity-item">
        ${id
          ? `<input class="form-check-input activity-check" type="checkbox" data-activity-id="${id}" ${done ? 'checked' : ''} aria-label="Mark ${e(activity.name)} complete">`
          : '<span class="activity-dot"></span>'}
        <div class="activity-time">${e(activity.time || '')}</div>
        <div class="activity-content">
          <div class="activity-name">${e(activity.name || activity.activity_name || 'Activity')}</div>
          ${activity.description ? `<div class="activity-desc">${e(activity.description)}</div>` : ''}
          <div class="activity-tags">
            ${activity.location ? `<span class="activity-tag tag-location"><i class="bi bi-geo-alt"></i> ${e(activity.location)}</span>` : ''}
            ${Number(activity.estimated_cost) ? `<span class="activity-tag tag-cost">${e(money(activity.estimated_cost))}</span>` : ''}
            ${activity.category ? `<span class="activity-tag tag-category">${e(activity.category)}</span>` : ''}
            ${activity.duration ? `<span class="activity-tag tag-duration"><i class="bi bi-hourglass-split"></i> ${e(activity.duration)}</span>` : ''}
          </div>
          ${activity.tip ? `<div class="activity-tip"><i class="bi bi-lightbulb"></i> ${e(activity.tip)}</div>` : ''}
        </div>
      </div>`;
  }

  function renderBudgetCard(budget, total, days) {
    const rows = [
      ['Accommodation / night', budget.accommodation_per_night],
      ['Food / day', budget.food_per_day],
      ['Activities / day', budget.activities_per_day],
      ['Transport / day', budget.transport_per_day]
    ].filter(([, value]) => Number(value) > 0);

    if (!rows.length && !Number(total)) return '';

    return `
      <div class="dash-card mb-4">
        <div class="dash-card-header">
          <span class="dash-card-title">Budget estimate</span>
          <span class="dash-card-badge badge-emerald">${days} ${days === 1 ? 'day' : 'days'}</span>
        </div>
        ${rows.map(([label, value]) => `
          <div class="budget-item">
            <span class="budget-label">${e(label)}</span>
            <span class="budget-value">${e(money(value))}</span>
          </div>
        `).join('')}
        <div class="budget-item">
          <span class="budget-label">Estimated total</span>
          <span class="budget-total">${e(money(total))}</span>
        </div>
        <p class="budget-note">Excludes international flights.</p>
      </div>`;
  }

  // Attached once — #tripDetail persists while its contents are re-rendered.
  function wireTripDetail() {
    const detail = $('#tripDetail');

    detail.addEventListener('click', (event) => {
      const header = event.target.closest('[data-day-toggle]');
      if (header) {
        const body = detail.querySelector(`[data-day-body="${header.dataset.dayToggle}"]`);
        if (!body) return;
        body.classList.toggle('d-none');
        header.querySelector('.day-chevron').classList.toggle('open', !body.classList.contains('d-none'));
        return;
      }

      const deleteButton = event.target.closest('#deleteTripBtn');
      if (deleteButton && state.currentTrip) {
        deleteTrip(state.currentTrip.trip.id, state.currentTrip.trip.destination);
        return;
      }

      const regenerateButton = event.target.closest('#regenerateBtn');
      if (regenerateButton) {
        regenerateTrip(regenerateButton);
      }
    });

    detail.addEventListener('keydown', (event) => {
      const header = event.target.closest('[data-day-toggle]');
      if (header && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        header.click();
      }
    });

    detail.addEventListener('change', async (event) => {
      const statusSelect = event.target.closest('#tripStatusSelect');
      if (statusSelect && state.currentTrip) {
        const trip = state.currentTrip.trip;
        const status = statusSelect.value;
        try {
          await api(`/api/trips/${encodeURIComponent(trip.id)}/status`, { method: 'PATCH', body: { status } });
          trip.status = status;
          toast(`Trip marked as ${status}.`, 'success');
        } catch (error) {
          toast(error.message, 'error');
          statusSelect.value = trip.status;
        }
        return;
      }

      const checkbox = event.target.closest('.activity-check');
      if (!checkbox) return;

      checkbox.disabled = true;
      try {
        await api(`/api/trips/activity/${encodeURIComponent(checkbox.dataset.activityId)}/toggle`, { method: 'PATCH' });
        updateTripProgress();
      } catch (error) {
        checkbox.checked = !checkbox.checked;
        toast(error.message, 'error');
      } finally {
        checkbox.disabled = false;
      }
    });
  }

  function updateTripProgress() {
    const boxes = $$('#tripDetail .activity-check');
    const total = boxes.length;
    const done = boxes.filter((box) => box.checked).length;
    const percent = total ? Math.round((done / total) * 100) : 0;

    const bar = $('#tripProgressBar');
    const text = $('#tripProgressText');
    if (bar) bar.style.width = `${percent}%`;
    if (text) text.textContent = `${done} of ${total} activities done`;

    const percentLabel = $('.progress-percent');
    if (percentLabel) percentLabel.textContent = `${percent}%`;
  }

  /* ---------------- Suggestions ---------------- */

  async function loadSuggestions(force) {
    if (!force && state.suggestions && state.suggestions.length) {
      renderSuggestions();
      return;
    }
    if (state.loadingSuggestions) return;

    state.loadingSuggestions = true;
    const grid = $('#suggestionsGrid');
    const empty = $('#suggestionsEmpty');
    const button = $('#suggestBtn');

    empty.classList.add('d-none');
    grid.innerHTML = `
      <div class="col-12">
        <div class="loading-spinner"><div class="spinner"></div><div class="loading-text">Finding places that fit…</div></div>
      </div>`;
    button.disabled = true;

    try {
      const result = await api('/api/trips/suggestions', {
        method: 'POST',
        body: {
          mood: $('#suggestionMood').value,
          groupType: $('#suggestionGroup').value,
          budget: $('#suggestionBudget').value,
          season: $('#suggestionSeason').value
        }
      });

      state.suggestions = (result.data && result.data.suggestions) || [];
      renderSuggestions();

      if (result.success === false) {
        toast('AI is unavailable right now — showing curated picks instead.', 'info');
      }
    } catch (error) {
      state.suggestions = [];
      renderSuggestions();
      toast(error.message, 'error');
    } finally {
      state.loadingSuggestions = false;
      button.disabled = false;
    }
  }

  function renderSuggestions() {
    const grid = $('#suggestionsGrid');
    const empty = $('#suggestionsEmpty');
    const list = state.suggestions || [];

    if (!list.length) {
      grid.innerHTML = '';
      empty.classList.remove('d-none');
      return;
    }

    empty.classList.add('d-none');

    grid.innerHTML = list.map((item) => `
      <div class="col-md-6 col-xxl-4">
        <article class="suggestion-card">
          <div class="suggestion-emoji">${e(item.emoji || '🌍')}</div>
          <div class="suggestion-destination">${e(item.destination)}</div>
          <div class="suggestion-tagline">${e(item.tagline || '')}</div>
          <p class="suggestion-why">${e(item.why || '')}</p>
          <div class="suggestion-tags">
            ${(item.best_for || []).map((tag) => `<span class="suggestion-tag">${e(tag)}</span>`).join('')}
          </div>
          <div class="suggestion-rating">
            <i class="bi bi-star-fill"></i> ${e(item.rating || '—')}
            ${item.budget_range ? `<span class="suggestion-budget">${e(item.budget_range)}</span>` : ''}
          </div>
          <div class="suggestion-actions">
            <button class="btn-glow btn-sm" type="button" data-plan-destination="${e(item.destination)}">
              <i class="bi bi-magic me-1"></i>Plan this trip
            </button>
            <button class="btn-icon" type="button" title="Save to wishlist"
                    data-save-suggestion="${e(item.destination)}">
              <i class="bi bi-bookmark-plus"></i>
            </button>
          </div>
        </article>
      </div>
    `).join('');
  }

  function planFromSuggestion(destination) {
    $('#destination').value = destination;
    window.location.hash = '#plan';
    setTimeout(() => {
      $('#destination').focus();
      $('#destination').select();
    }, 120);
    toast(`Destination set to ${destination}.`, 'info');
  }

  /* ---------------- Saved places ---------------- */

  async function loadSaved() {
    const data = await api('/api/trips/places/saved');
    renderSaved(data.places || []);
  }

  function renderSaved(places) {
    const grid = $('#savedGrid');
    const empty = $('#savedEmpty');
    const badge = $('#savedCount');
    if (badge) badge.textContent = places.length;

    if (!places.length) {
      grid.innerHTML = '';
      empty.classList.remove('d-none');
      return;
    }

    empty.classList.add('d-none');

    const icons = {
      restaurant: 'bi-egg-fried',
      cafe: 'bi-cup-hot',
      sight: 'bi-binoculars',
      museum: 'bi-bank',
      bar: 'bi-cup-straw',
      hotel: 'bi-building',
      nature: 'bi-tree',
      general: 'bi-geo-alt'
    };

    grid.innerHTML = places.map((place) => `
      <article class="saved-card">
        <div class="saved-icon"><i class="bi ${icons[place.category] || icons.general}"></i></div>
        <div class="saved-body">
          <div class="saved-name">${e(place.place_name)}</div>
          <div class="saved-meta">${e([place.country, place.category].filter(Boolean).join(' · '))}</div>
          ${place.description ? `<p class="saved-notes">${e(place.description)}</p>` : ''}
          <div class="saved-date">Saved ${e(formatDate(place.saved_at, { year: 'numeric' }))}</div>
        </div>
        <button class="btn-icon-danger" type="button" title="Remove"
                data-delete-place="${place.id}" data-place-name="${e(place.place_name)}">
          <i class="bi bi-x-lg"></i>
        </button>
      </article>
    `).join('');
  }

  async function savePlace(placeName, country = '', category = 'general', description = '') {
    await api('/api/trips/places/save', {
      method: 'POST',
      body: { placeName, country, category, description }
    });
    toast(`${placeName} saved to your wishlist.`, 'success');
  }

  /* ---------------- Preferences ---------------- */

  async function loadPreferences() {
    const data = await api('/auth/me');
    state.preferences = data.preferences || null;
    const prefs = state.preferences;

    $('#prefClimate').value = (prefs && prefs.preferred_climate) || 'any';
    $('#prefBudget').value = (prefs && prefs.budget_range) || 'medium';
    $('#prefStyle').value = (prefs && prefs.travel_style) || 'balanced';
    $('#prefDiet').value = (prefs && prefs.dietary_restrictions) || '';
    $('#prefAccess').value = (prefs && prefs.accessibility_needs) || '';

    let favorites = [];
    try {
      favorites = prefs && prefs.favorite_activities ? JSON.parse(prefs.favorite_activities) : [];
    } catch (_) {
      favorites = [];
    }
    setSelected($('#prefActivities'), Array.isArray(favorites) ? favorites : []);

    $('#prefSavedAt').textContent = prefs && prefs.updated_at
      ? `Last saved ${formatDate(prefs.updated_at, { year: 'numeric' })}`
      : '';
  }

  /* ---------------- Plan form ---------------- */

  async function handleGenerate(event) {
    event.preventDefault();
    if (state.loadingPlan) return;

    const destination = $('#destination').value.trim();
    const duration = parseInt($('#duration').value, 10);

    if (!destination) {
      toast('Where are you going?', 'error');
      $('#destination').focus();
      return;
    }
    if (!duration || duration < 1 || duration > 30) {
      toast('Duration must be between 1 and 30 days.', 'error');
      $('#duration').focus();
      return;
    }

    const payload = {
      destination,
      duration,
      mood: selectedValues($('#moodChips'))[0] || 'adventurous',
      groupType: $('#groupType').value,
      budget: selectedValues($('#budgetChips'))[0] || 'medium',
      interests: selectedValues($('#interestChips')),
      startDate: $('#startDate').value || null,
      endDate: $('#endDate').value || null,
      notes: $('#notes').value.trim()
    };

    state.loadingPlan = true;
    const button = $('#generateBtn');
    const loading = $('#planLoading');
    const loadingText = $('#planLoadingText');
    const messages = [
      'Researching neighborhoods…',
      'Spreading activities across your days…',
      'Checking opening hours and travel time…',
      'Estimating costs…',
      'Adding local tips…'
    ];
    let step = 0;

    button.disabled = true;
    loading.classList.remove('d-none');
    loadingText.textContent = messages[0];

    const timer = setInterval(() => {
      step = (step + 1) % messages.length;
      loadingText.textContent = messages[step];
    }, 2600);

    try {
      const result = await api('/api/trips/generate', { method: 'POST', body: payload });

      if (result.aiGenerated === false) {
        toast('AI was busy — this is a starter outline. Open the trip and hit Regenerate for real places.', 'info', 8000);
      } else {
        toast('Itinerary ready! 🎉', 'success');
      }

      $('#planForm').reset();
      setSelected($('#moodChips'), ['adventurous']);
      setSelected($('#budgetChips'), ['medium']);
      setSelected($('#interestChips'), []);
      applyPreferencesToPlanForm();

      window.location.hash = `#trip/${encodeURIComponent(result.tripId)}`;
    } catch (error) {
      toast(error.message, 'error', 6000);
    } finally {
      clearInterval(timer);
      state.loadingPlan = false;
      button.disabled = false;
      loading.classList.add('d-none');
    }
  }

  /* ---------------- Wiring ---------------- */

  function wireEvents() {
    wireChips($('#moodChips'), { single: true });
    wireChips($('#budgetChips'), { single: true });
    wireChips($('#interestChips'));
    wireChips($('#prefActivities'));

    $('#sidebarToggle').addEventListener('click', () => {
      $('#sidebar').classList.add('open');
      $('#sidebarOverlay').classList.add('active');
    });
    $('#sidebarOverlay').addEventListener('click', closeSidebar);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeSidebar();
    });

    $('#planForm').addEventListener('submit', handleGenerate);
    wireTripDetail();

    $('#tripSearch').addEventListener('input', (event) => {
      state.filters.search = event.target.value;
      renderTrips();
    });
    $('#tripStatusFilter').addEventListener('change', (event) => {
      state.filters.status = event.target.value;
      renderTrips();
    });

    $('#suggestBtn').addEventListener('click', () => loadSuggestions(true));

    $('#savedForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = $('#placeName').value.trim();
      if (!name) return;

      try {
        await savePlace(
          name,
          $('#placeCountry').value.trim(),
          $('#placeCategory').value,
          $('#placeNotes').value.trim()
        );
        $('#savedForm').reset();
        await loadSaved();
      } catch (error) {
        toast(error.message, 'error');
      }
    });

    $('#prefForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = $('#savePrefsBtn');
      button.disabled = true;

      try {
        await api('/api/trips/preferences', {
          method: 'PUT',
          body: {
            preferred_climate: $('#prefClimate').value,
            budget_range: $('#prefBudget').value,
            travel_style: $('#prefStyle').value,
            dietary_restrictions: $('#prefDiet').value.trim(),
            accessibility_needs: $('#prefAccess').value.trim(),
            favorite_activities: selectedValues($('#prefActivities'))
          }
        });
        state.preferences = { ...(state.preferences || {}), updated_at: new Date().toISOString() };
        toast('Preferences saved.', 'success');
        loadPreferences();
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        button.disabled = false;
      }
    });

    // Delegated actions anywhere in the app
    document.addEventListener('click', async (event) => {
      const planButton = event.target.closest('[data-plan-destination]');
      if (planButton) {
        planFromSuggestion(planButton.dataset.planDestination);
        return;
      }

      const saveButton = event.target.closest('[data-save-suggestion]');
      if (saveButton) {
        const destination = saveButton.dataset.saveSuggestion;
        const [city, ...rest] = destination.split(',');
        try {
          await savePlace(city.trim(), rest.join(',').trim(), 'sight', 'From AI suggestions');
          saveButton.innerHTML = '<i class="bi bi-bookmark-check-fill"></i>';
          saveButton.disabled = true;
        } catch (error) {
          toast(error.message, 'error');
        }
        return;
      }

      const deleteTripButton = event.target.closest('[data-delete-trip]');
      if (deleteTripButton) {
        deleteTrip(deleteTripButton.dataset.deleteTrip, deleteTripButton.dataset.tripName);
        return;
      }

      const deletePlaceButton = event.target.closest('[data-delete-place]');
      if (deletePlaceButton) {
        const id = deletePlaceButton.dataset.deletePlace;
        if (!window.confirm(`Remove ${deletePlaceButton.dataset.placeName} from your wishlist?`)) return;
        try {
          await api(`/api/trips/places/${encodeURIComponent(id)}`, { method: 'DELETE' });
          toast('Place removed.', 'success');
          await loadSaved();
        } catch (error) {
          toast(error.message, 'error');
        }
      }
    });

    window.addEventListener('hashchange', renderRoute);
  }

  async function init() {
    wireEvents();
    try {
      await loadUser();
    } catch (_) {
      return; // api() already redirected to login
    }
    applyPreferencesToPlanForm();
    await renderRoute();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
