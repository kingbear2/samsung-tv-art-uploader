/**
 * Frame TV Art Card v0.3.1
 */

class FrameTVArtCard extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._hass = null;
    this._dropdownOpen = false;
    this._applyPending = false;
    this._applyPendingTimer = null;
    this._lastStateHash = '';
    this._statusMessage = '';
    this._refreshAck = { status: '', message: '', req_id: '', updated: 0 };
    this._refreshRequest = { req_id: '', updated: 0 };
    this._logLines = [];  // rolling buffer of frame_tv/log messages
    this._logUnsubscribe = null;
    this._syncAck = { status: '', message: '', req_id: '', updated: 0 };
    this._refreshAckUnsubscribe = null;
    this._refreshCmdUnsubscribe = null;
    this._syncAckUnsubscribe = null;
    this._refreshSubscribing = false;
    this._setStatus = null;
    this._refreshInfoMsg = null;
    this._refreshInProgress = false;
    this._refreshProgressMsg = '';
    this._refreshProgressLog = [];
    this._docClickHandler = null;
    this._staleClearTimer = null;

    // Restore progress log if page was refreshed mid-sync (max 15 min TTL)
    try {
      const _raw = sessionStorage.getItem('ftvHaRefreshLog');
      if (_raw && sessionStorage.getItem('ftvHaRefreshActive')) {
        const _entry = JSON.parse(_raw);
        const _age = Date.now() - (_entry.ts || 0);
        if (_age < 15 * 60 * 1000) {
          this._refreshProgressLog = _entry.log || [];
          this._refreshInProgress = true;
          // Safety valve: if no new ack messages arrive within 30s, assume the
          // container already finished and clear the stale state.
          this._staleClearTimer = setTimeout(() => {
            if (this._refreshInProgress) {
              this._refreshInProgress = false;
              this._refreshProgressLog = [];
              try { sessionStorage.removeItem('ftvHaRefreshLog'); sessionStorage.removeItem('ftvHaRefreshActive'); } catch(_) {}
              this._lastStateHash = '';
              if (this._hass) this._render();
            }
          }, 30000);
        } else {
          sessionStorage.removeItem('ftvHaRefreshLog'); sessionStorage.removeItem('ftvHaRefreshActive');
        }
      }
    } catch(_) {}
  }

  setConfig(config) {
    this._config = {
      title: config.title || 'Frame TV Art',
      icon: config.icon || 'mdi:palette',
      // MQTT-first configuration: entity that exposes settings via attributes
      settings_entity: config.settings_entity || 'sensor.frame_tv_art_settings',
      // Default to MQTT-discovered sensors provided by the container
      collections_entity: config.collections_entity || 'sensor.frame_tv_art_collections',
      selected_artwork_file_entity: config.selected_artwork_file_entity || 'sensor.frame_tv_art_selected_artwork',
      selected_collections_entity: config.selected_collections_entity || 'sensor.frame_tv_art_selected_collections',
      refresh_cmd_topic: config.refresh_cmd_topic || 'frame_tv/cmd/collections/refresh',
      refresh_ack_topic: config.refresh_ack_topic || 'frame_tv/ack/collections/refresh',
      sync_ack_topic: config.sync_ack_topic || 'frame_tv/ack/settings/sync_collections',
      // Single base path for images served by Home Assistant (/local maps to /config/www)
      image_path: config.image_path || '/local/images/frame_tv_art_collections',
      standby_image_path: config.standby_image_path,
      preload_thumbnails: false,
      // URL of the standalone Samsung TV Art Uploader web UI. Clicking the cog
      // opens this URL in a new tab. Defaults to the mDNS hostname the
      // container advertises; override if your container is reachable at a
      // different host/port (e.g. http://<docker-host>:8080).
      web_ui_url: config.web_ui_url || 'http://samsung-tv-art.local:8080',
      ...config
    };
    // don't eagerly build standby path here; compute based on protocol when needed
    this._lastStateHash = '';
    // No CSV fetch required; all metadata comes from MQTT sensor attributes
  }

  _getBaseImagePath() {
    // Single unified base path (no http/https split needed when using /local)
    return this._config.image_path || '';
  }

  _preloadThumbnails(images) {
    if (!images || !images.length) return;
    const basePath = this._getBaseImagePath();
    const urls = images.map(img =>
      `${basePath}/${encodeURIComponent(img.folder)}/${encodeURIComponent(img.file)}`
    );
    // Load up to 6 concurrently to warm the browser cache without flooding
    const CONCURRENCY = 6;
    let idx = 0;
    const next = () => {
      if (idx >= urls.length) return;
      const url = urls[idx++];
      const img = new Image();
      img.onload = img.onerror = next;
      img.src = url;
    };
    for (let i = 0; i < Math.min(CONCURRENCY, urls.length); i++) next();
  }

  set hass(hass) {
    this._hass = hass;
    this._ensureRefreshSubscriptions();
    
    // Sync baseline from HA state; keep staged when dropdown is open or apply is in flight.
    // Only update when the dropdown is closed AND no apply is pending (or HA has confirmed the applied value).
    if (!this._dropdownOpen) {
      const fromState = this._getSelectedCollections();
      if (!this._applyPending || this._arraysEqual(fromState, this._currentSelected)) {
        if (this._applyPending) {
          this._applyPending = false;
          if (this._applyPendingTimer) { clearTimeout(this._applyPendingTimer); this._applyPendingTimer = null; }
        }
        this._baselineSelected = Array.isArray(fromState) ? [...fromState] : [];
        if (!Array.isArray(this._currentSelected)) {
          this._currentSelected = [...this._baselineSelected];
        }
      }
    }
    
    // Don't re-render if dropdown is open
    if (this._dropdownOpen) return;
    
    // Only re-render if relevant state changed
    const newHash = this._getStateHash();
    if (newHash === this._lastStateHash) return;
    this._lastStateHash = newHash;
    
    this._render();
  }

  _getStateHash() {
    // Create a hash of the states we care about
    const file = this._getSelectedData().file || '';
    const selected = this._getState(this._config.selected_collections_entity);
    const options = this._getOptions(this._config.collections_entity).join(',');
    const ackStatus = (this._refreshAck && this._refreshAck.status) || '';
    const ackMessage = (this._refreshAck && this._refreshAck.message) || '';
    const ackReqId = (this._refreshAck && this._refreshAck.req_id) || '';
    const syncStatus = (this._syncAck && this._syncAck.status) || '';
    const artAttrs = this._getAttrs(this._config.selected_artwork_file_entity);
    const inArtMode = artAttrs ? String(artAttrs.in_art_mode) : 'true';
    return `${file}|${selected}|${options}|${ackStatus}|${ackMessage}|${ackReqId}|${syncStatus}|${this._refreshInProgress}|${this._slideshowMode}|${this._slideshowSeq}|${this._slideshowUpdateMins}|${this._slideshowMaxUploads}|${this._slideshowUploading}|${inArtMode}`;
  }

  disconnectedCallback() {
    if (typeof this._refreshAckUnsubscribe === 'function') {
      try { this._refreshAckUnsubscribe(); } catch (_) {}
    }
    if (typeof this._refreshCmdUnsubscribe === 'function') {
      try { this._refreshCmdUnsubscribe(); } catch (_) {}
    }
    if (typeof this._syncAckUnsubscribe === 'function') {
      try { this._syncAckUnsubscribe(); } catch (_) {}
    }
    this._refreshAckUnsubscribe = null;
    this._refreshCmdUnsubscribe = null;
    this._syncAckUnsubscribe = null;
    this._refreshSubscribing = false;
    // Clean up document-level listener
    if (this._docClickHandler) {
      document.removeEventListener('click', this._docClickHandler, { capture: true });
      this._docClickHandler = null;
    }
    if (this._radiusObserver) {
      this._radiusObserver.disconnect();
      this._radiusObserver = null;
    }
  }

  _ensureRefreshSubscriptions() {
    if (!this._hass || !this._hass.connection) return;
    if (this._refreshSubscribing) return;
    if (this._refreshAckUnsubscribe && this._refreshCmdUnsubscribe && this._syncAckUnsubscribe && this._logUnsubscribe) return;
    this._refreshSubscribing = true;

    const ensureAck = this._refreshAckUnsubscribe
      ? Promise.resolve(this._refreshAckUnsubscribe)
      : this._hass.connection.subscribeMessage(
          (msg) => this._handleRefreshAckMessage(msg),
          { type: 'mqtt/subscribe', topic: this._config.refresh_ack_topic }
        );

    const ensureCmd = this._refreshCmdUnsubscribe
      ? Promise.resolve(this._refreshCmdUnsubscribe)
      : this._hass.connection.subscribeMessage(
          (msg) => this._handleRefreshRequestMessage(msg),
          { type: 'mqtt/subscribe', topic: this._config.refresh_cmd_topic }
        );

    const ensureSyncAck = this._syncAckUnsubscribe
      ? Promise.resolve(this._syncAckUnsubscribe)
      : this._hass.connection.subscribeMessage(
          (msg) => this._handleSyncAckMessage(msg),
          { type: 'mqtt/subscribe', topic: this._config.sync_ack_topic }
        );

    const ensureLog = this._logUnsubscribe
      ? Promise.resolve(this._logUnsubscribe)
      : this._hass.connection.subscribeMessage(
          (msg) => {
            const line = (msg && (msg.payload || msg)) || '';
            const s = typeof line === 'string' ? line.trim() : JSON.stringify(line);
            if (!s) return;
            this._logLines.push(s);
            if (this._logLines.length > 60) this._logLines.shift();
            // Update visible log element if showing standby and not in curated refresh
            if (!this._refreshInProgress && this._isStandbyLike) {
              const logEl = this.querySelector('.ftv-refresh-log');
              if (logEl) { logEl.innerHTML = this._logLines.map(l => this._logLineHtml(l)).join(''); requestAnimationFrame(() => { logEl.scrollTop = logEl.scrollHeight; }); }
            }
          },
          { type: 'mqtt/subscribe', topic: 'frame_tv/log' }
        );

    Promise.all([ensureAck, ensureCmd, ensureSyncAck, ensureLog])
      .then(([ackUnsub, cmdUnsub, syncAckUnsub, logUnsub]) => {
        if (!this._refreshAckUnsubscribe) this._refreshAckUnsubscribe = ackUnsub;
        if (!this._refreshCmdUnsubscribe) this._refreshCmdUnsubscribe = cmdUnsub;
        if (!this._syncAckUnsubscribe) this._syncAckUnsubscribe = syncAckUnsub;
        if (!this._logUnsubscribe) this._logUnsubscribe = logUnsub;
      })
      .catch(() => {})
      .finally(() => {
        this._refreshSubscribing = false;
      });
  }

  _parseJsonPayload(message) {
    const raw = message && Object.prototype.hasOwnProperty.call(message, 'payload')
      ? message.payload
      : message;
    if (raw == null) return {};
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return {};
    try {
      return JSON.parse(raw);
    } catch (_) {
      return {};
    }
  }

  _syncRefreshAckStatus() {
    const ackStatus = String((this._refreshAck && this._refreshAck.status) || '').toLowerCase();
    const ackMessage = String((this._refreshAck && this._refreshAck.message) || '').trim();
    const ackReqId = this._refreshAck && this._refreshAck.req_id != null ? String(this._refreshAck.req_id) : '';
    const reqMatches = !this._lastRefreshReqId || !ackReqId || String(this._lastRefreshReqId) === ackReqId;
    if (!reqMatches) return;

    const renderLog = () => {
      const infoEl = this.querySelector('.ftv-info');
      const logEl = this.querySelector('.ftv-refresh-log');
      if (infoEl) infoEl.innerHTML = '<div style="color:white">Refresh in progress…</div>';
      if (logEl) logEl.innerHTML = this._refreshProgressLog.map(l => this._logLineHtml(l)).join('');
      try { sessionStorage.setItem('ftvHaRefreshLog', JSON.stringify({ log: this._refreshProgressLog, ts: Date.now() })); sessionStorage.setItem('ftvHaRefreshActive', '1'); } catch(_) {}
      this._syncInfoFade(infoEl);
    };

    const appendProgress = (msg) => {
      if (this._staleClearTimer) { clearTimeout(this._staleClearTimer); this._staleClearTimer = null; }
      if (!this._refreshInProgress) {
        // First message: lock the display, seed the log, trigger full re-render with standby bg
        this._refreshProgressLog = [];
        if (msg) this._refreshProgressLog.push(msg);
        this._refreshProgressMsg = msg;
        this._refreshInProgress = true;
        this._lastStateHash = '';
        this._render();
      } else {
        // Deduplicate: drop this message if it already appears in the log.
        // This silently absorbs duplicate deliveries caused by accumulated MQTT
        // subscriptions (HA WS reconnects build up extra subscriptions over time).
        if (this._refreshProgressLog.includes(msg)) return;
        this._refreshProgressLog.push(msg);
        this._refreshProgressMsg = msg;
        renderLog();
      }
    };

    const finishProgress = (msg, delayMs) => {
      // Guard: if not in progress, a late duplicate finish message arrived — drop it.
      if (!this._refreshInProgress) return;
      // Deduplicate finish messages (multiple subscriptions can deliver the same ok/error).
      if (this._refreshProgressLog.includes(msg)) return;
      this._refreshProgressLog.push(msg);
      this._refreshProgressMsg = msg;
      renderLog();
      setTimeout(() => {
        if (this._refreshInProgress) {
          this._refreshInProgress = false;
          this._refreshProgressMsg = '';
          this._refreshProgressLog = [];
          try { sessionStorage.removeItem('ftvHaRefreshLog'); sessionStorage.removeItem('ftvHaRefreshActive'); } catch(_) {}
          this._lastStateHash = '';
          const _btnC = this.querySelector('#ftv-clear');
          if (_btnC && !this._isStandbyLike) _btnC.disabled = false;
          this._render();
        }
      }, delayMs);
    };

    if (ackStatus === 'queued') {
      appendProgress(ackMessage || 'Refresh queued. Waiting for backend...');
    } else if (ackStatus === 'started') {
      appendProgress(ackMessage || 'Switching TV to standby...');
    } else if (ackStatus === 'progress') {
      appendProgress(ackMessage || 'Refresh in progress...');
    } else if (ackStatus === 'ok') {
      finishProgress(ackMessage || 'Refresh complete.', 8000);
    } else if (ackStatus === 'error') {
      finishProgress(ackMessage ? `Refresh failed: ${ackMessage}` : 'Refresh failed.', 12000);
    }
  }

  _handleRefreshRequestMessage(message) {
    const payload = this._parseJsonPayload(message);
    const reqId = payload && payload.req_id != null ? String(payload.req_id) : '';
    this._refreshRequest = { req_id: reqId, updated: Date.now() };
    // Adopt the new req_id immediately so acks for this refresh are accepted by all clients,
    // not just the one that triggered it. cmd topic is never retained, so this is always live.
    if (reqId) this._lastRefreshReqId = reqId;
    this._refreshAck = {
      status: 'queued',
      message: 'Refresh request queued. Waiting for backend confirmation...',
      req_id: reqId,
      updated: Date.now(),
    };
    this._syncRefreshAckStatus();
  }

  _handleRefreshAckMessage(message) {
    const payload = this._parseJsonPayload(message);
    const status = String((payload && payload.status) || '').toLowerCase();
    const messageText = String((payload && payload.message) || '').trim();
    const reqId = payload && payload.req_id != null ? String(payload.req_id) : '';
    // Adopt any incoming req_id when a new reseed starts and we're not already
    // locked. This ensures auto-triggered reseeds (selection change, startup)
    // are never silently filtered by a stale _lastRefreshReqId from a prior button press.
    if ((status === 'started' || status === 'queued') && !this._refreshInProgress) {
      this._lastRefreshReqId = reqId || null;
    }
    this._refreshAck = {
      status,
      message: messageText,
      req_id: reqId,
      updated: Date.now(),
    };
    this._syncRefreshAckStatus();
  }

  _handleSyncAckMessage(message) {
    const payload = this._parseJsonPayload(message);
    const status = String((payload && payload.status) || '').toLowerCase();
    const messageText = String((payload && payload.message) || '').trim();
    const reqId = payload && payload.req_id != null ? String(payload.req_id) : '';
    this._syncAck = {
      status,
      message: messageText,
      req_id: reqId,
      updated: Date.now(),
    };
    if (typeof this._setStatus !== 'function') return;
    if (status === 'started') {
      this._setStatus(messageText || 'Collections sync started...', 0);
    } else if (status === 'ok') {
      this._setStatus(messageText || 'Collections sync completed.', 10000);
    } else if (status === 'error') {
      this._setStatus(messageText ? `Collections sync failed: ${messageText}` : 'Collections sync failed.', 12000);
    }
  }

  _getState(entityId) {
    if (!this._hass || !this._hass.states[entityId]) return '';
    return this._hass.states[entityId].state;
  }

  _getAttrs(entityId) {
    if (!this._hass || !this._hass.states[entityId]) return {};
    return this._hass.states[entityId].attributes || {};
  }

  _getOptions(entityId) {
    if (!this._hass || !this._hass.states[entityId]) return [];
    return this._hass.states[entityId].attributes.options || [];
  }

  _arraysEqual(a, b) {
    const aa = (a || []).slice().sort();
    const bb = (b || []).slice().sort();
    if (aa.length !== bb.length) return false;
    for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
    return true;
  }

  _getSelectedCollections() {
    const attrs = this._getAttrs(this._config.selected_collections_entity);
    if (attrs && Array.isArray(attrs.selected_labels)) {
      return attrs.selected_labels.map(s => String(s || '').trim()).filter(s => s.length > 0);
    }
    if (attrs && Array.isArray(attrs.selected_collections)) {
      return attrs.selected_collections.map(s => String(s || '').trim()).filter(s => s.length > 0);
    }
    const raw = this._getState(this._config.selected_collections_entity);
    if (!raw || raw === 'unknown' || raw === 'unavailable' || raw === 'None' || raw === '') {
      return [];
    }
    return raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
  }

  // CSV helpers removed — card relies on MQTT attributes and filename fallback

  _parseArtworkInfo(file) {
    if (!file || file === 'unknown' || file === 'unavailable' || file === 'None' || file === '') {
      return null;
    }

    // Remove file extension
    const raw = file.replace(/\.(jpg|jpeg|png|gif|bmp|webp)$/i, '');

    // Parse details from filename as a fallback
    // Remove file extension if present
    let cleanRaw = raw;
    
    let artist = null;
    let title = cleanRaw;
    let year = null;

    // First try to parse underscore-separated format: Artist_Year_Title
    const underscoreParts = cleanRaw.split('_');
    if (underscoreParts.length >= 3) {
      // Check if second part is a 4-digit year
      const possibleYear = underscoreParts[1];
      if (/^\d{4}$/.test(possibleYear) && parseInt(possibleYear) >= 1000 && parseInt(possibleYear) <= 2100) {
        artist = underscoreParts[0].replace(/_/g, ' ');
        year = possibleYear;
        title = underscoreParts.slice(2).join(' ').replace(/_/g, ' ');
      } else {
        // Not the expected format, treat as title with possible artist
        title = cleanRaw.replace(/_/g, ' ');
      }
    } else {
      // Fallback to space/dash parsing for other formats
      title = cleanRaw;
      
      // Extract year in parentheses
      const yearMatch = title.match(/\((\d{4})\)/);
      if (yearMatch) {
        year = yearMatch[1];
        title = title.replace(/\s*\(\d{4}\)/, '');
      }

      // Extract artist if there's a separator
      const artistMatch = title.match(/^(.+?)\s*[-–—]\s*(.+)$/);
      if (artistMatch) {
        artist = artistMatch[1].trim();
        title = artistMatch[2].trim();
      }
    }

    return {
      artist: artist,
      title: title,
      year: year
    };
  }

  _getSelectedData() {
    // Try to read a JSON-packed state from the configured entity.
    // Fallback to treating state as a plain filename.
    const entityId = this._config.selected_artwork_file_entity;
    const raw = this._getState(entityId);
    const attrs = this._getAttrs(entityId);

    // Preferred: attributes provided by an MQTT sensor (file, collection, display)
    if (attrs && (attrs.file || attrs.display || attrs.collection)) {
      return {
        file: attrs.file || '',
        display: attrs.display || null,
        collection: attrs.collection || null,
      };
    }
    if (!raw || raw === 'unknown' || raw === 'unavailable') {
      return { file: '', display: null, collection: null };
    }
    const trimmed = (raw || '').trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const obj = JSON.parse(trimmed);
        return {
          file: obj.file || '',
          display: obj.display || null,
          collection: obj.collection || null,
        };
      } catch (_) {
        // fall through to plain string
      }
    }
    return { file: trimmed, display: null, collection: null };
  }

  _logLineHtml(line) {
    const l = line.toLowerCase();
    const color = l.includes(':error:') || l.startsWith('error') ? '#ff6b6b'
                : l.includes(':warning:') || l.startsWith('warning') ? '#ffd166'
                : '#6bcb77';
    return `<div style="color:${color}">${this._escapeHtml(line)}</div>`;
  }

  _escapeHtml(text) {
    if (text == null) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  _formatInline(text) {
    // Escape first to prevent injection, then apply simple inline formatting
    let s = this._escapeHtml(text);
    // Bold: **text** or *text*
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<strong>$1</strong>');
    // Italic: _text_
    s = s.replace(/_(.+?)_/g, '<em>$1</em>');
    // Inline code: `code`
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    return s;
  }

  _formatMultiline(text) {
    const s = this._formatInline(text);
    return s.replace(/\r?\n/g, '<br>');
  }

  async _updateArtworkText(file, _, isStandby) {
    // Don't overwrite progress messages while a refresh is running
    if (this._refreshInProgress) return;
    try {
      let artworkText;
      const entityId = this._config.selected_artwork_file_entity;
      const attrs = this._getAttrs(entityId);
      const normalizedFile = String(file || '').trim().toLowerCase();
      const standbyLike = isStandby || !normalizedFile || normalizedFile === 'unknown' || normalizedFile === 'unavailable' || normalizedFile === 'none';
      
      if (isStandby && attrs && attrs.in_art_mode === false) {
        artworkText = 'TV is not in art mode';
      } else if (standbyLike) {
        artworkText = 'Please stand by as artwork is loaded...';
      } else {
        // Prefer MQTT attributes if provided by the sensor
        const title = attrs.artwork_title || null;
        const year = attrs.artwork_year || null;
        const artist = attrs.artist_name || null;
        const lifespan = attrs.artist_lifespan || null;
        const medium = attrs.artwork_medium || attrs.artist_medium || null;
        const descriptionRaw = attrs.artwork_description;
        const description = (typeof descriptionRaw === 'string') ? descriptionRaw.trim() : '';
        const hasDescription = !!(description && !/^\s*(null|none|n\/a)\s*$/i.test(description) && description !== (file || ''));
        if (title || artist || year || lifespan || medium || hasDescription) {
          const titleText = title || file || 'Selected Artwork';
          // Top: artist_name (artist_lifespan)
          const topLine = (artist || lifespan) ? `
            <div style="line-height:1.3; margin-top: 2px;">
              ${artist ? `<span style=\"font-size:1.1em; font-weight:bold; color: white;\">${this._formatInline(artist)}</span>` : ''}
              ${lifespan ? `<span style=\"font-size:0.9em; color: rgba(255,255,255,0.7);\"> (${lifespan})</span>` : ''}
            </div>
          ` : '';
          // Middle: artwork_title, artwork_year (title italic, year lighter)
          const middleLine = `
            <div style="line-height:1.3; margin-top: 8px;"><em style="font-size:1.1em; color: white;">${this._formatInline(titleText)}</em>${year ? `<span style=\"font-size:0.9em; color: rgba(255,255,255,0.7);\">, ${year}</span>` : ''}
            </div>
          `;
          // Bottom: artwork_medium
          const bottomLine = medium ? `
            <div style="font-size:0.9em; color: rgba(255,255,255,0.7); line-height:1.4; margin-top: 4px;">${this._formatInline(medium)}</div>
          ` : '';
          artworkText = `${topLine}${middleLine}${bottomLine}`;
          if (hasDescription) {
            artworkText += `<hr style="border: none; border-top: 1px solid rgba(255,255,255,0.3); margin: 8px 0; width: calc(100% + 20px); margin-left: -10px;"><div style="text-align: justify; color: rgba(255,255,255,0.7); font-size: 0.9em; line-height: 1.4;">${this._formatMultiline(description)}</div>`;
          }
        } else {
          // Fallback to filename parsing (no lifespan/medium available)
          const displayInfo = this._parseArtworkInfo(file);
          const fTitle = displayInfo?.title || file || 'Selected Artwork';
          const fYear = displayInfo?.year || null;
          const fArtist = displayInfo?.artist || null;
          const topLine = fArtist ? `
            <div style="line-height:1.3; margin-top: 2px;">
              <span style="font-size:1.1em; font-weight:bold; color: white;">${this._formatInline(fArtist)}</span>
            </div>
          ` : '';
          const middleLine = `
            <div style="line-height:1.3; margin-top: 8px;">
              <em style="font-size:1.1em; color: white;">${this._formatInline(fTitle)}</em>
              ${fYear ? `<span style=\"font-size:0.9em; color: rgba(255,255,255,0.7);\">, ${fYear}</span>` : ''}
            </div>
          `;
          artworkText = `${topLine}${middleLine}`;
        }
      }

      // Update only the info text without re-rendering everything
      const infoDiv = this.querySelector('.ftv-info');
      if (infoDiv) {
        infoDiv.innerHTML = artworkText;
        this._syncInfoFade(infoDiv);
      }
      // Show live log lines in the log element during standby
      if (standbyLike && !this._refreshInProgress) {
        const logEl = this.querySelector('.ftv-refresh-log');
        if (logEl) { logEl.innerHTML = this._logLines.map(l => this._logLineHtml(l)).join(''); requestAnimationFrame(() => { logEl.scrollTop = logEl.scrollHeight; }); }
        this._syncInfoFade(infoDiv);
      }
      
      // Also update background if we now have metadata
      this._updateBackgroundFromCsv();
    } catch (error) {
      console.warn('Error updating artwork text:', error);
      // Fallback to filename parsing on error
      const fallbackInfo = this._parseArtworkInfo(file);
      const fTitle = fallbackInfo?.title || file || 'Selected Artwork';
      const fYear = fallbackInfo?.year || null;
      const fArtist = fallbackInfo?.artist || null;
      const normalizedFile = String(file || '').trim().toLowerCase();
      const standbyLike = isStandby || !normalizedFile || normalizedFile === 'unknown' || normalizedFile === 'unavailable' || normalizedFile === 'none';
      const artworkText = standbyLike 
        ? (attrs && attrs.in_art_mode === false ? 'TV is not in art mode' : 'Please stand by as artwork is loaded...')
        : `
        ${fArtist ? `<div style=\"line-height:1.3; margin-top: 2px;\"><span style=\"font-size:1.1em; font-weight:bold; color: white;\">${this._formatInline(fArtist)}</span></div>` : ''}
            <div style=\"line-height:1.3; margin-top: 8px;\"><em style=\"font-size:1.1em; color: white;\">${this._formatInline(fTitle)}</em>${fYear ? `<span style=\"font-size:0.9em; color: rgba(255,255,255,0.7);\">, ${fYear}</span>` : ''}</div>
          `;
      
      const infoDiv = this.querySelector('.ftv-info');
      if (infoDiv) {
        infoDiv.innerHTML = artworkText;
        this._syncInfoFade(infoDiv);
      }
    }
  }

  _syncInfoFade(infoEl) {
    const wrapEl = this.querySelector('.ftv-progress-wrap');
    const fadeEl = this.querySelector('.ftv-info-fade');
    const logEl = this.querySelector('.ftv-refresh-log');
    if (!wrapEl) return;
    requestAnimationFrame(() => {
      // In standby the wrap fills available space and the log element is the scroller.
      // In artwork mode the wrap itself is the scroller.
      const scrollEl = (this._isStandbyLike && logEl && logEl.scrollHeight > 0) ? logEl : wrapEl;
      const overflow = scrollEl.scrollHeight > scrollEl.clientHeight + 2;
      if (fadeEl) fadeEl.style.display = overflow ? '' : 'none';
      wrapEl.style.cursor = overflow ? 'pointer' : '';
      wrapEl.dataset.overflows = overflow ? '1' : '';
      if (overflow && !scrollEl._ftv_scroll_bound) {
        scrollEl._ftv_scroll_bound = true;
        scrollEl.addEventListener('scroll', () => {
          if (!fadeEl) return;
          const atBottom = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 4;
          fadeEl.style.display = atBottom ? 'none' : '';
        });
      }
    });
  }

  _showInfoOverlay() {
    const infoDiv = this.querySelector('.ftv-info');
    const logDiv = this.querySelector('.ftv-refresh-log');
    const wrapEl = this.querySelector('.ftv-progress-wrap');
    if (!infoDiv) return;
    // Fade out the wrap background while overlay is open
    if (wrapEl) wrapEl.style.background = 'transparent';

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.45);';

    const panel = document.createElement('div');
    panel.style.cssText = 'position:relative;background:rgba(12,12,12,0.94);border:1px solid rgba(255,255,255,0.15);border-radius:12px;padding:20px 20px 16px;max-width:480px;width:90%;max-height:80vh;overflow-y:auto;color:white;box-shadow:0 12px 40px rgba(0,0,0,0.7);';

    const close = document.createElement('button');
    close.innerHTML = '&times;';
    close.style.cssText = 'position:absolute;top:10px;right:12px;background:transparent;border:none;color:rgba(255,255,255,0.5);font-size:22px;cursor:pointer;line-height:1;padding:0;';

    panel.innerHTML = infoDiv.innerHTML + (logDiv && logDiv.innerHTML ? '<div style="margin-top:8px;border-top:1px solid rgba(255,255,255,0.1);padding-top:8px;font-size:0.85em;line-height:1.6;color:rgba(255,255,255,0.65);">' + logDiv.innerHTML + '</div>' : '');
    panel.prepend(close);
    overlay.appendChild(panel);

    const dismiss = () => {
      try { document.body.removeChild(overlay); } catch (_) {}
      if (wrapEl) wrapEl.style.background = '';
    };
    close.addEventListener('click', (e) => { e.stopPropagation(); dismiss(); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
    document.body.appendChild(overlay);
  }

  _updateBackgroundFromCsv() {
    const { file } = this._getSelectedData();
    const normalizedFile = String(file || '').trim().toLowerCase();
    // Skip standby / missing / sentinel values — background is already set by _render()
    if (!normalizedFile || normalizedFile === 'standby.png' || normalizedFile === 'unknown' || normalizedFile === 'unavailable' || normalizedFile === 'none') {
      return;
    }
    // Reuse _getBackgroundUrl() to avoid duplicating folder-resolution logic
    const bgUrl = this._getBackgroundUrl();
    if (bgUrl) {
      
      // Update the card background directly
      const cardDiv = this.querySelector('.ftv-card');
      if (cardDiv) {
        // Log the computed URL for debugging (network/CORS/mixed-content issues)
        try { console.info('FRAME-TV-ART-CARD: computed bgUrl ->', bgUrl); } catch (e) {}
        // Detect likely mixed-content (http image on https page)
        if (typeof window !== 'undefined' && bgUrl.startsWith('http:') && window.location && window.location.protocol === 'https:') {
          const infoDiv = this.querySelector('.ftv-info');
          if (infoDiv) {
            infoDiv.innerHTML = (infoDiv.innerHTML || '') + '<div style="color: #ffcc00; margin-top:8px; font-size:0.9em;">Warning: image URL uses http: and may be blocked by browser mixed-content policy.</div>';
          }
          try { console.warn('FRAME-TV-ART-CARD: image URL uses http on https page — likely blocked by mixed-content'); } catch (e) {}
        }
        cardDiv.style.background = `linear-gradient(rgba(0,0,0,0.1), rgba(0,0,0,0.1)), url("${bgUrl}")`;
        cardDiv.style.backgroundSize = 'cover';
        cardDiv.style.backgroundPosition = 'center';
        
        // Also update text colors for dark background
        const headerDiv = this.querySelector('.ftv-header');
        if (headerDiv) headerDiv.style.color = 'white';
        
        const controlsDiv = this.querySelector('.ftv-controls');
        if (controlsDiv) controlsDiv.style.color = 'white';
        
        const infoDiv = this.querySelector('.ftv-info');
        if (infoDiv) {
          infoDiv.style.color = 'white';
        }
      }
    }
  }

  _callService(domain, service, data) {
    if (this._hass) this._hass.callService(domain, service, data);
  }

  _getBackgroundUrl() {
    const entityId = this._config.selected_artwork_file_entity;
    const { file } = this._getSelectedData();
    const attrs = this._getAttrs(entityId);
    if (!file || file === 'unknown' || file === 'unavailable' || file === 'None' || file === '' || file === 'standby.png') {
      // Return configured standby path if present, else use protocol-appropriate standby under base
      if (this._config.standby_image_path) return this._config.standby_image_path;
      return `${this._getBaseImagePath()}/standby.png`;
    }

    // Prefer explicit artwork_dir from attributes, then collection, then artist_name; else fallback to filename prefix
    if (attrs && attrs.artwork_dir) {
      return `${this._getBaseImagePath()}/${encodeURIComponent(attrs.artwork_dir)}/${encodeURIComponent(file)}`;
    }
    if (attrs && attrs.collection) {
      return `${this._getBaseImagePath()}/${encodeURIComponent(attrs.collection)}/${encodeURIComponent(file)}`;
    }
    if (attrs && attrs.artist_name) {
      return `${this._getBaseImagePath()}/${encodeURIComponent(attrs.artist_name)}/${encodeURIComponent(file)}`;
    }
    const match = file.match(/^(.+?)_[^_]+_/);
    if (match) {
      const collection = match[1];
      return `${this._getBaseImagePath()}/${encodeURIComponent(collection)}/${encodeURIComponent(file)}`;
    }
    
    return null;
  }
  

  _render() {
    if (!this._hass) return;
    const { file } = this._getSelectedData();
    const normalizedFile = String(file || '').trim().toLowerCase();
    // in_art_mode is published by the uploader (false when TV leaves art mode).
    // Fall back to true when the attribute is absent (older uploader versions).
    const artworkAttrs = this._getAttrs(this._config.selected_artwork_file_entity);
    const inArtMode = artworkAttrs && artworkAttrs.in_art_mode !== undefined ? artworkAttrs.in_art_mode !== false : true;
    const selectedCollections = this._baselineSelected || this._getSelectedCollections();
    const options = this._getOptions(this._config.collections_entity).filter(opt => opt !== '@eaDir');
    const selectedOptions = options.filter(opt => selectedCollections.includes(opt)).sort();
    const unselectedOptions = options.filter(opt => !selectedCollections.includes(opt)).sort();
    const sortedOptions = [...selectedOptions, ...unselectedOptions];
    const artworkInfo = this._parseArtworkInfo(file);
    // While a refresh is in progress, force standby display regardless of HA state
    const standbyBgUrl = this._config.standby_image_path || `${this._getBaseImagePath()}/standby.png`;
    const bgUrl = this._refreshInProgress ? standbyBgUrl : this._getBackgroundUrl();
    const isNotInArtMode = !inArtMode;
    const isStandby = isNotInArtMode || this._refreshInProgress || !normalizedFile || normalizedFile === 'standby.png' || normalizedFile === 'unknown' || normalizedFile === 'unavailable' || normalizedFile === 'none';
    // Buttons should only be blocked when TV is truly not in Art Mode, not just because
    // no artwork has been selected yet (standby-like but in Art Mode).
    this._isStandbyLike = isNotInArtMode || this._refreshInProgress;
    this._isNotInArtMode = isNotInArtMode;
    const hasArtwork = bgUrl !== null;
    const isCompressed = (this._config.layout_mode || 'fixed') !== 'dynamic';
    const mqttConnected = !!(this._hass && this._config.settings_entity && this._hass.states[this._config.settings_entity] && this._hass.states[this._config.settings_entity].state !== 'unavailable');
    this._isFixed = isCompressed;

    // Initialize staged selection to baseline on render; keep staged if dropdown is open or apply is pending
    this._currentSelected = Array.isArray(this._currentSelected) && (this._dropdownOpen || this._applyPending)
      ? this._currentSelected
      : [...selectedCollections];

    const selectedText = this._currentSelected.length > 0 
      ? 'Selected: ' + this._currentSelected.join(', ')
      : 'Select collections...';

    // Initial placeholder - will be updated asynchronously by _updateArtworkText
    let artworkText = 'Loading...';

    // Update artwork text — skipped when refresh is in progress (progress msg shown instead)
    if (this._refreshInProgress) {
      setTimeout(() => {
        const infoEl = this.querySelector('.ftv-info');
        const logEl = this.querySelector('.ftv-refresh-log');
        if (infoEl) infoEl.innerHTML = '<div style="color:white">Refresh in progress…</div>';
        if (logEl) logEl.innerHTML = this._refreshProgressLog.map(l => this._logLineHtml(l)).join('');
      }, 0);
    } else {
      setTimeout(() => {
        this._updateArtworkText(file, file, isStandby);
      }, 100);
    }

    this.style.setProperty('--ha-card-border-radius', '21px');
    if (isNotInArtMode) this.style.setProperty('--ha-card-box-shadow', 'none');

    this.innerHTML = `
      <ha-card>
        <style>
          ha-card {
            overflow: visible;
          }
          .ftv-card {
            padding: 12px;
            position: relative;
            border-radius: 21px;
            ${isCompressed && !isNotInArtMode ? 'aspect-ratio: 16/9; display: flex; flex-direction: column; box-sizing: border-box;' : ''}
            ${isNotInArtMode ? '' : hasArtwork ? `background: linear-gradient(rgba(0,0,0,0.1), rgba(0,0,0,0.1)), url("${bgUrl}"); background-size: cover; background-position: center;` : ''}
          }
          .ftv-header {
            ${isNotInArtMode ? `
            display: grid;
            grid-template-areas: "i n" "i l";
            grid-template-columns: min-content auto;
            grid-template-rows: min-content min-content;
            padding: 0;
            ` : `
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 0;
            margin-bottom: 12px;
            ${hasArtwork ? 'color: white;' : ''}
            `}
          }
          .ftv-title-wrap {
            display: flex;
            flex-direction: column;
            line-height: 1.3;
          }
          .ftv-title-wrap > span {
            font-size: 14px;
            font-weight: bold;
            color: var(--primary-text-color);
          }
          .ftv-name {
            grid-area: n;
            font-size: 1em;
            font-weight: 500;
            color: var(--primary-text-color);
            align-self: end;
            justify-self: start;
            margin-left: 6px;
            margin-bottom: 2px;
            line-height: 1.1;
          }
          .ftv-subtitle {
            grid-area: l;
            font-size: 0.85em;
            font-weight: bolder;
            filter: opacity(40%);
            align-self: start;
            justify-self: start;
            margin-left: 6px;
            margin-top: 0px;
            line-height: 1.1;
          }
          .ftv-header .spacer { flex: 1; }
          .ftv-gear {
            margin-left: auto;
            background: transparent;
            border: none;
            cursor: pointer;
            color: inherit;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 32px; height: 32px;
            border-radius: 6px;
          }
          .ftv-gear:hover { background: rgba(255,255,255,0.12); }
          .ftv-icon-wrap {
            width: 42px;
            height: 42px;
            border-radius: 50%;
            background: ${isNotInArtMode ? 'rgba(var(--color-theme),0.05)' : 'rgba(var(--rgb-primary-color, 3, 169, 244), 0.2)'};
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            ${isNotInArtMode ? 'grid-area: i; place-self: center;' : ''}
          }
          .ftv-icon-wrap ha-icon {
            --mdc-icon-size: 24px;
            color: ${isNotInArtMode ? 'rgba(var(--color-theme),0.2)' : 'var(--primary-color, #03a9f4)'};
          }
          .ftv-controls {
            border-radius: 8px;
            margin-bottom: 8px;
            ${hasArtwork ? 'color: white;' : ''}
          }
          .ftv-row {
            display: flex;
            gap: 8px;
          }
          .ftv-dropdown-wrap {
            flex: 1;
            position: relative;
            min-width: 0;
          }
          .ftv-trigger {
            width: 100%;
            padding: 10px 12px;
            border-radius: 8px;
            border: 1px solid rgba(255,255,255,0.3);
            background: ${hasArtwork ? 'rgba(0,0,0,0.5)' : 'var(--input-fill-color, #f5f5f5)'};
            color: inherit;
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
            box-sizing: border-box;
          }
          .ftv-trigger:hover {
            border-color: var(--primary-color, #03a9f4);
          }
          .ftv-trigger-text {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            flex: 1;
          }
          .ftv-trigger-arrow {
            margin-left: 8px;
            transition: transform 0.2s;
          }
          .ftv-trigger.open .ftv-trigger-arrow {
            transform: rotate(180deg);
          }
          .ftv-dropdown {
            display: none;
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            margin-top: 4px;
            background: rgba(30,30,30,0.95);
            border: 1px solid var(--divider-color, #ccc);
            border-radius: 8px;
            max-height: 250px;
            overflow-y: auto;
            z-index: 9999;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            color: white;
          }
          .ftv-controls {
            position: relative;
          }
          .ftv-dropdown.open {
            display: block;
          }
          .ftv-option {
            display: flex;
            align-items: center;
            padding: 10px 12px;
            cursor: pointer;
            gap: 10px;
          }
          .ftv-option:hover {
            background: rgba(3, 169, 244, 0.1);
          }
          .ftv-option.selected {
            background: rgba(3, 169, 244, 0.15);
          }
          .ftv-checkbox {
            width: 20px;
            height: 20px;
            border: 2px solid #ccc;
            border-radius: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .ftv-option.selected .ftv-checkbox {
            background: var(--primary-color, #03a9f4);
            border-color: var(--primary-color, #03a9f4);
          }
          .ftv-checkbox svg {
            width: 14px;
            height: 14px;
            fill: white;
            opacity: 0;
          }
          .ftv-option.selected .ftv-checkbox svg {
            opacity: 1;
          }
          .ftv-option-all {
            border-bottom: 1px solid rgba(255,255,255,0.12);
            font-weight: 600;
          }
          .ftv-clear {
            width: 40px;
            height: 40px;
            border: none;
            border-radius: 8px;
            background: #db4437;
            color: white;
            cursor: pointer;
            display: ${selectedCollections.length > 0 ? 'flex' : 'none'};
            align-items: center;
            justify-content: center;
          }
          .ftv-progress-wrap {
            ${hasArtwork ? 'background: rgba(0,0,0,0.55); border-radius: 8px; transition: background 0.25s;' : ''}
            ${isCompressed ? 'flex: 1; min-height: 0; position: relative;' : (hasArtwork ? 'overflow: hidden;' : '')}
            ${isStandby ? 'display: flex; flex-direction: column; overflow-y: hidden; padding-bottom: 8px;' : isCompressed ? 'overflow-y: auto; padding-bottom: 8px;' : ''}
          }
          .ftv-info {
            display: block;
            width: 100%;
            box-sizing: border-box;
            padding: 12px;
            ${isStandby ? 'flex: 0 0 auto;' : ''}
            ${hasArtwork ? 'color: white;' : ''}
          }
          .ftv-refresh-log {
            font-size: 0.85em;
            line-height: 1.6;
            ${isStandby ? 'flex: 1; min-height: 0; max-height: none;' : 'max-height: 200px;'}
            overflow-y: auto;
            ${hasArtwork ? 'padding: 0 12px 10px;' : ''}
          }
          .ftv-refresh-log:empty { display: none; }
          ${isCompressed ? `
          .ftv-info-fade {
            display: none;
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            height: 48px;
            background: linear-gradient(to bottom, transparent, ${hasArtwork && !isNotInArtMode ? 'rgba(0,0,0,0.85)' : 'var(--ha-card-background-color, var(--card-background-color, #fff))'});
            pointer-events: none;
          }` : ''}
          .ftv-status {
            margin-top: 0;
            min-height: 0;
            font-size: 0.85em;
            color: ${hasArtwork ? 'rgba(255,255,255,0.6)' : 'var(--secondary-text-color)'};
          }
          .ftv-apply {
            width: 40px;
            height: 40px;
            border: none;
            border-radius: 8px;
            background: var(--primary-color, #03a9f4);
            color: white;
            cursor: pointer;
            display: none;
            align-items: center;
            justify-content: center;
          }
          .ftv-apply[disabled] {
            opacity: 0.5;
            cursor: default;
          }
        </style>
        <div class="ftv-card">
          <div class="ftv-header">
            <div class="ftv-icon-wrap">
              <ha-icon icon="${this._config.icon}"></ha-icon>
            </div>
            ${isNotInArtMode ? `
            <span class="ftv-name">${this._config.title}</span>
            <span class="ftv-subtitle">TV is not in art mode</span>
            ` : `
            <div class="ftv-title-wrap">
              <span>${this._config.title}</span>
            </div>
            <span class="spacer"></span>
            <button class="ftv-gear" id="ftv-gear" title="${this._config.web_ui_url ? 'Open Samsung TV Art Uploader' : 'Settings (configure web_ui_url to enable)'}">
              <ha-icon icon="mdi:cog"></ha-icon>
            </button>
            `}
          </div>
          ${isNotInArtMode ? `` : `
          <div class="ftv-controls">
            <div class="ftv-row">
                <div class="ftv-dropdown-wrap">
                  <div class="ftv-trigger" id="ftv-trigger">
                    <span class="ftv-trigger-text">${selectedText}</span>
                    <span class="ftv-trigger-arrow">▼</span>
                  </div>
                  <div class="ftv-dropdown" id="ftv-dropdown">
                    <div class="ftv-option ftv-option-all ${sortedOptions.length > 0 && sortedOptions.every(o => this._currentSelected.includes(o)) ? 'selected' : ''}" data-value="__select_all__">
                      <div class="ftv-checkbox">
                        <svg viewBox="0 0 24 24"><path d="M9,20.42L2.79,14.21L5.62,11.38L9,14.77L18.88,4.88L21.71,7.71L9,20.42Z"/></svg>
                      </div>
                      <span>Select All</span>
                    </div>
                    ${sortedOptions.map(opt => `
                      <div class="ftv-option ${this._currentSelected.includes(opt) ? 'selected' : ''}" data-value="${opt}">
                        <div class="ftv-checkbox">
                          <svg viewBox="0 0 24 24"><path d="M9,20.42L2.79,14.21L5.62,11.38L9,14.77L18.88,4.88L21.71,7.71L9,20.42Z"/></svg>
                        </div>
                        <span>${opt}</span>
                      </div>
                    `).join('')}
                  </div>
                </div>
                <button class="ftv-apply" id="ftv-apply" title="Apply selections">
                  <ha-icon icon="mdi:check"></ha-icon>
                </button>
                <button class="ftv-clear" id="ftv-clear">
                  <ha-icon icon="mdi:delete"></ha-icon>
                </button>
              </div>
              <div class="ftv-status" id="ftv-status">${this._statusMessage || ''}</div>
          </div>
          `}
          ${isNotInArtMode ? '' : `
          <div class="ftv-progress-wrap">
            <div class="ftv-info">${artworkText}</div>
            <div class="ftv-refresh-log"></div>
            ${isCompressed ? '<div class="ftv-info-fade"></div>' : ''}
          </div>
          `}
        </div>
      </ha-card>
    `;
    const gear = this.querySelector('#ftv-gear');
    const statusEl = this.querySelector('#ftv-status');
    const setStatus = (msg = '', timeoutMs = 6000) => {
      this._statusMessage = msg || '';
      if (statusEl) statusEl.textContent = this._statusMessage;
      if (timeoutMs > 0 && msg) {
        setTimeout(() => {
          if (this._statusMessage === msg) {
            this._statusMessage = '';
            if (statusEl) statusEl.textContent = '';
          }
        }, timeoutMs);
      }
    };
    this._setStatus = setStatus;
    this._syncRefreshAckStatus();
    // Info expand — tap progress-wrap to open floating overlay (fixed mode, only when content overflows)
    if (this._isFixed) {
      const progressWrap = this.querySelector('.ftv-progress-wrap');
      if (progressWrap) {
        progressWrap.addEventListener('click', () => {
          if (progressWrap.dataset.overflows) this._showInfoOverlay();
        });
      }
    }
    if (gear) {
      gear.addEventListener('click', (e) => {
        e.stopPropagation();
        const url = this._config.web_ui_url;
        if (!url) {
          if (setStatus) setStatus('Set web_ui_url in card config to open the web UI', 6000);
          // eslint-disable-next-line no-console
          console.warn('[frame-tv-art-card] No web_ui_url configured; cog click ignored.');
          return;
        }
        window.open(url, '_blank', 'noopener,noreferrer');
      });
    }

    // Event handlers — only exist when in art mode
    const trigger = this.querySelector('#ftv-trigger');
    const dropdown = this.querySelector('#ftv-dropdown');
    const dropdownWrap = this.querySelector('.ftv-dropdown-wrap');

    if (trigger && dropdown) {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      this._dropdownOpen = !this._dropdownOpen;
      trigger.classList.toggle('open', this._dropdownOpen);
      dropdown.classList.toggle('open', this._dropdownOpen);
    });

    this.querySelectorAll('.ftv-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = opt.dataset.value;
        if (val === '__select_all__') {
          const allOptEls = Array.from(this.querySelectorAll('.ftv-option:not(.ftv-option-all)'));
          const allVals = allOptEls.map(o => o.dataset.value);
          const allSel = allVals.length > 0 && allVals.every(v => this._currentSelected.includes(v));
          this._currentSelected = allSel ? [] : [...allVals];
          allOptEls.forEach(o => o.classList.toggle('selected', this._currentSelected.includes(o.dataset.value)));
          opt.classList.toggle('selected', !allSel);
          const triggerText = this.querySelector('.ftv-trigger-text');
          if (triggerText) {
            triggerText.textContent = this._currentSelected.length > 0
              ? 'Selected: ' + this._currentSelected.join(', ')
              : 'Select collections...';
          }
          const clearBtn = this.querySelector('#ftv-clear');
          if (clearBtn) clearBtn.style.display = this._currentSelected.length > 0 ? 'flex' : 'none';
          const applyBtn = this.querySelector('#ftv-apply');
          const changed = !this._arraysEqual(this._currentSelected, this._baselineSelected);
          if (applyBtn) {
            const applyDisabled = !changed || this._currentSelected.length === 0;
            applyBtn.style.display = changed ? 'flex' : 'none';
            applyBtn.disabled = applyDisabled;
            applyBtn.style.opacity = applyDisabled ? '0.5' : '';
          }
          return;
        }
        const wasSelected = this._currentSelected.includes(val);
        if (wasSelected) {
          this._currentSelected = this._currentSelected.filter(s => s !== val);
        } else {
          this._currentSelected.push(val);
        }
        opt.classList.toggle('selected', !wasSelected);
        // Keep "Select All" row in sync
        const allOptEls = Array.from(this.querySelectorAll('.ftv-option:not(.ftv-option-all)'));
        const allNowSelected = allOptEls.length > 0 && allOptEls.every(o => o.classList.contains('selected'));
        const selectAllEl = this.querySelector('.ftv-option-all');
        if (selectAllEl) selectAllEl.classList.toggle('selected', allNowSelected);
        // Update trigger text
        const triggerText = this.querySelector('.ftv-trigger-text');
        if (triggerText) {
          triggerText.textContent = this._currentSelected.length > 0 
            ? 'Selected: ' + this._currentSelected.join(', ')
            : 'Select collections...';
        }
        // Toggle clear button visibility dynamically
        const clearBtn = this.querySelector('#ftv-clear');
        if (clearBtn) clearBtn.style.display = this._currentSelected.length > 0 ? 'flex' : 'none';
        // Toggle apply based on diff from baseline
        const applyBtn = this.querySelector('#ftv-apply');
        const changed = !this._arraysEqual(this._currentSelected, this._baselineSelected);
        if (applyBtn) {
          const applyDisabled = !changed || this._currentSelected.length === 0;
          applyBtn.style.display = changed ? 'flex' : 'none';
          applyBtn.disabled = applyDisabled;
          applyBtn.style.opacity = applyDisabled ? '0.5' : '';
        }
      });
    });

    const clearBtnEl = this.querySelector('#ftv-clear');
    if (clearBtnEl) clearBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this._refreshInProgress) return;
      // Stage-only clear; apply must be clicked to publish
      this._currentSelected = [];
      const triggerText = this.querySelector('.ftv-trigger-text');
      if (triggerText) triggerText.textContent = 'Select collections...';
      const clearBtn = this.querySelector('#ftv-clear');
      if (clearBtn) clearBtn.style.display = 'none';
      const applyBtn = this.querySelector('#ftv-apply');
      if (applyBtn) {
        const changed = !this._arraysEqual(this._currentSelected, this._baselineSelected);
        const applyDisabled = !changed || this._currentSelected.length === 0;
        applyBtn.style.display = changed ? 'flex' : 'none';
        applyBtn.disabled = applyDisabled;
        applyBtn.style.opacity = applyDisabled ? '0.5' : '';
      }
      this.querySelectorAll('.ftv-option.selected').forEach(o => o.classList.remove('selected'));
    });

    // Apply button publishes staged selections in one update
    const applyBtn = this.querySelector('#ftv-apply');
    if (applyBtn) {
      const changed = !this._arraysEqual(this._currentSelected, this._baselineSelected);
      const applyDisabled = !changed || this._currentSelected.length === 0;
      applyBtn.style.display = changed ? 'flex' : 'none';
      applyBtn.disabled = applyDisabled;
      applyBtn.style.opacity = applyDisabled ? '0.5' : '';
      applyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!this._hass) return;
        const topic = 'frame_tv/cmd/collections/set';
        const payload = { collections: this._currentSelected.slice(), req_id: Date.now() };
        this._hass.callService('mqtt', 'publish', { topic, payload: JSON.stringify(payload) });
        // Optimistically align baseline to staged and block HA state from resetting it
        // until HA confirms the new selection (or the 10s safety timeout fires).
        this._baselineSelected = this._currentSelected.slice();
        this._applyPending = true;
        if (this._applyPendingTimer) clearTimeout(this._applyPendingTimer);
        this._applyPendingTimer = setTimeout(() => {
          this._applyPending = false;
          this._applyPendingTimer = null;
        }, 10000);
        applyBtn.style.display = 'none';
        applyBtn.disabled = true;
      });
    }
    } // end if (trigger && dropdown)

    // Reverted: keep default sizing behavior (background-size: cover) without dynamic min-height



      }

  _trySetBackground(el, urls) {
      if (!urls || urls.length === 0) return;
      const tryNext = (i) => {
        if (i >= urls.length) return;
        const url = urls[i];
        const img = new Image();
        img.onload = () => {
          el.style.background = `linear-gradient(rgba(0,0,0,0.1), rgba(0,0,0,0.1)), url("${url}")`;
          el.style.backgroundSize = 'cover';
          el.style.backgroundPosition = 'center';
        };
        img.onerror = () => tryNext(i+1);
        img.src = url;
      };
      tryNext(0);
    }
  }

console.info('%c FRAME-TV-ART-CARD %c v0.3.1 ', 'color: white; background: #03a9f4; font-weight: bold;', '');

// Register custom element so Lovelace can use <frame-tv-art-card>
try {
  if (!customElements.get('frame-tv-art-card')) {
    customElements.define('frame-tv-art-card', FrameTVArtCard);
  }
} catch (e) {
  console.warn('Failed to register frame-tv-art-card:', e);
}
