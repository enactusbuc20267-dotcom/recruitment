/* ==========================================================================
   ENACTUS BUC — RECRUITMENT DASHBOARD
   Vanilla JS application logic
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * CONFIG
   * ------------------------------------------------------------------ */

  const CONFIG = {
    API_BASE:
      'https://script.google.com/macros/s/AKfycbw_hd9yH5rCiiNzxwztgiqG6xqN2gyzfIlNyf_qxlio80YIp9x9IRzFi3jNHHu7NtVgqg/exec',
    POLL_INTERVAL_MS: 5000,
    STORAGE_KEY_EMAIL: 'enactus_recruit_email',
    COMMITTEES: ['PR', 'HR', 'Media', 'Marketing', 'Project', 'Logistics', 'Presentation'],
  };

  const STATUS = {
    WAITING: 'Waiting',
    IN_PROGRESS: 'In Progress',
    ACCEPTED: 'Accepted',
    REJECTED: 'Rejected',
    MORE_TIME: 'Need More Time',
  };

  /* ------------------------------------------------------------------ *
   * STATE
   * ------------------------------------------------------------------ */

  const state = {
    user: null, // { email, role: 'HR' | 'JOKER', committee, committees }
    applicants: [], // normalized, current view's raw list (HR: single committee)
    jokerApplicants: [], // normalized, flat list across ALL committees (Joker only)
    activeCommittee: null, // Joker's currently selected tab
    filterStatus: 'all',
    searchTerm: '',
    jokerFilterStatus: 'all',
    jokerSearchTerm: '',
    pollTimer: null,
    activeApplicant: null, // applicant currently open in the interview modal
    isBusy: false, // guards double-submits
  };

  /* ------------------------------------------------------------------ *
   * DOM REFS
   * ------------------------------------------------------------------ */

  const $ = (id) => document.getElementById(id);

  const dom = {
    loader: $('global-loader'),
    toastContainer: $('toast-container'),

    loginScreen: $('login-screen'),
    loginForm: $('login-form'),
    emailInput: $('email-input'),
    emailError: $('email-error'),
    loginBtn: $('login-btn'),

    hrDashboard: $('hr-dashboard'),
    hrCommitteeTitle: $('hr-committee-title'),
    hrUserEmail: $('hr-user-email'),
    hrLogoutBtn: $('hr-logout-btn'),
    hrStatsGrid: $('hr-stats-grid'),
    hrSearch: $('hr-search'),
    hrFilterChips: $('hr-filter-chips'),
    hrApplicantsGrid: $('hr-applicants-grid'),
    hrEmptyState: $('hr-empty-state'),

    jokerDashboard: $('joker-dashboard'),
    jokerUserEmail: $('joker-user-email'),
    jokerLogoutBtn: $('joker-logout-btn'),
    committeeSwitcher: $('committee-switcher'),
    jokerStatsGrid: $('joker-stats-grid'),
    liveInterviewsList: $('live-interviews-list'),
    liveEmptyState: $('live-empty-state'),
    jokerSearch: $('joker-search'),
    jokerFilterChips: $('joker-filter-chips'),
    jokerApplicantsGrid: $('joker-applicants-grid'),
    jokerEmptyState: $('joker-empty-state'),

    modalBackdrop: $('interview-modal-backdrop'),
    modalCloseBtn: $('modal-close-btn'),
    modalAvatar: $('modal-avatar'),
    modalName: $('modal-applicant-name'),
    modalStatusBadge: $('modal-status-badge'),
    modalEmail: $('modal-email'),
    modalPhone: $('modal-phone'),
    modalFaculty: $('modal-faculty'),
    modalWhyEnactus: $('modal-why-enactus'),
    modalWhyCommittee: $('modal-why-committee'),
    modalAcceptBtn: $('modal-accept-btn'),
    modalRejectBtn: $('modal-reject-btn'),
    modalNeedTimeBtn: $('modal-need-time-btn'),
  };

  /* ------------------------------------------------------------------ *
   * UTILITIES
   * ------------------------------------------------------------------ */

  function showLoader() { dom.loader.classList.remove('hidden'); }
  function hideLoader() { dom.loader.classList.add('hidden'); }

  function showToast(message, type = 'info', duration = 3800) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span class="toast-dot"></span><span>${escapeHtml(message)}</span>`;
    dom.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('leaving');
      setTimeout(() => toast.remove(), 250);
    }, duration);
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function statusClass(status) {
    return `status-${String(status || 'Waiting').replace(/\s+/g, '-')}`;
  }

  function statColor(status) {
    switch (status) {
      case STATUS.WAITING: return 'var(--status-waiting)';
      case STATUS.IN_PROGRESS: return 'var(--status-progress)';
      case STATUS.ACCEPTED: return 'var(--status-accepted)';
      case STATUS.REJECTED: return 'var(--status-rejected)';
      case STATUS.MORE_TIME: return 'var(--status-more-time)';
      default: return 'var(--accent)';
    }
  }

  function initials(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  function normalizeKey(key) {
    return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /** Find a value in a raw object by trying a list of normalized candidate keys,
   *  falling back to substring matching against every key in the object. */
  function pick(raw, candidates) {
    const lookup = {};
    Object.keys(raw || {}).forEach((k) => { lookup[normalizeKey(k)] = raw[k]; });

    for (const c of candidates) {
      const nc = normalizeKey(c);
      if (lookup[nc] !== undefined && lookup[nc] !== '') return lookup[nc];
    }
    // Fallback: substring match
    for (const c of candidates) {
      const nc = normalizeKey(c);
      for (const k of Object.keys(lookup)) {
        if (k.includes(nc) && lookup[k] !== '') return lookup[k];
      }
    }
    return undefined;
  }

  /** Normalize a raw applicant record (arbitrary Google Sheet column names)
   *  into a consistent shape the UI can rely on. */
  function normalizeApplicant(raw, fallbackCommittee) {
    const rowNumber = pick(raw, ['rowNumber', 'row', 'rowId', 'id']);
    const name = pick(raw, ['name', 'fullName', 'applicantName', 'studentName']) || 'Unnamed Applicant';
    const email = pick(raw, ['email', 'emailAddress']) || '';
    const phone = pick(raw, ['phone', 'phoneNumber', 'mobile', 'mobileNumber', 'contactNumber', 'whatsapp']) || '';
    const faculty = pick(raw, ['faculty', 'college']) || '';
    const level = pick(raw, ['level', 'academicYear', 'year', 'grade']) || '';
    const whyEnactus = pick(raw, [
      'whyEnactus', 'whyDoYouWantToJoinEnactus', 'motivation', 'whyEnactusQuestion',
    ]) || '';
    const whyCommittee = pick(raw, [
      'whyCommittee', 'whyThisCommittee', 'whyDoYouWantToJoinThisCommittee', 'committeeReason',
    ]) || '';
   const status = pick(raw, [
  'status',
  'interviewStatus',
  'interviewstatus'
]) || STATUS.WAITING;
   const claimedBy = pick(raw, [
  'claimedBy',
  'takenBy',
  'interviewedBy',
  'hrName',
  'interviewer',
  'hr',
  'hrEmail',
  'claimedByEmail'
]) || '';
    const committee = pick(raw, ['committee']) || fallbackCommittee || '';

    let facultyDisplay = faculty;
    if (faculty && level) facultyDisplay = `${faculty} — ${level}`;
    else if (!faculty && level) facultyDisplay = String(level);

    return {
      rowNumber: rowNumber !== undefined ? Number(rowNumber) : null,
      name: String(name).trim(),
      email: String(email).trim(),
      phone: String(phone).trim(),
      faculty: String(facultyDisplay || '—').trim(),
      whyEnactus: String(whyEnactus || '—').trim(),
      whyCommittee: String(whyCommittee || '—').trim(),
      status: String(status || STATUS.WAITING).trim() || STATUS.WAITING,
      claimedBy: String(claimedBy || '').trim(),
      committee: String(committee || fallbackCommittee || '').trim(),
      _raw: raw,
    };
  }

  /* ------------------------------------------------------------------ *
   * API LAYER
   * ------------------------------------------------------------------ */

  async function apiGet(params) {
    const url = new URL(CONFIG.API_BASE);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const res = await fetch(url.toString(), { method: 'GET' });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    const data = await res.json();
    return data;
  }

  async function apiPost(body) {
    // Sent as text/plain to keep the request a CORS "simple request" —
    // Google Apps Script web apps do not handle the OPTIONS preflight
    // that a JSON content-type would otherwise trigger.
    const res = await fetch(CONFIG.API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    const data = await res.json();
    return data;
  }

  async function apiGetCommittee(email) {
    return apiGet({ action: 'getCommittee', email });
  }

  async function apiGetApplicants(committee, email) {
    return apiGet({ action: 'getApplicants', committee, email });
  }

  async function apiClaimApplicant(rowNumber, hrEmail) {
    return apiPost({ action: 'claimApplicant', rowNumber, hrEmail });
  }

  async function apiUpdateStatus(rowNumber, status, hrEmail) {
    return apiPost({ action: 'updateStatus', rowNumber, status, hrEmail });
  }

  /** Pull the applicants array out of whatever shape the backend returns. */
  function extractApplicantsArray(response) {
    if (Array.isArray(response)) return response;
    if (Array.isArray(response.applicants)) return response.applicants;
    if (Array.isArray(response.data)) return response.data;
    if (Array.isArray(response.rows)) return response.rows;
    return [];
  }

  /* ------------------------------------------------------------------ *
   * LOGIN FLOW
   * ------------------------------------------------------------------ */

  function setLoginBusy(isBusy) {
    dom.loginBtn.disabled = isBusy;
    dom.loginBtn.querySelector('.btn-label').classList.toggle('hidden', isBusy);
    dom.loginBtn.querySelector('.btn-spinner').classList.toggle('hidden', !isBusy);
  }

  async function handleLogin(email) {
    dom.emailError.textContent = '';
    setLoginBusy(true);
    try {
      const res = await apiGetCommittee(email);

      if (!res || res.success !== true) {
        throw new Error((res && res.message) || 'This email is not registered for the recruitment event.');
      }

      if (res.role === 'HR') {
        state.user = { email, role: 'HR', committee: res.committee };
      } else if (res.role === 'JOKER') {
        state.user = {
          email,
          role: 'JOKER',
          committees: Array.isArray(res.committees) && res.committees.length
            ? res.committees
            : CONFIG.COMMITTEES,
        };
      } else {
        throw new Error('Unrecognized account role. Please contact the recruitment lead.');
      }

      localStorage.setItem(CONFIG.STORAGE_KEY_EMAIL, email);
      enterDashboard();
    } catch (err) {
      dom.emailError.textContent = err.message || 'Something went wrong. Please try again.';
      showToast(err.message || 'Login failed.', 'error');
    } finally {
      setLoginBusy(false);
    }
  }

  function logout() {
    stopPolling();
    state.user = null;
    state.applicants = [];
    state.jokerApplicants = [];
    state.activeCommittee = null;
    localStorage.removeItem(CONFIG.STORAGE_KEY_EMAIL);
    closeModal();
    dom.hrDashboard.classList.add('hidden');
    dom.jokerDashboard.classList.add('hidden');
    dom.loginScreen.classList.remove('hidden');
    dom.emailInput.value = '';
  }

  function enterDashboard() {
    dom.loginScreen.classList.add('hidden');

    if (state.user.role === 'HR') {
      dom.jokerDashboard.classList.add('hidden');
      dom.hrDashboard.classList.remove('hidden');
      dom.hrCommitteeTitle.textContent = `${state.user.committee} Committee`;
      dom.hrUserEmail.textContent = state.user.email;
      refreshHrData(true);
    } else {
      dom.hrDashboard.classList.add('hidden');
      dom.jokerDashboard.classList.remove('hidden');
      dom.jokerUserEmail.textContent = state.user.email;
      state.activeCommittee = state.user.committees[0];
      renderCommitteeSwitcher();
      refreshJokerData(true);
    }

    startPolling();
  }

  /* ------------------------------------------------------------------ *
   * POLLING
   * ------------------------------------------------------------------ */

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(() => {
      if (!state.user) return;
      if (state.user.role === 'HR') refreshHrData(false);
      else refreshJokerData(false);
    }, CONFIG.POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  /* ------------------------------------------------------------------ *
   * HR DASHBOARD
   * ------------------------------------------------------------------ */

  async function refreshHrData(showFullLoader) {
    if (showFullLoader) showLoader();
    try {
      const res = await apiGetApplicants(state.user.committee, state.user.email);
      const rawList = extractApplicantsArray(res);
      state.applicants = rawList.map((r) => normalizeApplicant(r, state.user.committee));
      renderHrStats();
      renderHrApplicants();
      syncActiveModalIfOpen(state.applicants);
    } catch (err) {
      if (showFullLoader) showToast('Could not load applicants. Retrying shortly…', 'error');
    } finally {
      if (showFullLoader) hideLoader();
    }
  }

  function renderHrStats() {
    const counts = computeCounts(state.applicants);
    dom.hrStatsGrid.innerHTML = [
      statCardHtml('Waiting', counts.waiting, STATUS.WAITING),
      statCardHtml('In Progress', counts.inProgress, STATUS.IN_PROGRESS),
      statCardHtml('Accepted', counts.accepted, STATUS.ACCEPTED),
      statCardHtml('Rejected', counts.rejected, STATUS.REJECTED),
    ].join('');
  }

  function renderHrApplicants() {
    const filtered = filterApplicants(state.applicants, state.filterStatus, state.searchTerm);
    renderApplicantsGrid(dom.hrApplicantsGrid, dom.hrEmptyState, filtered, 'HR');
  }

  /* ------------------------------------------------------------------ *
   * JOKER DASHBOARD
   * ------------------------------------------------------------------ */

  function renderCommitteeSwitcher() {
    dom.committeeSwitcher.innerHTML = state.user.committees
      .map(
        (c) => `<button class="committee-tab${c === state.activeCommittee ? ' active' : ''}" data-committee="${escapeHtml(c)}">${escapeHtml(c)}</button>`
      )
      .join('');
  }

  async function refreshJokerData(showFullLoader) {
    if (showFullLoader) showLoader();
    try {
      const results = await Promise.all(
        state.user.committees.map((committee) =>
          apiGetApplicants(committee, state.user.email)
            .then((res) => extractApplicantsArray(res).map((r) => normalizeApplicant(r, committee)))
            .catch(() => [])
        )
      );
      state.jokerApplicants = results.flat();
      renderJokerStats();
      renderLiveInterviews();
      renderJokerApplicants();
      syncActiveModalIfOpen(state.jokerApplicants);
    } catch (err) {
      if (showFullLoader) showToast('Could not load recruitment data. Retrying shortly…', 'error');
    } finally {
      if (showFullLoader) hideLoader();
    }
  }

  function renderJokerStats() {
    const counts = computeCounts(state.jokerApplicants);
    dom.jokerStatsGrid.classList.add('five');
    dom.jokerStatsGrid.innerHTML = [
      statCardHtml('Waiting', counts.waiting, STATUS.WAITING),
      statCardHtml('In Progress', counts.inProgress, STATUS.IN_PROGRESS),
      statCardHtml('Accepted', counts.accepted, STATUS.ACCEPTED),
      statCardHtml('Rejected', counts.rejected, STATUS.REJECTED),
      statCardHtml('Need More Time', counts.moreTime, STATUS.MORE_TIME),
    ].join('');
  }

  function renderLiveInterviews() {
    const active = state.jokerApplicants.filter((a) => a.status === STATUS.IN_PROGRESS);
    dom.liveEmptyState.classList.toggle('hidden', active.length > 0);
    dom.liveInterviewsList.innerHTML = active
      .map(
        (a) => `
        <div class="live-card">
          <div class="live-avatar">${escapeHtml(initials(a.name))}</div>
          <div class="live-info">
            <p class="live-name">${escapeHtml(a.name)} <span style="color:rgba(245,235,197,0.5); font-weight:500;">· ${escapeHtml(a.committee)}</span></p>
            <p class="live-interviewer">Interviewed by: ${escapeHtml(a.claimedBy || 'Unknown HR')}</p>
          </div>
        </div>`
      )
      .join('');
  }

function renderJokerApplicants() {

  console.log("ALL APPLICANTS:", state.jokerApplicants);

  renderApplicantsGrid(
    dom.jokerApplicantsGrid,
    dom.jokerEmptyState,
    state.jokerApplicants,
    'JOKER'
  );

}
  /* ------------------------------------------------------------------ *
   * SHARED RENDER HELPERS
   * ------------------------------------------------------------------ */

  function computeCounts(list) {
    const counts = { waiting: 0, inProgress: 0, accepted: 0, rejected: 0, moreTime: 0 };
    list.forEach((a) => {
      switch (a.status) {
        case STATUS.WAITING: counts.waiting++; break;
        case STATUS.IN_PROGRESS: counts.inProgress++; break;
        case STATUS.ACCEPTED: counts.accepted++; break;
        case STATUS.REJECTED: counts.rejected++; break;
        case STATUS.MORE_TIME: counts.moreTime++; break;
        default: counts.waiting++; break;
      }
    });
    return counts;
  }

  function statCardHtml(label, value, statusKey) {
    return `
      <div class="stat-card glass-card" style="--stat-color:${statColor(statusKey)}">
        <div class="stat-value">${value}</div>
        <div class="stat-label"><span class="stat-dot"></span>${escapeHtml(label)}</div>
      </div>`;
  }

  function filterApplicants(list, statusFilter, searchTerm) {
    const term = (searchTerm || '').trim().toLowerCase();
    return list.filter((a) => {
      const matchesStatus = statusFilter === 'all' || a.status === statusFilter;
      const matchesSearch =
        !term ||
        a.name.toLowerCase().includes(term) ||
        a.email.toLowerCase().includes(term) ||
        a.faculty.toLowerCase().includes(term);
      return matchesStatus && matchesSearch;
    });
  }

  function renderApplicantsGrid(gridEl, emptyStateEl, list, role) {
    emptyStateEl.classList.toggle('hidden', list.length > 0);

    gridEl.innerHTML = list
      .map((a) => {
        const locked = a.status === STATUS.IN_PROGRESS;
        const isDecided = a.status === STATUS.ACCEPTED || a.status === STATUS.REJECTED;
        let buttonHtml = '';

        if (role === 'HR') {
          if (locked) {
            buttonHtml = `<button class="btn btn-card locked" disabled>In progress · ${escapeHtml(a.claimedBy || 'another HR')}</button>`;
          } else if (isDecided) {
            buttonHtml = `<button class="btn btn-card" data-action="view" data-row="${a.rowNumber}">View details</button>`;
          } else {
            buttonHtml = `<button class="btn btn-card" data-action="start" data-row="${a.rowNumber}">Start Interview</button>`;
          }
        } else {
          buttonHtml = `<button class="btn btn-card" data-action="view" data-row="${a.rowNumber}">View details</button>`;
        }

        return `
        <article class="applicant-card${locked ? ' locked' : ''}">
          <div class="applicant-top">
            <div>
              <h3 class="applicant-name">${escapeHtml(a.name)}</h3>
              <p class="applicant-faculty">${escapeHtml(a.faculty)}</p>
            </div>
            <span class="status-badge ${statusClass(a.status)}">${escapeHtml(a.status)}</span>
          </div>
          ${role === 'JOKER' ? `<p class="applicant-meta">${escapeHtml(a.committee)}</p>` : ''}
          ${buttonHtml}
        </article>`;
      })
      .join('');
  }

  /** If the modal is open, refresh its contents with the latest fetched data
   *  (e.g. status may have changed since a poll came back). */
  function syncActiveModalIfOpen(list) {
    if (!state.activeApplicant) return;
    const updated = list.find((a) => a.rowNumber === state.activeApplicant.rowNumber);
    if (updated) {
      state.activeApplicant = updated;
      populateModal(updated);
    }
  }

  /* ------------------------------------------------------------------ *
   * INTERVIEW MODAL
   * ------------------------------------------------------------------ */

  function findApplicantByRow(rowNumber) {
    const pool = state.user.role === 'HR' ? state.applicants : state.jokerApplicants;
    return pool.find((a) => a.rowNumber === rowNumber);
  }

  async function startInterview(rowNumber) {
    if (state.isBusy) return;
    state.isBusy = true;
    showLoader();
    try {
      const res = await apiClaimApplicant(rowNumber, state.user.email);
      if (!res || res.success !== true) {
        throw new Error((res && res.message) || 'This applicant is already being interviewed.');
      }
      showToast('Interview started.', 'success');
      if (state.user.role === 'HR') {
        await refreshHrData(false);
      } else {
        await refreshJokerData(false);
      }
      const applicant = findApplicantByRow(rowNumber);
      if (applicant) openModal(applicant);
    } catch (err) {
      showToast(err.message || 'Could not claim this applicant.', 'error');
    } finally {
      state.isBusy = false;
      hideLoader();
    }
  }

  function viewApplicant(rowNumber) {
    const applicant = findApplicantByRow(rowNumber);
    if (applicant) openModal(applicant);
  }

  function openModal(applicant) {
    state.activeApplicant = applicant;
    populateModal(applicant);
    dom.modalBackdrop.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    dom.modalBackdrop.classList.add('hidden');
    state.activeApplicant = null;
    document.body.style.overflow = '';
  }

  function populateModal(a) {
    dom.modalAvatar.textContent = initials(a.name);
    dom.modalName.textContent = a.name;
    dom.modalStatusBadge.textContent = a.status;
    dom.modalStatusBadge.className = `modal-status-badge ${statusClass(a.status)}`;
    dom.modalEmail.textContent = a.email || '—';
    dom.modalPhone.textContent = a.phone || '—';
    dom.modalFaculty.textContent = a.faculty || '—';
    dom.modalWhyEnactus.textContent = a.whyEnactus || '—';
    dom.modalWhyCommittee.textContent = a.whyCommittee || '—';

    const isDecided = a.status === STATUS.ACCEPTED || a.status === STATUS.REJECTED;
    [dom.modalAcceptBtn, dom.modalRejectBtn, dom.modalNeedTimeBtn].forEach((btn) => {
      btn.disabled = false;
    });
    if (a.status === STATUS.ACCEPTED) dom.modalAcceptBtn.disabled = true;
    if (a.status === STATUS.REJECTED) dom.modalRejectBtn.disabled = true;
  }

  async function submitDecision(status) {
    if (!state.activeApplicant || state.isBusy) return;
    state.isBusy = true;
    showLoader();
    try {
      const res = await apiUpdateStatus(state.activeApplicant.rowNumber, status, state.user.email);
      if (!res || res.success !== true) {
        throw new Error((res && res.message) || 'Could not update this applicant right now.');
      }
      showToast(`Marked as "${status}".`, 'success');
      closeModal();
      if (state.user.role === 'HR') await refreshHrData(false);
      else await refreshJokerData(false);
    } catch (err) {
      showToast(err.message || 'Something went wrong while saving your decision.', 'error');
    } finally {
      state.isBusy = false;
      hideLoader();
    }
  }

  /* ------------------------------------------------------------------ *
   * EVENT WIRING
   * ------------------------------------------------------------------ */

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  dom.loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = dom.emailInput.value.trim();
    if (!isValidEmail(email)) {
      dom.emailError.textContent = 'Please enter a valid email address.';
      return;
    }
    handleLogin(email);
  });

  dom.hrLogoutBtn.addEventListener('click', logout);
  dom.jokerLogoutBtn.addEventListener('click', logout);

  dom.hrSearch.addEventListener('input', (e) => {
    state.searchTerm = e.target.value;
    renderHrApplicants();
  });

  dom.jokerSearch.addEventListener('input', (e) => {
    state.jokerSearchTerm = e.target.value;
    renderJokerApplicants();
  });

  dom.hrFilterChips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    dom.hrFilterChips.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    state.filterStatus = chip.dataset.status;
    renderHrApplicants();
  });

  dom.jokerFilterChips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    dom.jokerFilterChips.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    state.jokerFilterStatus = chip.dataset.status;
    renderJokerApplicants();
  });

  dom.committeeSwitcher.addEventListener('click', (e) => {
    const tab = e.target.closest('.committee-tab');
    if (!tab) return;
    state.activeCommittee = tab.dataset.committee;
    renderCommitteeSwitcher();
    renderJokerApplicants();
  });

  dom.hrApplicantsGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const row = Number(btn.dataset.row);
    if (btn.dataset.action === 'start') startInterview(row);
    else if (btn.dataset.action === 'view') viewApplicant(row);
  });

  dom.jokerApplicantsGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const row = Number(btn.dataset.row);
    viewApplicant(row);
  });

  dom.modalCloseBtn.addEventListener('click', closeModal);
  dom.modalBackdrop.addEventListener('click', (e) => {
    if (e.target === dom.modalBackdrop) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !dom.modalBackdrop.classList.contains('hidden')) closeModal();
  });

  dom.modalAcceptBtn.addEventListener('click', () => submitDecision(STATUS.ACCEPTED));
  dom.modalRejectBtn.addEventListener('click', () => submitDecision(STATUS.REJECTED));
  dom.modalNeedTimeBtn.addEventListener('click', () => submitDecision(STATUS.MORE_TIME));

  /* ------------------------------------------------------------------ *
   * INIT
   * ------------------------------------------------------------------ */

  function init() {
    const savedEmail = localStorage.getItem(CONFIG.STORAGE_KEY_EMAIL);
    if (savedEmail) {
      dom.emailInput.value = savedEmail;
      handleLogin(savedEmail);
    }
  }

  init();
})();
