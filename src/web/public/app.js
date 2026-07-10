(() => {
  'use strict';

  const state = {
    view: 'home',
    commandMode: 'ask',
    commandQuery: '',
    health: null,
    drafts: [],
    draftsLoaded: false,
    activeDraft: null,
    draftCache: new Map(),
    records: [],
    topics: [],
    libraryLoaded: false,
    selectedFile: null,
    selectedNote: null,
    capturePreview: null,
    captureStatus: 'idle',
    captureError: '',
    captureErrorAction: 'preview',
    captureForm: { input: '', kind: '', attribution: '' },
    captureRequestSequence: 0,
    dirty: false,
    pending: false,
    pendingRejectId: null,
    renderSequence: 0,
    lastDrawerFocus: null,
    lastCommandFocus: null,
    lastSafeHash: location.hash || '#home',
  };

  const elements = {
    main: document.getElementById('main-content'),
    commandForm: document.getElementById('command-form'),
    commandInput: document.getElementById('command-input'),
    commandLabel: document.getElementById('command-label'),
    commandHelp: document.getElementById('command-help'),
    commandError: document.getElementById('command-error'),
    commandSubmit: document.getElementById('command-submit'),
    commandResults: document.getElementById('command-results'),
    healthState: document.getElementById('health-state'),
    healthDetail: document.getElementById('health-detail'),
    healthButton: document.getElementById('health-button'),
    inboxCount: document.getElementById('inbox-count'),
    searchButton: document.getElementById('search-button'),
    menuButton: document.getElementById('menu-button'),
    drawer: document.getElementById('navigation-drawer'),
    backdrop: document.getElementById('drawer-backdrop'),
    commandBackdrop: document.getElementById('command-backdrop'),
    themeButton: document.getElementById('theme-button'),
    drawerThemeButton: document.getElementById('drawer-theme-button'),
    live: document.getElementById('live-region'),
    rejectDialog: document.getElementById('reject-dialog'),
    rejectForm: document.getElementById('reject-form'),
    rejectReason: document.getElementById('reject-reason'),
    masthead: document.querySelector('.masthead'),
    commandBand: document.querySelector('.command-band'),
    workspace: document.querySelector('.workspace'),
    mobileTabs: document.querySelector('.mobile-tab-bar'),
  };

  class RequestError extends Error {
    constructor(message, status, data) {
      super(message);
      this.status = status;
      this.data = data;
    }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character]);
  }

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function objectValue(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function announce(message) {
    elements.live.textContent = '';
    window.setTimeout(() => {
      elements.live.textContent = message;
    }, 20);
  }

  function formatDate(value, includeTime = false) {
    if (!value) return 'Date not reported';
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return String(value);
    return new Intl.DateTimeFormat(undefined, includeTime
      ? { dateStyle: 'medium', timeStyle: 'short' }
      : { dateStyle: 'medium' }).format(date);
  }

  function formatNumber(value) {
    return new Intl.NumberFormat().format(Number(value) || 0);
  }

  function plainInlineText(value) {
    return String(value ?? '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/([*_~`])([^\n]*?)\1/g, '$2')
      .trim();
  }

  function titleFromFile(file) {
    const base = String(file || '').split('/').pop() || 'Untitled record';
    return base.replace(/\.md$/i, '').replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/[-_]+/g, ' ');
  }

  function requestPath(file) {
    return String(file).split('/').map(encodeURIComponent).join('/');
  }

  async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, { ...options, headers });
    let data;
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (!response.ok) {
      throw new RequestError(data.message || `Request failed with status ${response.status}.`, response.status, data);
    }
    return data;
  }

  function loadingMarkup(label = 'Loading Chronicle') {
    return `
      <section class="view-loading" aria-label="${escapeHtml(label)}">
        <div class="skeleton skeleton-title"></div>
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton skeleton-panel"></div>
      </section>`;
  }

  function stateMarkup(kind, title, message, action = '') {
    const noticeClass = kind === 'error' ? ' notice-error' : kind === 'success' ? ' notice-success' : '';
    return `
      <section class="state-panel${noticeClass}"${kind === 'error' ? ' role="alert"' : ''}>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(message)}</p>
        ${action ? `<div class="state-actions">${action}</div>` : ''}
      </section>`;
  }

  function setMain(markup, busy = false) {
    elements.main.innerHTML = markup;
    elements.main.setAttribute('aria-busy', String(busy));
  }

  function focusMain(scroll = true) {
    elements.main.focus({ preventScroll: true });
    if (scroll && window.matchMedia('(max-width: 48rem)').matches) {
      elements.main.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
  }

  function setActiveNavigation(view) {
    const activeView = view === 'digest' || view === 'home'
      ? 'home'
      : view === 'records' || view === 'topics' || view === 'library'
        ? 'library'
        : view;
    document.querySelectorAll('[data-view-link]').forEach((item) => {
      const active = item.dataset.viewLink === activeView;
      item.classList.toggle('is-active', active);
      if (item.classList.contains('nav-item')) {
        if (active) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
      }
    });
  }

  function openDrawer() {
    if (!elements.drawer || elements.drawer.classList.contains('is-open')) return;
    closeCommand(false);
    state.lastDrawerFocus = document.activeElement;
    elements.drawer.classList.add('is-open');
    elements.backdrop.hidden = false;
    requestAnimationFrame(() => elements.backdrop.classList.add('is-open'));
    elements.menuButton.setAttribute('aria-expanded', 'true');
    elements.drawer.setAttribute('role', 'dialog');
    elements.drawer.setAttribute('aria-modal', 'true');
    elements.masthead.inert = true;
    elements.commandBand.inert = true;
    elements.main.inert = true;
    document.body.style.overflow = 'hidden';
    elements.drawer.querySelector('button')?.focus();
  }

  function closeDrawer(restoreFocus = false) {
    if (!elements.drawer) return;
    elements.drawer.classList.remove('is-open');
    elements.backdrop.classList.remove('is-open');
    elements.menuButton.setAttribute('aria-expanded', 'false');
    elements.drawer.removeAttribute('role');
    elements.drawer.removeAttribute('aria-modal');
    elements.masthead.inert = false;
    elements.commandBand.inert = false;
    elements.main.inert = false;
    document.body.style.overflow = '';
    window.setTimeout(() => {
      elements.backdrop.hidden = true;
    }, 200);
    if (restoreFocus && state.lastDrawerFocus instanceof HTMLElement) state.lastDrawerFocus.focus();
  }

  function trapDrawerFocus(event) {
    if (event.key !== 'Tab' || !elements.drawer.classList.contains('is-open')) return;
    const focusable = [...elements.drawer.querySelectorAll('button, a[href], input, select, textarea')]
      .filter((item) => !item.disabled && item.getClientRects().length);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function trapCommandFocus(event) {
    if (event.key !== 'Tab' || !elements.commandBand.classList.contains('is-open')) return;
    const focusable = [...elements.commandBand.querySelectorAll('button, input, select, textarea, a[href]')]
      .filter((item) => !item.disabled && item.getClientRects().length);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const themeModes = ['system', 'light', 'dark'];

  function applyTheme(mode) {
    const selected = themeModes.includes(mode) ? mode : 'system';
    if (selected === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', selected);
    [elements.themeButton, elements.drawerThemeButton].forEach((button) => {
      button.textContent = `Theme: ${selected}`;
      button.setAttribute('aria-label', `Color theme is ${selected}. Change theme.`);
    });
    try {
      localStorage.setItem('chronicle-theme', selected);
    } catch {
      // The theme still works for this page when storage is unavailable.
    }
  }

  function cycleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'system';
    const next = themeModes[(themeModes.indexOf(current) + 1) % themeModes.length];
    applyTheme(next);
    announce(`Color theme changed to ${next}.`);
  }

  function setCommandMode(mode, focus = false) {
    state.commandMode = mode === 'find' ? 'find' : 'ask';
    document.querySelectorAll('[data-command-mode]').forEach((button) => {
      const active = button.dataset.commandMode === state.commandMode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const asking = state.commandMode === 'ask';
    elements.commandLabel.textContent = asking ? 'Ask the approved archive' : 'Find exact records and excerpts';
    elements.commandInput.placeholder = asking
      ? 'What did we decide about storage?'
      : 'Search records, topics, and exact phrases';
    elements.commandHelp.textContent = asking
      ? 'Answers cite retrieved excerpts. Chronicle abstains when evidence is weak.'
      : 'Find returns matching approved excerpts without generating an answer.';
    elements.commandSubmit.textContent = asking ? 'Answer' : 'Search';
    elements.commandError.hidden = true;
    if (focus) {
      elements.commandInput.focus();
      elements.commandInput.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
  }

  function openCommand(mode = 'find') {
    if (!elements.commandBand || !elements.commandBackdrop) return;
    closeDrawer(false);
    state.lastCommandFocus = document.activeElement;
    setCommandMode(mode);
    elements.commandBand.hidden = false;
    elements.commandBackdrop.hidden = false;
    elements.masthead.inert = true;
    elements.workspace.inert = true;
    if (elements.mobileTabs) elements.mobileTabs.inert = true;
    requestAnimationFrame(() => {
      elements.commandBand.classList.add('is-open');
      elements.commandBackdrop.classList.add('is-open');
    });
    document.body.classList.add('command-open');
    window.setTimeout(() => elements.commandInput.focus(), 40);
  }

  function closeCommand(restoreFocus = true) {
    if (!elements.commandBand || !elements.commandBackdrop || elements.commandBand.hidden) return;
    elements.commandBand.classList.remove('is-open');
    elements.commandBackdrop.classList.remove('is-open');
    document.body.classList.remove('command-open');
    elements.masthead.inert = false;
    elements.workspace.inert = false;
    if (elements.mobileTabs) elements.mobileTabs.inert = false;
    window.setTimeout(() => {
      elements.commandBand.hidden = true;
      elements.commandBackdrop.hidden = true;
    }, 180);
    if (restoreFocus && state.lastCommandFocus instanceof HTMLElement) {
      state.lastCommandFocus.focus();
    }
  }

  function closeCommandResults() {
    elements.commandResults.hidden = true;
    elements.commandResults.innerHTML = '';
    closeCommand();
  }

  let evidenceHeadingSequence = 0;

  function evidenceListMarkup(items) {
    const evidence = safeArray(items);
    if (!evidence.length) {
      return `<div class="state-panel"><h2>No evidence returned</h2><p>Chronicle did not attach a source excerpt.</p></div>`;
    }
    return `<ol class="evidence-list">
      ${evidence.map((item) => {
        const file = item.file || item.path || item.source || '';
        const excerpt = item.excerpt || item.text || item.chunk || '';
        const validated = item.validated === true || item.citationValidated === true;
        return `
          <li class="evidence-item">
            <blockquote>${escapeHtml(excerpt || 'Excerpt not available.')}</blockquote>
            <div class="source-path">${escapeHtml(item.title || titleFromFile(file))}</div>
            <div class="revision-note">${validated ? 'Citation validated' : 'Retrieved excerpt'}</div>
            ${file ? `<button class="button button-text evidence-link" type="button" data-note-file="${escapeHtml(file)}">Open source</button>` : ''}
          </li>`;
      }).join('')}
    </ol>`;
  }

  function evidenceMarkup(items, heading = 'Evidence') {
    const headingId = `evidence-heading-${++evidenceHeadingSequence}`;
    return `
      <section class="answer-evidence" aria-labelledby="${headingId}">
        <h3 id="${headingId}">${escapeHtml(heading)}</h3>
        ${evidenceListMarkup(items)}
      </section>`;
  }

  async function runCommand(query = elements.commandInput.value.trim()) {
    if (!query) {
      elements.commandError.textContent = state.commandMode === 'ask' ? 'Enter a question.' : 'Enter a search term.';
      elements.commandError.hidden = false;
      elements.commandInput.focus();
      return;
    }
    state.commandQuery = query;
    elements.commandError.hidden = true;
    elements.commandSubmit.disabled = true;
    document.querySelectorAll('[data-command-mode]').forEach((button) => {
      button.disabled = true;
    });
    elements.commandResults.hidden = false;
    elements.commandResults.innerHTML = loadingMarkup(state.commandMode === 'ask' ? 'Consulting approved memory' : 'Searching approved memory');
    announce(state.commandMode === 'ask' ? 'Consulting approved memory.' : 'Searching approved memory.');

    try {
      if (state.commandMode === 'ask') {
        const data = await api('/api/recall', {
          method: 'POST',
          body: JSON.stringify({ question: query }),
        });
        if (data.status === 'insufficient_evidence') {
          elements.commandResults.innerHTML = `
            <div class="command-results-header">
              <div><h2>Not enough evidence</h2><p class="field-help">${escapeHtml(data.message || 'Chronicle cannot support an answer from approved memory.')}</p></div>
              <button class="button button-text" type="button" data-close-command>Close</button>
            </div>
            ${safeArray(data.evidence).length ? evidenceMarkup(data.evidence, 'Closest retrieved excerpts') : ''}`;
          announce('Chronicle found insufficient evidence to answer.');
        } else {
          elements.commandResults.innerHTML = `
            <div class="command-results-header">
              <div><h2>Answer</h2><p class="field-help">Grounded in approved records</p></div>
              <button class="button button-text" type="button" data-close-command>Close</button>
            </div>
            <div class="answer-layout">
              <article class="answer-copy">${data.answerHtml || `<p>${escapeHtml(data.answer)}</p>`}</article>
              ${evidenceMarkup(data.evidence)}
            </div>`;
          announce(`Answer ready with ${safeArray(data.evidence).length} evidence excerpt${safeArray(data.evidence).length === 1 ? '' : 's'}.`);
        }
      } else {
        const data = await api(`/api/search?q=${encodeURIComponent(query)}`);
        const hits = safeArray(data.hits);
        elements.commandResults.innerHTML = `
          <div class="command-results-header">
            <div><h2>${hits.length ? `${formatNumber(hits.length)} result${hits.length === 1 ? '' : 's'}` : 'No exact matches'}</h2>
            <p class="field-help">For ${escapeHtml(query)}</p></div>
            <button class="button button-text" type="button" data-close-command>Close</button>
          </div>
          ${hits.length ? `<div class="search-results">${hits.map((hit) => `
            <button class="record-item" type="button" data-note-file="${escapeHtml(hit.file)}">
              <span class="search-hit-title">${escapeHtml(hit.noteTitle || titleFromFile(hit.file))}</span>
              <span class="search-hit-text">${escapeHtml(hit.text || 'Matching excerpt')}</span>
              <span class="source-path">${escapeHtml(hit.file)}</span>
            </button>`).join('')}</div>` : stateMarkup('empty', 'Try a more specific phrase', 'Find searches approved indexed excerpts. Check Trust if the index is not ready.')}`;
        announce(hits.length ? `${hits.length} search results ready.` : 'No search results found.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The command failed.';
      elements.commandResults.innerHTML = `
        <div class="command-results-header">
          <div><h2>Command failed</h2><p class="field-help">Your query is still in the command bar.</p></div>
          <button class="button button-text" type="button" data-close-command>Close</button>
        </div>
        ${stateMarkup('error', 'Could not reach the archive', message, '<button class="button button-secondary" type="button" data-command-retry>Retry</button>')}`;
      announce('The archive command failed.');
    } finally {
      elements.commandSubmit.disabled = false;
      document.querySelectorAll('[data-command-mode]').forEach((button) => {
        button.disabled = false;
      });
      elements.commandSubmit.textContent = state.commandMode === 'ask' ? 'Answer' : 'Search';
    }
  }

  function normaliseDraft(value) {
    const outer = objectValue(value);
    const raw = objectValue(outer.draft || outer);
    const summary = objectValue(raw.summary);
    const meta = objectValue(raw.meta);
    const actions = safeArray(summary.action_items || summary.actionItems).map((item) => {
      if (typeof item === 'string') return { owner: '', task: item };
      const action = objectValue(item);
      return { owner: String(action.owner || ''), task: String(action.task || action.text || '') };
    });
    const facts = safeArray(summary.facts).map((item) => {
      if (typeof item === 'string') return { topic: '', fact: item };
      const fact = objectValue(item);
      return {
        topic: String(fact.topic || fact.topic_title || ''),
        topic_title: String(fact.topic_title || fact.topic || ''),
        topic_description: String(fact.topic_description || fact.topic_title || fact.topic || ''),
        fact: String(fact.fact || fact.text || ''),
      };
    });
    const evidence = safeArray(raw.evidence || summary.evidence);
    return {
      raw,
      id: String(raw.id || raw.recordId || ''),
      revision: raw.revision,
      status: String(raw.status || 'needs_review'),
      title: String(raw.title || summary.title || 'Untitled capture'),
      date: String(raw.date || meta.date || raw.createdAt || ''),
      kind: String(raw.kind || meta.kind || 'source'),
      origin: String(meta.origin || raw.origin || 'Origin not reported'),
      attribution: safeArray(meta.attribution || raw.attribution).map(String),
      durationMinutes: meta.durationMinutes || raw.durationMinutes,
      summary: String(summary.summary || raw.description || ''),
      decisions: safeArray(summary.decisions).map(String),
      actions,
      questions: safeArray(summary.open_questions || summary.openQuestions).map(String),
      facts,
      warnings: safeArray(raw.warnings).map(String),
      evidence,
      rawPath: String(objectValue(raw.rawCapture).relativePath || raw.rawPath || ''),
      createdAt: String(raw.createdAt || ''),
      updatedAt: String(raw.updatedAt || ''),
    };
  }

  async function ensureDrafts(force = false) {
    if (state.draftsLoaded && !force) return;
    const data = await api('/api/reviews');
    state.drafts = safeArray(data.drafts).map(normaliseDraft);
    state.draftsLoaded = true;
    elements.inboxCount.textContent = String(state.drafts.length);
    elements.inboxCount.setAttribute('aria-label', `${state.drafts.length} draft${state.drafts.length === 1 ? '' : 's'} awaiting review`);
  }

  async function loadDraft(id, force = false) {
    if (!force && state.draftCache.has(id)) return state.draftCache.get(id);
    const data = await api(`/api/reviews/${encodeURIComponent(id)}`);
    const draft = normaliseDraft(data);
    state.draftCache.set(id, draft);
    return draft;
  }

  function queueMarkup(drafts, activeId) {
    return `
      <aside class="review-queue" aria-label="Review queue">
        <p class="queue-heading">${drafts.length} awaiting review</p>
        <ol class="queue-list">
          ${drafts.map((draft) => `
            <li>
              <button class="queue-item${draft.id === activeId ? ' is-active' : ''}" type="button" data-draft-id="${escapeHtml(draft.id)}"${draft.id === activeId ? ' aria-current="true"' : ''}>
                <span class="queue-item-title">${escapeHtml(draft.title)}</span>
                <span class="queue-item-meta">${escapeHtml(draft.kind)} | ${escapeHtml(formatDate(draft.date))}${draft.warnings.length ? ` | ${draft.warnings.length} warning${draft.warnings.length === 1 ? '' : 's'}` : ''}</span>
              </button>
            </li>`).join('')}
        </ol>
      </aside>`;
  }

  function lines(value) {
    return safeArray(value).join('\n');
  }

  function draftEvidenceMarkup(draft) {
    const headingId = `draft-evidence-heading-${++evidenceHeadingSequence}`;
    return `
      <aside class="evidence-panel" aria-labelledby="${headingId}">
        <h3 id="${headingId}">Source evidence</h3>
        ${draft.evidence.length ? evidenceListMarkup(draft.evidence) : '<p class="field-help">No structured evidence excerpts were attached.</p>'}
        <p class="field-help">Review the raw capture before approving extracted claims.</p>
        ${draft.rawPath
          ? `<button class="button button-text evidence-link" type="button" data-note-file="${escapeHtml(draft.rawPath)}">Open raw capture</button>`
          : '<p class="field-help">Raw capture path was not reported.</p>'}
        <p class="source-path">${escapeHtml(draft.origin)}</p>
      </aside>`;
  }

  function editorMarkup(draft) {
    const actionLines = draft.actions.map((item) => `${item.owner} | ${item.task}`);
    const factLines = draft.facts.map((item) => `${item.topic} | ${item.fact}`);
    return `
      <section class="review-editor">
        <button class="button button-text back-button" type="button" data-back-to-queue>Back to review</button>
        <article class="review-surface">
          <header class="review-header">
            <div>
              <span class="state-label">AI draft. Not approved memory.</span>
              <h2>${escapeHtml(draft.title)}</h2>
              <p class="meta-line">Revision ${escapeHtml(draft.revision ?? 'not reported')}</p>
            </div>
          </header>

          <dl class="source-context">
            <div class="context-item"><dt>Source</dt><dd>${escapeHtml(draft.kind)}</dd></div>
            <div class="context-item"><dt>Captured</dt><dd>${escapeHtml(formatDate(draft.date))}</dd></div>
            <div class="context-item"><dt>Attribution</dt><dd>${escapeHtml(draft.attribution.join(', ') || 'Not reported')}</dd></div>
          </dl>

          ${draft.warnings.length ? `
            <section class="warnings" aria-labelledby="warnings-title">
              <h3 id="warnings-title">Review warnings</h3>
              <ul>${draft.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>
            </section>` : ''}

          <form id="review-form" data-review-id="${escapeHtml(draft.id)}">
            <div class="review-focus-grid">
              <div class="review-read">
                <section class="memory-summary" aria-labelledby="draft-summary-heading">
                  <h3 id="draft-summary-heading">What Chronicle understood</h3>
                  <p>${escapeHtml(draft.summary || 'No summary was extracted.')}</p>
                </section>
                <div class="extraction-grid">
                  ${summaryListMarkup('Decisions', draft.decisions)}
                  ${summaryListMarkup('Action items', draft.actions)}
                  ${summaryListMarkup('Open questions', draft.questions)}
                  ${topicFactsMarkup(draft.facts)}
                </div>
              </div>
              ${draftEvidenceMarkup(draft)}
            </div>

            <details class="edit-draft">
              <summary>Edit extracted memory</summary>
              <p class="field-help">Open the fields only when Chronicle misunderstood something.</p>
              <div class="review-fields">
                <div class="field">
                  <label for="draft-title">Record title</label>
                  <input id="draft-title" name="title" value="${escapeHtml(draft.title)}" required />
                </div>
                <div class="field">
                  <label for="draft-summary">Summary</label>
                  <textarea id="draft-summary" name="summary" rows="5">${escapeHtml(draft.summary)}</textarea>
                  <p class="field-help">Use plain factual language. This becomes the approved record summary.</p>
                </div>
                <div class="field">
                  <label for="draft-decisions">Decisions</label>
                  <textarea id="draft-decisions" name="decisions" rows="3" placeholder="One decision per line">${escapeHtml(lines(draft.decisions))}</textarea>
                </div>
                <div class="field">
                  <label for="draft-actions">Action items</label>
                  <textarea id="draft-actions" name="actions" rows="3" placeholder="Owner | Task" aria-describedby="draft-actions-help draft-actions-error">${escapeHtml(lines(actionLines))}</textarea>
                  <p class="field-help" id="draft-actions-help">Use one action per line in the format Owner | Task.</p>
                  <p class="field-error" id="draft-actions-error" role="alert" hidden></p>
                </div>
                <details class="advanced-fields">
                  <summary>More extracted fields</summary>
                  <div class="advanced-fields-inner">
                    <div class="field">
                      <label for="draft-questions">Open questions</label>
                      <textarea id="draft-questions" name="questions" rows="3" placeholder="One question per line">${escapeHtml(lines(draft.questions))}</textarea>
                    </div>
                    <div class="field">
                      <label for="draft-facts">Topic facts</label>
                      <textarea id="draft-facts" name="facts" rows="5" placeholder="Topic | Fact" aria-describedby="draft-facts-help draft-facts-error">${escapeHtml(lines(factLines))}</textarea>
                      <p class="field-help" id="draft-facts-help">Each approved fact updates its topic page.</p>
                      <p class="field-error" id="draft-facts-error" role="alert" hidden></p>
                    </div>
                  </div>
                </details>
              </div>
            </details>

            <div class="review-actions">
              <span class="dirty-status" id="dirty-status">No unsaved edits</span>
              <button class="button button-text" type="button" data-reject-draft="${escapeHtml(draft.id)}">Reject</button>
              <button class="button button-secondary" type="submit" data-save-draft>Save changes</button>
              <button class="button button-primary" type="button" data-approve-draft="${escapeHtml(draft.id)}">Approve</button>
            </div>
          </form>
        </article>
      </section>`;
  }

  async function renderInbox(options = {}) {
    const sequence = ++state.renderSequence;
    setActiveNavigation('inbox');
    state.view = 'inbox';
    setMain(loadingMarkup('Loading review inbox'), true);
    try {
      await ensureDrafts(Boolean(options.force));
      if (sequence !== state.renderSequence) return;
      if (!state.drafts.length) {
        state.activeDraft = null;
        setMain(`
          <header class="view-header"><h1>Review</h1><p>Everything is handled. Add a source when you want Chronicle to remember something new.</p></header>
          ${stateMarkup('empty', 'Nothing needs review', 'Approved memory is ready whenever you need it.', '<button class="button button-primary" type="button" data-view-link="capture">Add source</button>')}`);
        return;
      }

      const requestedId = options.id || state.activeDraft?.id;
      const shouldSelectFirst = !requestedId && !window.matchMedia('(max-width: 48rem)').matches;
      const activeId = requestedId || (shouldSelectFirst ? state.drafts[0].id : '');
      if (activeId) state.activeDraft = await loadDraft(activeId, Boolean(options.force));
      if (sequence !== state.renderSequence) return;
      state.dirty = false;
      setMain(`
        <header class="view-header"><h1>Review</h1><p>Read what Chronicle understood, check the evidence, then approve or correct it.</p></header>
        <div class="review-layout${state.activeDraft ? ' has-selection' : ''}">
          ${queueMarkup(state.drafts, state.activeDraft?.id)}
          ${state.activeDraft ? editorMarkup(state.activeDraft) : stateMarkup('empty', 'Choose a draft', 'Open the next capture to inspect its evidence and extraction.')}
        </div>`);
    } catch (error) {
      if (sequence !== state.renderSequence) return;
      const unavailable = error instanceof RequestError && error.status === 501;
      setMain(`
        <header class="view-header"><h1>Review</h1><p>Captured sources stay separate from approved memory.</p></header>
        ${unavailable
          ? `<div class="notice"><strong>Partial setup.</strong> Archive reading still works, but this build does not expose the review workflow.</div>${stateMarkup('error', 'Review is not available', error.message, '<button class="button button-secondary" type="button" data-retry-view="inbox">Check again</button>')}`
          : stateMarkup('error', 'Could not load the inbox', error.message || 'The review queue could not be read.', '<button class="button button-secondary" type="button" data-retry-view="inbox">Retry</button>')}`);
      elements.inboxCount.textContent = '?';
    } finally {
      elements.main.setAttribute('aria-busy', 'false');
    }
  }

  function splitLine(value) {
    return String(value || '').split('\n').map((item) => item.trim()).filter(Boolean);
  }

  class ReviewValidationError extends Error {}

  function clearReviewFieldError(fieldId) {
    const field = document.getElementById(fieldId);
    const error = document.getElementById(`${fieldId}-error`);
    field?.removeAttribute('aria-invalid');
    if (error) {
      error.hidden = true;
      error.textContent = '';
    }
  }

  function parsePairLines(value, fieldId, formatLabel) {
    clearReviewFieldError(fieldId);
    const parsed = [];
    const invalidLines = [];
    String(value || '').split('\n').forEach((rawLine, index) => {
      const line = rawLine.trim();
      if (!line) return;
      const separator = line.indexOf('|');
      const left = separator >= 0 ? line.slice(0, separator).trim() : '';
      const right = separator >= 0 ? line.slice(separator + 1).trim() : '';
      if (!left || !right) invalidLines.push(index + 1);
      else parsed.push([left, right]);
    });
    if (invalidLines.length) {
      const message = `${formatLabel} required on line${invalidLines.length === 1 ? '' : 's'} ${invalidLines.join(', ')}.`;
      const field = document.getElementById(fieldId);
      const error = document.getElementById(`${fieldId}-error`);
      field?.setAttribute('aria-invalid', 'true');
      if (error) {
        error.textContent = message;
        error.hidden = false;
      }
      field?.focus();
      throw new ReviewValidationError(message);
    }
    return parsed;
  }

  function reviewPatch() {
    const form = document.getElementById('review-form');
    if (!(form instanceof HTMLFormElement)) throw new Error('Review form is not available.');
    if (!form.reportValidity()) throw new ReviewValidationError('Complete the required review fields.');
    const data = new FormData(form);
    const actions = parsePairLines(data.get('actions'), 'draft-actions', 'Use Owner | Task')
      .map(([owner, task]) => ({ owner, task }));
    const facts = parsePairLines(data.get('facts'), 'draft-facts', 'Use Topic | Fact')
      .map(([topic, fact]) => ({ topic, topic_title: topic, topic_description: topic, fact }));
    return {
      summary: {
        title: String(data.get('title') || '').trim(),
        summary: String(data.get('summary') || '').trim(),
        decisions: splitLine(data.get('decisions')),
        action_items: actions,
        open_questions: splitLine(data.get('questions')),
        facts,
      },
    };
  }

  function setReviewPending(pending, label = '') {
    state.pending = pending;
    document.querySelectorAll('#review-form button, #review-form input, #review-form textarea').forEach((control) => {
      control.disabled = pending;
    });
    const status = document.getElementById('dirty-status');
    if (status && label) status.textContent = label;
  }

  async function saveDraft(id, announceSave = true) {
    const draft = state.activeDraft;
    if (!draft || draft.id !== id) return null;
    let patch;
    try {
      patch = reviewPatch();
    } catch (error) {
      const status = document.getElementById('dirty-status');
      if (status) status.textContent = 'Fix the highlighted review lines before saving.';
      announce(error instanceof Error ? error.message : 'Fix the highlighted review lines.');
      if (error instanceof ReviewValidationError) return null;
      throw error;
    }
    setReviewPending(true, 'Saving edits...');
    try {
      const data = await api(`/api/reviews/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: draft.revision !== undefined ? { 'If-Match': String(draft.revision) } : {},
        body: JSON.stringify({ patch, expectedRevision: draft.revision }),
      });
      const updated = normaliseDraft(data);
      state.activeDraft = updated;
      state.draftCache.set(id, updated);
      state.dirty = false;
      await ensureDrafts(true);
      const status = document.getElementById('dirty-status');
      if (status) status.textContent = `Saved revision ${updated.revision ?? ''}`.trim();
      if (announceSave) announce('Draft edits saved.');
      return updated;
    } catch (error) {
      const status = document.getElementById('dirty-status');
      if (status) status.textContent = error instanceof RequestError && error.status === 409
        ? 'Revision conflict. Your edits remain in this form.'
        : 'Save failed. Your edits remain in this form.';
      announce('Draft save failed. Your edits remain in the form.');
      throw error;
    } finally {
      setReviewPending(false);
    }
  }

  async function approveDraft(id) {
    if (state.pending) return;
    try {
      let draft = state.activeDraft;
      if (state.dirty) draft = await saveDraft(id, false);
      if (!draft) return;
      setReviewPending(true, 'Approving memory...');
      await api(`/api/reviews/${encodeURIComponent(id)}/approve`, {
        method: 'POST',
        headers: draft.revision !== undefined ? { 'If-Match': String(draft.revision) } : {},
        body: JSON.stringify({ expectedRevision: draft.revision }),
      });
      state.draftCache.delete(id);
      state.activeDraft = null;
      state.draftsLoaded = false;
      state.libraryLoaded = false;
      announce('Draft approved and added to memory.');
      await renderInbox({ force: true });
    } catch (error) {
      setReviewPending(false, 'Approval failed. Your edits are preserved.');
      announce(error instanceof Error ? `Approval failed. ${error.message}` : 'Approval failed.');
    }
  }

  function openRejectDialog(id) {
    state.pendingRejectId = id;
    elements.rejectReason.value = '';
    elements.rejectDialog.showModal();
    window.setTimeout(() => elements.rejectReason.focus(), 20);
  }

  async function rejectDraft(id, reason) {
    const draft = state.activeDraft;
    if (!draft || draft.id !== id) return;
    setReviewPending(true, 'Rejecting draft...');
    try {
      await api(`/api/reviews/${encodeURIComponent(id)}/reject`, {
        method: 'POST',
        headers: draft.revision !== undefined ? { 'If-Match': String(draft.revision) } : {},
        body: JSON.stringify({ expectedRevision: draft.revision, reason }),
      });
      state.draftCache.delete(id);
      state.activeDraft = null;
      state.draftsLoaded = false;
      announce('Draft rejected. It was not added to memory.');
      await renderInbox({ force: true });
    } catch (error) {
      setReviewPending(false, 'Rejection failed. The draft remains in review.');
      announce(error instanceof Error ? `Rejection failed. ${error.message}` : 'Rejection failed.');
    }
  }

  function summaryListMarkup(title, items) {
    const values = safeArray(items);
    if (!values.length) return '';
    return `<section><h3>${escapeHtml(title)}</h3><ul>${values.map((item) => {
      if (typeof item === 'string') return `<li>${escapeHtml(item)}</li>`;
      const record = objectValue(item);
      const text = record.owner && record.task
        ? `${record.owner}: ${record.task}`
        : record.task || record.fact || '';
      return `<li>${escapeHtml(text)}</li>`;
    }).join('')}</ul></section>`;
  }

  function topicFactsMarkup(items) {
    const facts = safeArray(items);
    if (!facts.length) return '';
    return `<section><h3>Topic facts</h3><ul>${facts.map((item) => {
      const fact = objectValue(item);
      return `<li><strong>${escapeHtml(fact.topic_title || fact.topic || 'Topic')}:</strong> ${escapeHtml(fact.fact || '')}</li>`;
    }).join('')}</ul></section>`;
  }

  function captureFormMarkup() {
    return `
      <form id="capture-form" class="review-surface">
        <div class="review-fields">
          <div class="field">
            <label for="capture-input">URL or local path</label>
            <input id="capture-input" name="input" required value="${escapeHtml(state.captureForm.input)}" placeholder="https://example.com/article or /path/to/file.pdf" />
            <p class="field-help">Preview does not write to the knowledge base. Local paths require WEB_INGEST_ROOT.</p>
          </div>
          <div class="field">
            <label for="capture-kind">Source kind</label>
            <select id="capture-kind" name="kind">
              <option value=""${state.captureForm.kind ? '' : ' selected'}>Detect automatically</option>
              <option value="article"${state.captureForm.kind === 'article' ? ' selected' : ''}>Article</option>
              <option value="pdf"${state.captureForm.kind === 'pdf' ? ' selected' : ''}>PDF</option>
              <option value="video"${state.captureForm.kind === 'video' ? ' selected' : ''}>Video</option>
              <option value="meeting"${state.captureForm.kind === 'meeting' ? ' selected' : ''}>Meeting or audio</option>
              <option value="text"${state.captureForm.kind === 'text' ? ' selected' : ''}>Text file</option>
            </select>
          </div>
          <div class="field">
            <label for="capture-attribution">Author or speakers</label>
            <input id="capture-attribution" name="attribution" value="${escapeHtml(state.captureForm.attribution)}" placeholder="Optional, separate names with commas" />
          </div>
          <div class="state-actions">
            <button class="button button-primary" type="submit">Create preview</button>
          </div>
        </div>
      </form>`;
  }

  function capturePreviewMarkup(preview) {
    const source = objectValue(preview.source);
    const summary = objectValue(preview.summary);
    return `
      <article class="reader-surface">
        <header class="reader-header">
          <div>
            <span class="state-label">Preview only. Nothing added to the archive.</span>
            <h2>${escapeHtml(summary.title || source.title || 'Untitled source')}</h2>
            <p class="meta-line">Preview expires ${escapeHtml(formatDate(preview.expiresAt, true))}</p>
          </div>
        </header>
        <dl class="source-context">
          <div class="context-item"><dt>Detected kind</dt><dd>${escapeHtml(source.kind || 'Not detected')}</dd></div>
          <div class="context-item"><dt>Attribution</dt><dd>${escapeHtml(safeArray(source.attribution).join(', ') || 'Not reported')}</dd></div>
          <div class="context-item"><dt>Extracted size</dt><dd class="tabular">${escapeHtml(formatNumber(source.characters))} characters</dd></div>
        </dl>
        <div class="prose">
          <p>${escapeHtml(summary.summary || 'No summary returned.')}</p>
          ${summaryListMarkup('Decisions', summary.decisions)}
          ${summaryListMarkup('Action items', summary.action_items)}
          ${summaryListMarkup('Open questions', summary.open_questions)}
          ${topicFactsMarkup(summary.facts)}
        </div>
        <div class="review-actions">
          <span class="dirty-status">Raw text stays in short-lived server memory until staging or expiry.</span>
          <button class="button button-text" type="button" data-discard-preview>Discard preview</button>
          <button class="button button-primary" type="button" data-stage-preview>Stage for review</button>
        </div>
      </article>`;
  }

  function renderCapture() {
    ++state.renderSequence;
    state.view = 'capture';
    setActiveNavigation('capture');
    let status = '';
    if (state.captureStatus === 'loading') {
      status = `<div class="notice"><strong>Creating preview.</strong> Extracting and summarizing can take a minute. Nothing has been written.</div>${loadingMarkup('Creating source preview')}`;
    } else if (state.captureStatus === 'staging') {
      status = `<div class="notice"><strong>Staging source.</strong> Chronicle is persisting the raw capture and adding a draft to the inbox.</div>${loadingMarkup('Staging source for review')}`;
    } else if (state.captureError) {
      const retry = state.captureErrorAction === 'stage'
        ? '<button class="button button-text" type="button" data-stage-preview>Retry staging</button>'
        : state.captureErrorAction === 'discard'
          ? '<button class="button button-text" type="button" data-discard-preview>Retry discard</button>'
          : '<button class="button button-text" type="button" data-capture-retry>Retry preview</button>';
      status = `<div class="notice notice-error" role="alert"><strong>Capture failed.</strong> ${escapeHtml(state.captureError)} ${retry}</div>`;
    }
    setMain(`
      <header class="view-header"><h1>Capture source</h1><p>Inspect detected metadata and extracted knowledge before anything enters the review inbox.</p></header>
      ${status}
      ${state.captureStatus === 'loading' || state.captureStatus === 'staging' ? '' : `
        <div class="library-layout${state.capturePreview ? ' has-selection' : ''}">
          <section class="library-list">${captureFormMarkup()}</section>
          ${state.capturePreview ? capturePreviewMarkup(state.capturePreview) : stateMarkup('empty', 'Preview first', 'Raw text stays server-side. Staging creates a review draft and never auto-approves it.')}
        </div>`}`);
    elements.main.setAttribute('aria-busy', String(state.captureStatus === 'loading' || state.captureStatus === 'staging'));
  }

  async function revokePreviewToken(token) {
    if (!token) return;
    await api(`/api/ingest/preview/${encodeURIComponent(token)}`, { method: 'DELETE' });
  }

  async function createCapturePreview(form) {
    if (form instanceof HTMLFormElement) {
      const data = new FormData(form);
      state.captureForm = {
        input: String(data.get('input') || '').trim(),
        kind: String(data.get('kind') || ''),
        attribution: String(data.get('attribution') || '').trim(),
      };
    }
    const requestSequence = ++state.captureRequestSequence;
    const submitted = { ...state.captureForm };
    state.captureStatus = 'loading';
    state.captureError = '';
    state.captureErrorAction = 'preview';
    renderCapture();
    announce('Creating source preview.');
    try {
      const preview = await api('/api/ingest/preview', {
        method: 'POST',
        body: JSON.stringify(submitted),
      });
      if (requestSequence !== state.captureRequestSequence || state.view !== 'capture') {
        state.captureStatus = 'idle';
        await revokePreviewToken(preview.token).catch(() => {});
        return;
      }
      state.capturePreview = preview;
      state.captureStatus = 'ready';
      renderCapture();
      focusMain();
      announce('Source preview ready. Nothing has been written.');
    } catch (error) {
      if (requestSequence !== state.captureRequestSequence || state.view !== 'capture') return;
      state.captureStatus = 'idle';
      state.captureError = error instanceof Error ? error.message : 'Could not create the preview.';
      state.captureErrorAction = 'preview';
      renderCapture();
      announce('Source preview failed.');
    }
  }

  async function stageCapturePreview() {
    if (!state.capturePreview?.token || state.captureStatus === 'staging') return;
    const requestSequence = ++state.captureRequestSequence;
    const stagedToken = state.capturePreview.token;
    state.captureStatus = 'staging';
    state.captureError = '';
    state.captureErrorAction = 'stage';
    renderCapture();
    announce('Staging source for review.');
    try {
      const data = await api('/api/ingest/stage', {
        method: 'POST',
        body: JSON.stringify({ token: stagedToken }),
      });
      const draft = normaliseDraft(data);
      state.draftsLoaded = false;
      if (requestSequence !== state.captureRequestSequence || state.view !== 'capture') {
        if (state.capturePreview?.token === stagedToken) state.capturePreview = null;
        state.captureStatus = 'idle';
        return;
      }
      state.capturePreview = null;
      state.captureStatus = 'idle';
      state.activeDraft = draft.id ? draft : null;
      announce('Source staged in the review inbox. It was not approved.');
      goToHash(draft.id ? `#inbox/${encodeURIComponent(draft.id)}` : '#inbox', { skipDirtyCheck: true });
    } catch (error) {
      if (requestSequence !== state.captureRequestSequence || state.view !== 'capture') return;
      state.captureStatus = 'ready';
      state.captureError = error instanceof Error ? error.message : 'Could not stage the preview.';
      state.captureErrorAction = 'stage';
      renderCapture();
      announce('Source staging failed. The preview remains available if it has not expired.');
    }
  }

  async function discardCapturePreview() {
    const token = state.capturePreview?.token;
    if (!token) return;
    const requestSequence = ++state.captureRequestSequence;
    try {
      await revokePreviewToken(token);
      state.capturePreview = null;
      state.captureStatus = 'idle';
      state.captureError = '';
      if (requestSequence !== state.captureRequestSequence || state.view !== 'capture') return;
      renderCapture();
      announce('Preview discarded. Nothing was written.');
    } catch (error) {
      if (requestSequence !== state.captureRequestSequence || state.view !== 'capture') return;
      state.captureError = error instanceof Error ? error.message : 'Could not discard the preview.';
      state.captureErrorAction = 'discard';
      renderCapture();
      announce('Preview could not be discarded.');
    }
  }

  async function ensureLibrary(force = false) {
    if (state.libraryLoaded && !force) return;
    const data = await api('/api/library');
    state.records = safeArray(data.records || data.meetings);
    state.topics = safeArray(data.topics);
    state.libraryLoaded = true;
  }

  async function loadNote(file) {
    if (state.selectedNote?.file === file) return state.selectedNote;
    const note = await api(`/api/notes/${requestPath(file)}`);
    state.selectedNote = note;
    return note;
  }

  function libraryListMarkup(items, selectedFile, type) {
    return `
      <aside class="library-list" aria-label="${escapeHtml(type)} list">
        <p class="list-heading">${items.length} ${escapeHtml(type.toLowerCase())}</p>
        <ol class="record-list">
          ${items.map((item) => `
            <li>
              <button class="record-item${item.file === selectedFile ? ' is-active' : ''}" type="button" data-library-file="${escapeHtml(item.file)}" data-library-type="${escapeHtml(type.toLowerCase())}"${item.file === selectedFile ? ' aria-current="true"' : ''}>
                <span class="record-item-title">${escapeHtml(item.title || titleFromFile(item.file))}</span>
                <span class="record-item-meta">${escapeHtml(item.type || (type === 'Topics' ? 'topic' : 'record'))}${item.updatedAt ? ` | ${escapeHtml(formatDate(item.updatedAt))}` : ''}</span>
              </button>
            </li>`).join('')}
        </ol>
      </aside>`;
  }

  function libraryTabsMarkup(view) {
    return `
      <div class="library-tabs" role="group" aria-label="Library collection">
        <button class="mode-button${view === 'records' ? ' is-active' : ''}" type="button" data-view-link="records" aria-pressed="${view === 'records'}">Records</button>
        <button class="mode-button${view === 'topics' ? ' is-active' : ''}" type="button" data-view-link="topics" aria-pressed="${view === 'topics'}">Topics</button>
      </div>`;
  }

  function libraryBoardMarkup(items, type) {
    return `
      <ol class="library-board" aria-label="${escapeHtml(type)}">
        ${items.map((item) => `
          <li class="library-pin">
            <button type="button" data-library-file="${escapeHtml(item.file)}" data-library-type="${escapeHtml(type.toLowerCase())}">
              <span class="record-type">${escapeHtml(item.type || (type === 'Topics' ? 'topic' : 'record'))}</span>
              <strong>${escapeHtml(item.title || titleFromFile(item.file))}</strong>
              <span class="record-item-meta">${item.updatedAt ? escapeHtml(formatDate(item.updatedAt)) : 'Approved memory'}</span>
            </button>
          </li>`).join('')}
      </ol>`;
  }

  function articleBodyHtml(html) {
    const withoutRepeatedTitle = String(html || '').replace(/^\s*<h1>[\s\S]*?<\/h1>\s*/i, '');
    return withoutRepeatedTitle.replace(/<(\/?)h([1-3])>/gi, (_match, closing, level) => {
      const numeric = Number(level);
      const nestedLevel = numeric === 1 ? 3 : numeric + 1;
      return `<${closing}h${nestedLevel}>`;
    });
  }

  function noteMarkup(note, view) {
    return `
      <section class="library-reader">
        <button class="button button-text back-button" type="button" data-back-to-library="${escapeHtml(view)}">Back to ${escapeHtml(view)} list</button>
        <article class="reader-surface">
          <header class="reader-header">
            <div>
              <span class="record-type">${escapeHtml(note.type || (view === 'topics' ? 'topic' : 'record'))}</span>
              <h2>${escapeHtml(note.title || titleFromFile(note.file))}</h2>
              <p class="source-path">${escapeHtml(note.file)}</p>
            </div>
          </header>
          <div class="prose">${articleBodyHtml(note.html) || '<p>No readable content.</p>'}</div>
        </article>
      </section>`;
  }

  async function renderLibrary(view, options = {}) {
    const sequence = ++state.renderSequence;
    state.view = view;
    setActiveNavigation(view);
    setMain(loadingMarkup(`Loading ${view}`), true);
    try {
      await ensureLibrary(Boolean(options.force));
      const items = view === 'topics' ? state.topics : state.records;
      const type = view === 'topics' ? 'Topics' : 'Records';
      const file = options.file || null;
      state.selectedFile = file;
      state.selectedNote = file ? await loadNote(file) : null;
      if (sequence !== state.renderSequence) return;
      setMain(`
        <header class="view-header library-header"><h1>Library</h1><p>${view === 'topics'
          ? 'Follow the durable subjects that have formed across approved memory.'
          : 'Browse approved captures as a living collection, with every source still attached.'}</p>${libraryTabsMarkup(view)}</header>
        ${items.length ? `
          ${state.selectedNote ? `<div class="library-layout has-selection">
            ${libraryListMarkup(items, file, type)}
            ${noteMarkup(state.selectedNote, view)}
          </div>` : libraryBoardMarkup(items, type)}` : stateMarkup('empty', `No ${view} yet`, view === 'topics'
            ? 'Topics appear after an approved draft contributes factual knowledge.'
            : 'Approve a review draft to create the first durable record.')}`);
    } catch (error) {
      if (sequence !== state.renderSequence) return;
      setMain(`
        <header class="view-header"><h1>Library</h1>${libraryTabsMarkup(view)}</header>
        ${stateMarkup('error', `Could not load ${view}`, error instanceof Error ? error.message : 'The archive could not be read.', `<button class="button button-secondary" type="button" data-retry-view="${escapeHtml(view)}">Retry</button>`)}`);
    } finally {
      elements.main.setAttribute('aria-busy', 'false');
    }
  }

  function digestItems(items, emptyText, kind) {
    const values = safeArray(items);
    if (!values.length) return `<p class="field-help">${escapeHtml(emptyText)}</p>`;
    return `<ul class="digest-list">${values.map((item) => {
      const record = objectValue(item);
      const text = plainInlineText(record.text || record.title || String(item));
      return `<li>${record.file
        ? `<button class="button button-text" type="button" data-note-file="${escapeHtml(record.file)}">${escapeHtml(text)}</button>`
        : escapeHtml(text)}${record.title && record.text ? `<div class="source-path">${escapeHtml(record.title)}</div>` : ''}</li>`;
    }).join('')}</ul>`;
  }

  async function renderHome(options = {}) {
    const sequence = ++state.renderSequence;
    state.view = 'home';
    setActiveNavigation('home');
    setMain(loadingMarkup('Loading your workspace'), true);
    try {
      const [data] = await Promise.all([
        api('/api/digest'),
        ensureDrafts(Boolean(options.force)).catch(() => undefined),
      ]);
      if (sequence !== state.renderSequence) return;
      const partial = safeArray(data.partial);
      const reviewCount = data.reviewCount === null
        ? state.drafts.length
        : Number(data.reviewCount || 0);
      const nextDraft = state.drafts[0];
      setMain(`
        <header class="view-header home-header">
          <h1>${reviewCount ? `${escapeHtml(formatNumber(reviewCount))} draft${reviewCount === 1 ? '' : 's'} need your attention.` : 'Your memory is ready.'}</h1>
          <p>${reviewCount ? 'Start with the next capture, verify what matters, and keep the archive trustworthy.' : 'Search what you know, revisit recent decisions, or add something new.'}</p>
        </header>
        ${partial.length ? `<div class="notice"><strong>Some home data is unavailable.</strong> ${escapeHtml(partial.join(' '))}</div>` : ''}
        <div class="home-grid">
          <section class="home-tile home-review-tile${reviewCount ? ' has-work' : ''}">
            <div class="home-tile-copy">
              <span class="home-tile-label">Review</span>
              <strong class="home-number tabular">${escapeHtml(formatNumber(reviewCount))}</strong>
              <h2>${reviewCount ? (nextDraft ? escapeHtml(nextDraft.title) : 'Drafts are waiting') : 'All clear'}</h2>
              <p>${reviewCount ? 'Check the extraction and its evidence before it becomes memory.' : 'No captured sources are waiting for approval.'}</p>
            </div>
            <button class="button ${reviewCount ? 'button-primary' : 'button-secondary'}" type="button"${nextDraft ? ` data-draft-id="${escapeHtml(nextDraft.id)}"` : ' data-view-link="inbox"'}>${reviewCount ? 'Review next' : 'Open review'}</button>
          </section>

          <section class="home-tile home-search-tile">
            <div class="home-tile-copy">
              <span class="home-tile-label">Recall</span>
              <h2>What are you trying to remember?</h2>
              <p>Ask naturally or search for the exact phrase. Every answer stays tied to evidence.</p>
            </div>
            <button class="button button-inverse" type="button" data-command-link="ask">Search memory</button>
          </section>

          <section class="home-tile home-recent-tile">
            <div class="home-tile-heading">
              <div><span class="home-tile-label">Recently approved</span><h2>Fresh memory</h2></div>
              <button class="button button-text" type="button" data-view-link="library">Open library</button>
            </div>
            ${digestItems(data.recentRecords, 'Approved records will appear here.', 'record')}
          </section>

          <section class="home-tile home-actions-tile">
            <span class="home-tile-label">Open actions</span>
            <h2>What still needs doing</h2>
            ${digestItems(data.openActions, 'No open actions were found in recent records.', 'action')}
          </section>

          <section class="home-tile home-library-tile">
            <span class="home-tile-label">Library</span>
            <strong class="home-number tabular">${escapeHtml(formatNumber(data.topicCount))}</strong>
            <h2>Connected topics</h2>
            <p>Browse approved records by source or follow the topics they have built over time.</p>
            <button class="button button-secondary" type="button" data-view-link="library">Browse memory</button>
          </section>

          <section class="home-tile home-add-tile">
            <span class="home-tile-label">Add</span>
            <h2>Bring in something new</h2>
            <p>Preview a meeting, document, video, or article before it enters review.</p>
            <button class="button button-primary" type="button" data-view-link="capture">Add source</button>
          </section>
        </div>`);
    } catch (error) {
      if (sequence !== state.renderSequence) return;
      setMain(`
        <header class="view-header"><h1>Home</h1></header>
        ${stateMarkup('error', 'Could not load your workspace', error instanceof Error ? error.message : 'The home view failed.', '<button class="button button-secondary" type="button" data-retry-view="home">Retry</button>')}`);
    } finally {
      elements.main.setAttribute('aria-busy', 'false');
    }
  }

  function yesNo(value, yes = 'Ready', no = 'Needs attention') {
    return value ? yes : no;
  }

  function trustMarkup(data) {
    const runtime = objectValue(data.runtime);
    const storage = objectValue(data.storage);
    const index = objectValue(data.index);
    const review = objectValue(data.review);
    const policy = objectValue(data.policy);
    const sessions = objectValue(data.sessions);
    const issues = safeArray(data.issues);
    const localProvider = runtime.provider === 'local';
    const indexStatus = !index.exists
      ? 'Not built. Run npm run index.'
      : !index.compatible
        ? 'Incompatible. Rebuild required.'
        : !index.fresh
          ? 'Stale. Run npm run index.'
          : `Ready with ${formatNumber(index.chunks)} chunks`;
    return `
      <header class="view-header"><h1>Settings</h1><p>See what Chronicle can access, what leaves the machine, and which safeguards are ready.</p></header>
      <section class="trust-summary">
        <div class="trust-mark" data-level="${data.ok ? 'ready' : 'attention'}">${data.ok ? 'OK' : '!'}</div>
        <div><h2>${data.ok ? 'Ready for reviewed memory' : 'Setup needs attention'}</h2><p>${data.ok
          ? 'Storage, review, search, recording, and recall checks passed.'
          : `${issues.length} check${issues.length === 1 ? '' : 's'} need attention before relying on the full workflow.`}</p></div>
      </section>
      ${issues.length ? `<div class="notice"><strong>Checks to resolve.</strong><ul class="issue-list">${issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join('')}</ul></div>` : ''}
      <div class="trust-grid">
        <section class="trust-section">
          <h2>System health</h2>
          <dl class="health-list">
            <div class="health-row"><dt>Knowledge base</dt><dd>${escapeHtml(storage.exists ? yesNo(storage.readable && storage.writable) : 'Not created')}</dd></div>
            <div class="health-row"><dt>Search index</dt><dd>${escapeHtml(indexStatus)}</dd></div>
            <div class="health-row"><dt>Index generation</dt><dd>${escapeHtml(`${index.indexedGeneration ?? 0} of ${index.generation ?? 0}`)}</dd></div>
            ${index.lastSuccessAt ? `<div class="health-row"><dt>Last index success</dt><dd>${escapeHtml(formatDate(index.lastSuccessAt, true))}</dd></div>` : ''}
            ${index.lastError ? `<div class="health-row"><dt>Last index error</dt><dd>${escapeHtml(index.lastError)}</dd></div>` : ''}
            <div class="health-row"><dt>Review workflow</dt><dd>${escapeHtml(yesNo(review.available, 'Available', 'Unavailable'))}</dd></div>
            <div class="health-row"><dt>Recording policy</dt><dd>${escapeHtml(yesNo(policy.recordConfigured ?? policy.configured, 'Configured', 'Not configured'))}</dd></div>
            <div class="health-row"><dt>Recall policy</dt><dd>${escapeHtml(yesNo(policy.recallConfigured, 'Configured', 'Not configured'))}</dd></div>
            <div class="health-row"><dt>Automatic recording</dt><dd>${policy.autoRecord ? 'Enabled' : 'Off'}</dd></div>
            <div class="health-row"><dt>Workspace</dt><dd>${escapeHtml(data.workspaceId || 'default')}</dd></div>
            <div class="health-row"><dt>Checked</dt><dd>${escapeHtml(formatDate(data.checkedAt, true))}</dd></div>
          </dl>
        </section>
        <section class="trust-section">
          <h2>Privacy boundary</h2>
          <dl class="health-list">
            <div class="health-row"><dt>Model provider</dt><dd>${escapeHtml(runtime.providerLabel || runtime.provider || 'Not reported')}</dd></div>
            <div class="health-row"><dt>Model traffic</dt><dd>${localProvider ? 'Configured for local processing' : 'May leave this machine'}</dd></div>
            <div class="health-row"><dt>Web binding</dt><dd>${escapeHtml(runtime.bindScope || 'Not reported')}</dd></div>
            <div class="health-row"><dt>Remote authentication</dt><dd>${runtime.authRequired ? escapeHtml(yesNo(runtime.authEnabled, 'Enabled', 'Missing')) : 'Not required on loopback'}</dd></div>
            <div class="health-row"><dt>Runtime</dt><dd>${escapeHtml(runtime.node || 'Not reported')}</dd></div>
          </dl>
        </section>
        <section class="trust-section">
          <h2>Memory rules</h2>
          <ul class="issue-list">
            <li>Captured source material remains separate from model drafts.</li>
            <li>Only human-approved drafts enter records, topics, and recall.</li>
            <li>Rejecting a draft never promotes its claims to memory.</li>
            <li>Recall shows source excerpts or states that evidence is insufficient.</li>
          </ul>
        </section>
        <section class="trust-section">
          <h2>Capture rules</h2>
          <ul class="issue-list">
            <li>Web capture previews keep raw text in short-lived server memory.</li>
            <li>Staging persists the raw source and creates a review draft.</li>
            <li>Web capture never auto-approves a source.</li>
            <li>Recording authorization and consent are governed by the configured policy.</li>
          </ul>
        </section>
        <section class="trust-section">
          <h2>Recording awareness</h2>
          <dl class="health-list">
            <div class="health-row"><dt>Live or connecting</dt><dd>${escapeHtml(formatNumber(sessions.active))}</dd></div>
            <div class="health-row"><dt>Processing</dt><dd>${escapeHtml(formatNumber(sessions.processing))}</dd></div>
            <div class="health-row"><dt>Needs review</dt><dd>${escapeHtml(formatNumber(sessions.needsReview))}</dd></div>
            <div class="health-row"><dt>Recoverable</dt><dd>${escapeHtml(formatNumber(sessions.recoverable))}</dd></div>
            <div class="health-row"><dt>Discarded</dt><dd>${escapeHtml(formatNumber(sessions.discarded))}</dd></div>
          </dl>
          ${safeArray(sessions.latest).length ? `<ul class="digest-list">${safeArray(sessions.latest).map((entry) => {
            const session = objectValue(entry);
            return `<li><strong>${escapeHtml(String(session.stage || 'unknown').replaceAll('_', ' '))}</strong><div class="source-path">${escapeHtml(formatNumber(session.participantCount))} participants | ${escapeHtml(formatNumber(session.optedOutCount))} opted out | ${escapeHtml(formatDate(session.updatedAt, true))}${session.recoverable ? ' | recoverable' : ''}</div></li>`;
          }).join('')}</ul>` : '<p class="field-help">No session manifests for this workspace.</p>'}
        </section>
      </div>`;
  }

  async function renderTrust(options = {}) {
    const sequence = ++state.renderSequence;
    state.view = 'trust';
    setActiveNavigation('trust');
    setMain(loadingMarkup('Checking Chronicle health'), true);
    try {
      const data = await api('/api/trust');
      if (sequence !== state.renderSequence) return;
      state.health = data;
      updateCompactHealth(data);
      setMain(trustMarkup(data));
    } catch (error) {
      if (sequence !== state.renderSequence) return;
      setMain(`
        <header class="view-header"><h1>Settings</h1></header>
        ${stateMarkup('error', 'Health check failed', error instanceof Error ? error.message : 'Chronicle could not inspect its safeguards.', '<button class="button button-secondary" type="button" data-retry-view="trust">Retry</button>')}`);
      updateCompactHealth(null, true);
    } finally {
      elements.main.setAttribute('aria-busy', 'false');
    }
  }

  function updateCompactHealth(data, failed = false) {
    if (failed) {
      elements.healthState.textContent = 'Unavailable';
      elements.healthState.dataset.level = 'error';
      elements.healthDetail.textContent = 'Health check failed';
      elements.healthButton.setAttribute('aria-label', 'Chronicle health check unavailable. Open Settings.');
      return;
    }
    if (!data) {
      elements.healthState.textContent = 'Checking';
      elements.healthState.dataset.level = 'attention';
      elements.healthDetail.textContent = 'System health';
      elements.healthButton.setAttribute('aria-label', 'Checking Chronicle health. Open Settings.');
      return;
    }
    elements.healthState.textContent = data.ok ? 'Ready' : 'Attention';
    elements.healthState.dataset.level = data.ok ? 'ready' : 'attention';
    elements.healthDetail.textContent = data.ok ? 'All checks passed' : `${safeArray(data.issues).length} checks need work`;
    elements.healthButton.setAttribute(
      'aria-label',
      data.ok
        ? 'Chronicle health ready. All checks passed. Open Settings.'
        : `Chronicle health needs attention. ${safeArray(data.issues).length} checks need work. Open Settings.`,
    );
  }

  async function loadCompactHealth() {
    try {
      const data = await api('/api/trust');
      state.health = data;
      updateCompactHealth(data);
    } catch {
      updateCompactHealth(null, true);
    }
  }

  async function loadInboxCount() {
    try {
      await ensureDrafts();
    } catch {
      elements.inboxCount.textContent = '?';
      elements.inboxCount.setAttribute('aria-label', 'Inbox count unavailable');
    }
  }

  function parseRoute() {
    const raw = location.hash.replace(/^#/, '') || 'home';
    if (raw.startsWith('/note/')) {
      const file = decodeURIComponent(raw.slice('/note/'.length));
      return { view: /(^|\/)topics\//.test(file) ? 'topics' : 'records', file };
    }
    const slash = raw.indexOf('/');
    const view = slash < 0 ? raw : raw.slice(0, slash);
    const detail = slash < 0 ? '' : decodeURIComponent(raw.slice(slash + 1));
    if (view === 'inbox') return { view, id: detail || undefined };
    if (view === 'records' || view === 'topics') return { view, file: detail || undefined };
    if (view === 'library') return { view: 'records' };
    if (view === 'home' || view === 'digest') return { view: 'home' };
    if (['capture', 'trust'].includes(view)) return { view };
    return { view: 'home' };
  }

  async function renderRoute(options = {}) {
    closeDrawer(false);
    closeCommand(false);
    const route = parseRoute();
    if (state.view === 'capture' && route.view !== 'capture') {
      state.captureRequestSequence += 1;
      if (state.captureStatus === 'loading' || state.captureStatus === 'staging') {
        state.captureStatus = state.capturePreview ? 'ready' : 'idle';
      }
    }
    if (route.view === 'home') await renderHome(options);
    else if (route.view === 'inbox') await renderInbox({ id: route.id, force: options.force });
    else if (route.view === 'capture') renderCapture();
    else if (route.view === 'records' || route.view === 'topics') await renderLibrary(route.view, { file: route.file, force: options.force });
    else if (route.view === 'trust') await renderTrust(options);
    state.lastSafeHash = location.hash || '#home';
    if (options.focus !== false) focusMain(Boolean(route.id || route.file));
  }

  function confirmReviewNavigation() {
    if (!state.dirty) return true;
    const leave = window.confirm('You have unsaved review edits. Leave and discard them?');
    if (leave) state.dirty = false;
    return leave;
  }

  function goToHash(hash, options = {}) {
    if (!options.skipDirtyCheck && !confirmReviewNavigation()) return false;
    if (location.hash === hash) renderRoute({ focus: true });
    else location.hash = hash;
    return true;
  }

  function goToView(view) {
    goToHash(`#${view}`);
  }

  function goToNote(file) {
    const view = /(^|\/)topics\//.test(file) ? 'topics' : 'records';
    goToHash(`#${view}/${encodeURIComponent(file)}`);
  }

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button, a') : null;
    if (!target) return;

    if (target.matches('[data-view-link]')) {
      event.preventDefault();
      goToView(target.dataset.viewLink);
    } else if (target.matches('[data-command-link]')) {
      event.preventDefault();
      openCommand(target.dataset.commandLink);
    } else if (target.matches('[data-command-mode]')) {
      setCommandMode(target.dataset.commandMode, true);
    } else if (target.matches('[data-close-command], [data-dismiss-command]')) {
      closeCommandResults();
    } else if (target.matches('[data-command-retry]')) {
      runCommand(state.commandQuery);
    } else if (target.matches('[data-draft-id]')) {
      goToHash(`#inbox/${encodeURIComponent(target.dataset.draftId)}`);
    } else if (target.matches('[data-back-to-queue]')) {
      if (!confirmReviewNavigation()) return;
      state.activeDraft = null;
      state.dirty = false;
      goToHash('#inbox', { skipDirtyCheck: true });
    } else if (target.matches('[data-approve-draft]')) {
      approveDraft(target.dataset.approveDraft);
    } else if (target.matches('[data-reject-draft]')) {
      openRejectDialog(target.dataset.rejectDraft);
    } else if (target.matches('[data-discard-preview]')) {
      discardCapturePreview();
    } else if (target.matches('[data-capture-retry]')) {
      createCapturePreview();
    } else if (target.matches('[data-stage-preview]')) {
      stageCapturePreview();
    } else if (target.matches('[data-library-file]')) {
      const view = target.dataset.libraryType === 'topics' ? 'topics' : 'records';
      goToHash(`#${view}/${encodeURIComponent(target.dataset.libraryFile)}`);
    } else if (target.matches('[data-back-to-library]')) {
      goToView(target.dataset.backToLibrary);
    } else if (target.matches('[data-note-file]')) {
      goToNote(target.dataset.noteFile);
    } else if (target.matches('[data-retry-view]')) {
      renderRoute({ force: true, focus: true });
    } else if (target.matches('[data-close-drawer]')) {
      closeDrawer(true);
    }
  });

  document.addEventListener('input', (event) => {
    if (event.target instanceof HTMLInputElement && event.target.closest('#capture-form')) {
      if (event.target.name === 'input' || event.target.name === 'attribution') {
        state.captureForm[event.target.name] = event.target.value;
      }
    }
    if (event.target instanceof Element && event.target.closest('#review-form')) {
      state.dirty = true;
      if (event.target.id === 'draft-actions' || event.target.id === 'draft-facts') {
        clearReviewFieldError(event.target.id);
      }
      const status = document.getElementById('dirty-status');
      if (status) status.textContent = 'Unsaved edits';
    }
  });

  document.addEventListener('change', (event) => {
    if (event.target instanceof HTMLSelectElement && event.target.id === 'capture-kind') {
      state.captureForm.kind = event.target.value;
    }
  });

  document.addEventListener('submit', (event) => {
    if (event.target === elements.commandForm) {
      event.preventDefault();
      runCommand();
    } else if (event.target instanceof HTMLFormElement && event.target.id === 'review-form') {
      event.preventDefault();
      saveDraft(event.target.dataset.reviewId).catch(() => {});
    } else if (event.target instanceof HTMLFormElement && event.target.id === 'capture-form') {
      event.preventDefault();
      createCapturePreview(event.target);
    }
  });

  elements.rejectForm.addEventListener('submit', (event) => {
    const submitter = event.submitter;
    if (!(submitter instanceof HTMLButtonElement) || submitter.value !== 'confirm') {
      state.pendingRejectId = null;
      return;
    }
    event.preventDefault();
    const id = state.pendingRejectId;
    const reason = elements.rejectReason.value.trim();
    elements.rejectDialog.close();
    state.pendingRejectId = null;
    if (id) rejectDraft(id, reason);
  });

  elements.rejectDialog.addEventListener('cancel', () => {
    state.pendingRejectId = null;
  });

  elements.menuButton.addEventListener('click', () => {
    if (elements.drawer.classList.contains('is-open')) closeDrawer(true);
    else openDrawer();
  });
  elements.backdrop.addEventListener('click', () => closeDrawer(true));
  elements.commandBackdrop.addEventListener('click', () => closeCommand(true));
  elements.themeButton.addEventListener('click', cycleTheme);
  elements.drawerThemeButton.addEventListener('click', cycleTheme);

  document.addEventListener('keydown', (event) => {
    trapDrawerFocus(event);
    trapCommandFocus(event);
    if (event.key === 'Escape' && elements.drawer.classList.contains('is-open')) closeDrawer(true);
    else if (event.key === 'Escape' && elements.commandBand.classList.contains('is-open')) closeCommand(true);
    const target = event.target;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable;
    if (!typing && event.key === '/') {
      event.preventDefault();
      openCommand('find');
    }
    if (!typing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openCommand('ask');
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && document.getElementById('review-form')) {
      event.preventDefault();
      if (state.activeDraft && !state.pending) saveDraft(state.activeDraft.id).catch(() => {});
    }
  });

  window.addEventListener('hashchange', () => {
    if (!confirmReviewNavigation()) {
      history.replaceState(null, '', state.lastSafeHash);
      return;
    }
    renderRoute({ focus: true });
  });
  window.addEventListener('beforeunload', (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  let storedTheme = 'system';
  try {
    storedTheme = localStorage.getItem('chronicle-theme') || 'system';
  } catch {
    storedTheme = 'system';
  }
  applyTheme(storedTheme);
  setCommandMode('ask');
  loadCompactHealth();
  loadInboxCount();
  renderRoute({ focus: false });
})();
