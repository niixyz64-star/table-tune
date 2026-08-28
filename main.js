const { Plugin } = require('obsidian');

module.exports = class TableColumnResize extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    // Data shape:
    //   { widths:     { [notePath]: { [tableId]: [px,...] } },
    //     rowHeights: { [notePath]: { [tableId]: [px|null,...] } } }
    // Legacy shapes (per-note flat arrays, and the old widths-only map) are
    // migrated lazily on first enhance of each table.
    if (data && data.widths !== undefined) {
      this.widths = data.widths || {};
      this.rowHeights = data.rowHeights || {};
    } else {
      this.widths = data || {};
      this.rowHeights = {};
    }
    this._resizeRaf = 0;
    this._editRaf = 0;

    // READING VIEW: post processor applies stored widths + a full-pane wrap
    // (scrollable), but NO drag handles (resizing is edit-mode only).
    this.registerMarkdownPostProcessor((el, ctx) => {
      el.querySelectorAll('table').forEach((table) => this.enhance(table, ctx, false));
    });

    this.registerEvent(this.app.workspace.on('file-open', () => {
      this.processActive();
      this.scanEdit();
    }));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
      setTimeout(() => { this.processActive(); this.scanEdit(); this.reflow(); }, 80);
    }));

    // Both modes render tables as real <table> nodes we must keep in sync.
    // Observe the whole document: when the editor (Live Preview, .cm-content)
    // OR the reading view (.markdown-preview-view) appears or mutates — e.g. on
    // a mode toggle within the same note — re-enhance so widths are applied
    // immediately. (Toggling edit/reading does NOT fire file-open / leaf-change,
    // which is why this observer is required for the "switch and it refreshes"
    // behavior.)
    this._mo = new MutationObserver(() => {
      if (this._editRaf) return;
      this._editRaf = requestAnimationFrame(() => {
        this._editRaf = 0;
        this.scanEdit();
        this.processActive();
      });
    });
    this._mo.observe(document.body, { childList: true, subtree: true });

    this._onResize = () => {
      if (this._resizeRaf) return;
      this._resizeRaf = requestAnimationFrame(() => {
        this._resizeRaf = 0;
        this.reflow();
      });
    };
    window.addEventListener('resize', this._onResize);
  }

  onunload() {
    if (this._mo) this._mo.disconnect();
    if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
    document.querySelectorAll('table[data-tcr]').forEach((t) => {
      t.querySelectorAll('.tcr-handle, .tcr-row-handle').forEach((h) => h.remove());
      const wrapper = t.parentElement;
      if (wrapper && wrapper.classList.contains('tcr-wrap')) {
        const view = wrapper.closest('.markdown-preview-view');
        wrapper.parentNode.insertBefore(t, wrapper);
        wrapper.remove();
        // Remove the tcr-has-wrap marker from ancestors up to the view, but
        // only where no tcr-wrap remains in that subtree.
        const chain = [];
        let anc = t.parentElement;
        while (anc && anc !== view) { chain.push(anc); anc = anc.parentElement; }
        if (view) chain.push(view);
        chain.forEach((el) => {
          if (el && el.classList.contains('tcr-has-wrap') && !el.querySelector('.tcr-wrap')) {
            el.classList.remove('tcr-has-wrap');
          }
        });
      }
      delete t.dataset.tcr;
    });
  }

  processActive() {
    const file = this.app.workspace.getActiveFile();
    const path = file ? file.path : 'unknown';
    document
      .querySelectorAll('.markdown-preview-view table')
      .forEach((table) => this.enhance(table, { sourcePath: path }, false));
  }

  scanEdit() {
    const file = this.app.workspace.getActiveFile();
    const path = file ? file.path : 'unknown';
    document
      .querySelectorAll('.cm-content table')
      .forEach((table) => this.enhance(table, { sourcePath: path }, true));
  }

  // ---- per-table identity ------------------------------------------------
  // Tables are keyed by a stable id derived from their header row, so a note
  // with several tables remembers each table's widths/heights independently
  // (the old per-note single array made tables overwrite each other).
  // Base identity from the header row (stable across edit/reading renders).
  baseTableId(table) {
    const cells = table.querySelectorAll('thead th, thead td');
    let key = '';
    for (const c of cells) key += (c.textContent || '').trim() + '\u0001';
    let h = 5381;
    for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
    return 't' + (h >>> 0).toString(36);
  }

  // Stable per-table id within a note. Tables with identical headers get
  // "t<base>", "t<base>#2", ... in document order so they stay independent
  // instead of sharing (and fighting over) one width entry.
  tableId(table) {
    const base = this.baseTableId(table);
    const container =
      table.closest('.markdown-preview-section, .cm-content, .markdown-rendered') ||
      table.parentElement;
    const all = container ? Array.from(container.querySelectorAll('table')) : [table];
    const idx = all.indexOf(table);
    let n = 0;
    for (let i = 0; i <= idx && i < all.length; i++) {
      if (this.baseTableId(all[i]) === base) n++;
    }
    return n > 1 ? base + '#' + n : base;
  }

  // Ensure a note's store is a { tableId: [...] } map (not a legacy flat array).
  normalizeStore(store) {
    if (Array.isArray(store)) return { __legacy: store };
    return store;
  }

  // Read saved widths for one table. Adopts the legacy per-note array when it
  // is the first table in the note whose column count matches.
  getWidths(path, tid, n) {
    if (!this.widths[path]) return undefined;
    this.widths[path] = this.normalizeStore(this.widths[path]);
    const store = this.widths[path];
    if (store[tid]) return store[tid];
    if (store.__legacy && store.__legacy.length === n) {
      const arr = store.__legacy;
      delete store.__legacy;
      store[tid] = arr;
      return arr;
    }
    return undefined;
  }

  setWidths(path, tid, arr) {
    if (!this.widths[path]) this.widths[path] = {};
    this.widths[path][tid] = arr;
  }

  // Read saved row heights for one table (adopts legacy per-note array on the
  // first table of the note that asks for it).
  getRowHeights(path, tid) {
    if (!this.rowHeights[path]) return undefined;
    this.rowHeights[path] = this.normalizeStore(this.rowHeights[path]);
    const store = this.rowHeights[path];
    if (store[tid]) return store[tid];
    if (store.__legacy) {
      const arr = store.__legacy;
      delete store.__legacy;
      store[tid] = arr;
      return arr;
    }
    return undefined;
  }

  setRowHeights(path, tid, arr) {
    if (!this.rowHeights[path]) this.rowHeights[path] = {};
    this.rowHeights[path][tid] = arr;
  }


  toPx(raw, tablePx) {
    if (!raw) return null;
    if (raw.endsWith('px')) return parseFloat(raw);
    if (raw.endsWith('%')) return (parseFloat(raw) / 100) * tablePx;
    return null;
  }

  // Table width = sum of its column widths (so resizing one column grows the
  // table instead of stealing space from neighbours).
  syncTableWidth(table, colgroup) {
    let sum = 0;
    let ok = true;
    for (const c of colgroup.children) {
      const w = parseFloat(c.style.width);
      if (isNaN(w)) { ok = false; break; }
      sum += w;
    }
    if (ok && sum > 0) table.style.width = Math.round(sum) + 'px';
  }

  // Always left-align the table at the wrapper's left edge (requirement:
  // the table must sit at the leftmost in reading mode). No centering, even
  // when the table is narrower than the wrapper.
  alignTableLeft(table) {
    table.style.marginLeft = '0';
    table.style.marginRight = '0';
  }

  // Persist column widths AND row heights together as one data object.
  persist() {
    this.saveData({ widths: this.widths, rowHeights: this.rowHeights });
  }

  // Apply stored row heights (Reading mirrors Edit; re-renders keep them).
  applyRowHeights(table, path, tid) {
    const rows = table.querySelectorAll('tr');
    const rowSaved = this.getRowHeights(path, tid);
    if (!rowSaved) return;
    rows.forEach((tr, i) => {
      const h = rowSaved[i];
      if (h && parseFloat(h) > 0) tr.style.height = h;
    });
  }

  // Ensure a colgroup with one <col> per header column exists.
  ensureColgroup(table, n) {
    let colgroup = table.querySelector('colgroup');
    if (!colgroup) {
      colgroup = document.createElement('colgroup');
      table.prepend(colgroup);
    }
    while (colgroup.children.length < n) colgroup.appendChild(document.createElement('col'));
    return colgroup;
  }

  // Apply saved (or freshly computed default) column widths to a table.
  applyWidths(table, colgroup, path, tid, preview) {
    const headCols = table.querySelectorAll('thead th, thead td');
    const n = headCols.length;
    const saved = this.getWidths(path, tid, n);
    let appliedDefault = false;
    if (saved && saved.length === n) {
      const tablePx = table.getBoundingClientRect().width || 1;
      for (let i = 0; i < n; i++) {
        const px = this.toPx(saved[i], tablePx);
        colgroup.children[i].style.width = (px && px > 0 ? Math.round(px) : 80) + 'px';
      }
    } else {
      // No stored widths yet: fit each column to its content (capped) so wide,
      // text-heavy tables are readable without manual dragging. This also
      // avoids the old equal-split default persisting tiny "40px" values when
      // the table had not laid out yet (a table hidden/loading reports width 0,
      // which used to produce min-width defaults that clobbered real ones).
      const fit = this.autoFitWidths(table, n);
      for (let i = 0; i < n; i++) colgroup.children[i].style.width = fit[i] + 'px';
      appliedDefault = true;
    }
    this.syncTableWidth(table, colgroup);
    // Persist the freshly computed default so the other mode mirrors it
    // exactly (Reading column widths == Edit column widths). Only this
    // table's entry is touched; other tables in the note keep their own.
    if (appliedDefault) {
      const arr = [];
      for (const c of colgroup.children) arr.push(c.style.width || '');
      this.setWidths(path, tid, arr);
      this.persist();
    }
    return n;
  }

  // Content-aware default column widths: each column is sized to fit its
  // longest line of text (per cell, including <br>-separated lines), capped so
  // one huge paragraph cannot blow the table up to a silly width. Used only
  // when a table has no saved widths.
  autoFitWidths(table, n) {
    const MIN = 80;
    const CAP = 460;
    const ctxCache = new Map();
    const ctxFor = (font) => {
      if (!ctxCache.has(font)) {
        const c = document.createElement('canvas');
        c.width = 4096;
        c.height = 64;
        ctxCache.set(font, c.getContext('2d'));
      }
      return ctxCache.get(font);
    };
    const cellLines = (cell) => {
      const clone = cell.cloneNode(true);
      clone.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
      return (clone.textContent || '').split('\n');
    };
    const cellNatural = (cell) => {
      const cs = getComputedStyle(cell);
      const font = cs.font || (cs.fontSize + ' ' + cs.fontFamily);
      const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + 2;
      const ctx = ctxFor(font);
      ctx.font = font;
      let w = 0;
      for (const ln of cellLines(cell)) w = Math.max(w, ctx.measureText(ln).width);
      return w + pad;
    };
    const colIndex = (cell) => {
      const row = cell.parentElement;
      if (!row) return -1;
      const kids = row.children;
      for (let i = 0; i < kids.length; i++) if (kids[i] === cell) return i;
      return -1;
    };
    const widths = new Array(n).fill(0);
    for (const cell of table.querySelectorAll('th, td')) {
      const ci = colIndex(cell);
      if (ci < 0 || ci >= n) continue;
      widths[ci] = Math.max(widths[ci], cellNatural(cell));
    }
    for (let i = 0; i < n; i++) {
      widths[i] = Math.max(MIN, Math.min(Math.round(widths[i]), CAP));
    }
    return widths;
  }

  reflowTable(table) {
    const file = this.app.workspace.getActiveFile();
    const path = (file ? file.path : 'unknown');
    const preview = table.closest('.markdown-preview-view');
    const allowDrag = !preview; // edit (Live Preview) => drag handles
    const headCols = table.querySelectorAll('thead th, thead td');
    const n = headCols.length;
    if (!n) return;
    const tid = this.tableId(table);

    // Live Preview (and other renderers) may wipe our <col> widths / handles on
    // re-render. Re-apply the stored widths, and rebuild anything missing, so the
    // table always matches the saved state (and therefore matches Reading view).
    const colgroup = this.ensureColgroup(table, n);
    this.applyWidths(table, colgroup, path, tid, preview);
    this.applyRowHeights(table, path, tid);

    // Re-add drag handles in edit mode if Live Preview dropped them.
    if (allowDrag) {
      headCols.forEach((th, i) => {
        if (th.querySelector('.tcr-handle')) return;
        th.style.position = 'relative';
        const handle = document.createElement('div');
        handle.className = 'tcr-handle';
        handle.addEventListener('pointerdown', (e) => this.startDrag(e, colgroup, i, path, tid));
        th.appendChild(handle);
      });
      // Row-resize handles on the leftmost cell of every row.
      const rows = table.querySelectorAll('tr');
      rows.forEach((tr, i) => {
        const firstCell = tr.querySelector('th:first-child, td:first-child');
        if (!firstCell) return;
        firstCell.style.position = 'relative';
        if (firstCell.querySelector('.tcr-row-handle')) return;
        const rh = document.createElement('div');
        rh.className = 'tcr-row-handle';
        rh.addEventListener('pointerdown', (e) => this.startRowDrag(e, tr, i, path, tid));
        firstCell.appendChild(rh);
      });
    }

    // Reading: keep the wrap at the full pane width (no centering clip) and
    // left-align the table. The view clips horizontally (.tcr-has-wrap), and
    // every ancestor between wrap and view is left overflow:visible, so the
    // wrap is the SOLE horizontal scroll container (one scrollbar, full width).
    if (preview) {
      // Reading: wrap the table in its own horizontal scroll container. The
      // wrap fills its natural containing block (works in any Obsidian
      // version/theme, centered or full-width), so it never overflows an
      // ancestor and the table can never be clipped/cut. Wide tables scroll
      // inside the wrap only (one scrollbar, no view-level scrollbar).
      let wrapper = table.parentElement;
      if (!wrapper || !wrapper.classList.contains('tcr-wrap')) {
        wrapper = document.createElement('div');
        wrapper.className = 'tcr-wrap';
        table.parentNode.insertBefore(wrapper, table);
        wrapper.appendChild(table);
      }
      this.markWrapChain(wrapper, preview);
      this.alignTableLeft(table);
    }
  }

  // Add .tcr-has-wrap to the view and every ancestor of the wrap up to it, so
  // CSS can clip only at the scroll container and keep the chain un-clipped.
  markWrapChain(wrapper, preview) {
    let anc = wrapper.parentElement;
    while (anc && anc !== preview) {
      anc.classList.add('tcr-has-wrap');
      anc = anc.parentElement;
    }
    if (preview) preview.classList.add('tcr-has-wrap');
  }

  reflow() {
    document.querySelectorAll('table[data-tcr]').forEach((t) => this.reflowTable(t));
  }

  enhance(table, ctx, allowDrag) {
    if (table.dataset.tcr) { this.reflowTable(table); return; }

    const path =
      (ctx && ctx.sourcePath) ||
      (this.app.workspace.getActiveFile() && this.app.workspace.getActiveFile().path) ||
      'unknown';
    const preview = table.closest('.markdown-preview-view');
    const headCols = table.querySelectorAll('thead th, thead td');
    const n = headCols.length;
    if (!n) return;
    const tid = this.tableId(table);

    table.dataset.tcr = '1';
    table.style.tableLayout = 'fixed';
    table.style.maxWidth = 'none';

    const colgroup = this.ensureColgroup(table, n);
    this.applyWidths(table, colgroup, path, tid, preview);
    this.applyRowHeights(table, path, tid);

    if (preview) {
      // Reading: wrap the table in its own horizontal scroll container (see
      // reflowTable). The wrap fills its containing block — no breakout, no
      // geometry assumptions — so it is robust across vaults/themes and the
      // table is never clipped or cut.
      const wrapper = document.createElement('div');
      wrapper.className = 'tcr-wrap';
      table.parentNode.insertBefore(wrapper, table);
      wrapper.appendChild(table);
      this.markWrapChain(wrapper, preview);
      this.alignTableLeft(table);
    }
    // Edit mode: no wrap — the editor's own horizontal scroll handles overflow.

    // Drag handles ONLY in edit mode (requirement: resize is edit-mode only).
    if (allowDrag) {
      // Column handles on EVERY cell of each column: dragging the right edge of
      // any cell (header or body) resizes the whole column.
      const rows = table.querySelectorAll('tr');
      rows.forEach((tr) => {
        const cells = tr.querySelectorAll('th, td');
        cells.forEach((cell, i) => {
          if (i >= n) return; // safety: more cells than header columns
          if (cell.querySelector('.tcr-handle')) return;
          cell.style.position = 'relative';
          const handle = document.createElement('div');
          handle.className = 'tcr-handle';
          handle.addEventListener('pointerdown', (e) => this.startDrag(e, colgroup, i, path, tid));
          cell.appendChild(handle);
        });
      });
      // Row handles on EVERY cell of each row: dragging the bottom edge of any
      // cell resizes the whole row.
      rows.forEach((tr, i) => {
        const cells = tr.querySelectorAll('th, td');
        cells.forEach((cell) => {
          if (cell.querySelector('.tcr-row-handle')) return;
          cell.style.position = 'relative';
          const rh = document.createElement('div');
          rh.className = 'tcr-row-handle';
          rh.addEventListener('pointerdown', (e) => this.startRowDrag(e, tr, i, path, tid));
          cell.appendChild(rh);
        });
      });
    }
  }

  startDrag(e, colgroup, i, key, tid) {
    e.preventDefault();
    e.stopPropagation();
    const col = colgroup.children[i];
    const table = col.closest('table');
    const wrapper = table.parentElement;
    const startX = e.clientX;
    const startW = col.getBoundingClientRect().width;
    const updateStore = () => {
      const arr = [];
      for (const c of colgroup.children) arr.push(c.style.width || '');
      this.setWidths(key, tid, arr);
    };
    const onMove = (ev) => {
      const w = Math.max(40, startW + (ev.clientX - startX));
      col.style.width = w + 'px';
      this.syncTableWidth(table, colgroup);
      // Keep the in-memory store current on every move so Reading view (and any
      // Live Preview re-render) always reflects the latest width immediately.
      updateStore();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      updateStore();
      this.persist();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // Row-resize: drag the bottom edge of the leftmost cell of a row to change
  // that row's height. Edit-mode only (mirrors into Reading via this.rowHeights).
  startRowDrag(e, tr, rowIndex, key, tid) {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startH = parseFloat(tr.style.height) || tr.getBoundingClientRect().height;
    const prev = this.getRowHeights(key, tid) || [];
    const arr = prev.slice();
    let lastY = startY;
    const apply = (h) => {
      tr.style.height = h + 'px';
      arr[rowIndex] = Math.round(h) + 'px';
      // In-memory store updated every move so Live Preview re-renders and
      // Reading view both reflect the new height immediately.
      this.setRowHeights(key, tid, arr.slice());
    };
    const onMove = (ev) => {
      lastY = ev.clientY;
      const h = Math.max(24, startH + (ev.clientY - startY));
      apply(h);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const h = Math.max(24, startH + (lastY - startY));
      apply(h);
      this.persist();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }
};












