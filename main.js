const { Plugin, MarkdownView, Notice, setIcon } = require('obsidian');

module.exports = class TableColumnResize extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    // Data shape:
    //   { widths:     { [notePath]: { [tableId]: [px,...] } },
    //     rowHeights: { [notePath]: { [tableId]: [px|null,...] } },
    //     merges:     { [notePath]: { [tableId]: [{r,c,rowspan,colspan},...] } } }
    // Legacy shapes (per-note flat arrays, and the old widths-only map) are
    // migrated lazily on first enhance of each table.
    if (data && data.widths !== undefined) {
      this.widths = data.widths || {};
      this.rowHeights = data.rowHeights || {};
      this.merges = data.merges || {};
      this.tableDims = data.tableDims || {};
    } else {
      this.widths = data || {};
      this.rowHeights = {};
      this.merges = {};
      this.tableDims = {};
    }
    this._resizeRaf = 0;
    this.alignments = data.alignments || {};
    this._editRaf = 0;
    this.installTableHistory();

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

    this.addCommand({
      id: 'merge-selected-cells',
      name: 'Merge selected cells',
      callback: () => this.mergeSelectedCells(),
    });
    this.addCommand({
      id: 'split-cell',
      name: 'Split merged cell',
      callback: () => this.splitSelectedCell(),
    });
    this.addCommand({
      id: 'delete-selected-rows',
      name: 'Delete selected table rows',
      callback: () => this.deleteSelectedRows(),
    });
    this.addCommand({
      id: 'delete-selected-columns',
      name: 'Delete selected table columns',
      callback: () => this.deleteSelectedColumns(),
    });
    this._docPointer = (e) => {
      if (
        this._sel &&
        !(e.target.closest && e.target.closest('.tcr-axis-rail')?._tcrTable === this._sel.table) &&
        !(e.target.closest && e.target.closest('.menu')) &&
        !(e.target.closest && e.target.closest('.tcr-merge-toolbar')) &&
        !(e.target.closest && e.target.closest('table') === this._sel.table)
      ) {
        this.clearMergeSelection();
      }
    };
    document.addEventListener('pointerdown', this._docPointer, true);
    this._onKey = (e) => { if (!this.handleSelectedCellKey(e) && !this.handleTableHistoryKey(e) && !this.handleCellEnter(e)) this.handleCellSelectAll(e); };
    document.addEventListener('keydown', this._onKey, true);
    this.installSelectedCellCommands();
    this.registerEvent(this.app.workspace.on('editor-menu', (menu) => this.populateEditorMenu(menu)));

    this._onResize = () => {
      if (this._resizeRaf) return;
      this._resizeRaf = requestAnimationFrame(() => {
        this._resizeRaf = 0;
        this.reflow();
      });
    };
    window.addEventListener('resize', this._onResize);
    this._toolbarViewport=()=>{if(this._sel)this.positionMergeToolbar(this._sel);};
    document.addEventListener('scroll',this._toolbarViewport,true);
    window.addEventListener('resize',this._toolbarViewport);
    this._toolbarKey=e=>{if(e.key==='Escape')this.hideMergeToolbar();};
    document.addEventListener('keydown',this._toolbarKey);
    this._tableCopy=e=>this.handleTableCopy(e);
    this._tablePaste=e=>this.handleTablePaste(e);
    document.addEventListener('copy',this._tableCopy,true);
    document.addEventListener('paste',this._tablePaste,true);
  }

  onunload() {
    this.uninstallSelectedCellCommands();
    if(this._historyOriginals)for(const [name,method] of this._historyOriginals)this[name]=method;
    if(this._columnDragCleanup)this._columnDragCleanup();
    if(this._tableCopy)document.removeEventListener('copy',this._tableCopy,true);
    if(this._tablePaste)document.removeEventListener('paste',this._tablePaste,true);
    if(this._toolbarViewport){document.removeEventListener('scroll',this._toolbarViewport,true);window.removeEventListener('resize',this._toolbarViewport);}
    if(this._toolbarKey)document.removeEventListener('keydown',this._toolbarKey);
    this.clearMergeSelection();
    if (this._axisRails) this._axisRails.forEach(rail => this.removeAxisRail(rail));
    if (this._selectionTables) this._selectionTables.forEach(t => {
      if (t._tcrSelectionCleanup) t._tcrSelectionCleanup();
      delete t._tcrAxisRails;
    });
    if (this._mo) this._mo.disconnect();
    if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
    if (this._docPointer) document.removeEventListener('pointerdown', this._docPointer, true);
    if (this._onKey) document.removeEventListener('keydown', this._onKey, true);
    if (this._toolbar) { this._toolbar.remove(); this._toolbar = null; }
    if (this._layoutStyles) {this._layoutStyles.forEach(style=>style.remove());this._layoutStyles.clear();}
    this._sel = null;
    document.querySelectorAll('table[data-tcr]').forEach((t) => {
      t.querySelectorAll('.tcr-sel').forEach((c) => c.classList.remove('tcr-sel'));
      // Older 1.1.6 builds drew the purple selection outline with child spans.
      // Remove any such nodes that survived a hot reload of the plugin.
      t.querySelectorAll('.tcr-sel-edge').forEach((edge) => edge.remove());
      t.querySelectorAll('.tcr-handle, .tcr-row-handle').forEach((h) => h.remove());
      this.resetMerges(t);
      t.querySelectorAll('[data-tcr-align]').forEach(c=>{delete c.dataset.tcrAlign;c.style.textAlign='';});
      t.querySelectorAll('[data-tcr-valign]').forEach(c=>{delete c.dataset.tcrValign;c.style.verticalAlign='';});
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
      delete t.dataset.tcrLayout;
      t.classList.remove('tcr-cell-editing');
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
    if (this._layoutStyles) for (const [table,style] of this._layoutStyles) if (!table.isConnected) {
      style.remove();this._layoutStyles.delete(table);
    }
    if (this._sel && !this._sel.table.isConnected) this.clearMergeSelection();
    if (this._selectionTables) for (const table of this._selectionTables) {
      if (table.isConnected) continue;
      if (table._tcrSelectionCleanup) table._tcrSelectionCleanup();
      this._selectionTables.delete(table);
    }
    if (this._axisRails) this._axisRails = this._axisRails.filter(rail => {
      if (rail._tcrTable.isConnected) return true;
      this.removeAxisRail(rail); return false;
    });
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
    for (const c of cells) {
      // A live header may contain both the hidden rendered text and its editor.
      const content = c.querySelector?.('.table-cell-wrapper .cm-content') || c.querySelector?.('.table-cell-content') || c;
      key += (content.textContent || '').trim() + '\u0001';
    }
    let h = 5381;
    for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
    return 't' + (h >>> 0).toString(36);
  }

  // Stable per-table id within a note. Tables with identical headers get
  // "t<base>", "t<base>#2", ... in document order so they stay independent
  // instead of sharing (and fighting over) one width entry.
  tableId(table) {
    const uid = this.tableUid(table);
    if (uid) return 'u' + uid;
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

  tableUid(table) {
    if (!table) return null;
    const oldMarker = table.querySelector && table.querySelector('[data-table-tune-id]');
    let uid = oldMarker && oldMarker.getAttribute('data-table-tune-id');
    if (!uid && table.querySelector) {
      const firstHeader = table.querySelector('thead th, thead td');
      uid = firstHeader && this.decodeInvisibleUid(firstHeader.textContent || '');
    }
    if (!uid) {
      const editor = this.app && this.app.workspace ? this.activeEditor() : null;
      const info = editor && this.tableSourceInfo(editor, table);
      uid = info && (info.uid || this.uidFromGrid(info.grid));
    }
    if (table.dataset) {
      if (uid) table.dataset.tableTuneUid = uid;
      else delete table.dataset.tableTuneUid;
    }
    return uid || null;
  }

  tablePeers(table) {
    const root = table.closest?.('.cm-content, .markdown-preview-view');
    return Array.from((root || document).querySelectorAll(root ? 'table' : '.cm-content table, .markdown-preview-view table'));
  }

  uidFromGrid(grid) {
    const text = grid && grid[0] ? grid[0].join(' ') : '';
    const invisible = this.decodeInvisibleUid(text);
    if (invisible) return invisible;
    const comment = text.match(/%%table-tune-id:([a-z0-9_-]+)%%/i);
    if (comment) return comment[1];
    const oldSpan = text.match(/<span\s+data-table-tune-id=["']([^"']+)["']\s*><\/span>/i);
    return oldSpan ? oldSpan[1] : null;
  }

  encodeInvisibleUid(uid) {
    const start = '\u2063\u200d\u2063', end = '\u2063\u200c\u2063';
    let bits = '';
    for (const ch of uid) bits += ch.charCodeAt(0).toString(2).padStart(8, '0');
    return start + bits.replace(/0/g, '\u200b').replace(/1/g, '\u200c') + end;
  }

  decodeInvisibleUid(text) {
    const start = '\u2063\u200d\u2063', end = '\u2063\u200c\u2063';
    const a = (text || '').indexOf(start);
    if (a < 0) return null;
    const b = text.indexOf(end, a + start.length);
    if (b < 0) return null;
    const raw = text.slice(a + start.length, b);
    if (!raw || /[^\u200b\u200c]/.test(raw) || raw.length % 8) return null;
    let out = '';
    for (let i = 0; i < raw.length; i += 8) {
      const bits = raw.slice(i, i + 8).replace(/\u200b/g, '0').replace(/\u200c/g, '1');
      out += String.fromCharCode(parseInt(bits, 2));
    }
    return out;
  }

  stripInvisibleUid(text) {
    const start = '\u2063\u200d\u2063', end = '\u2063\u200c\u2063';
    let value = text || '';
    let a = value.indexOf(start);
    while (a >= 0) {
      const b = value.indexOf(end, a + start.length);
      if (b < 0) break;
      value = value.slice(0, a) + value.slice(b + end.length);
      a = value.indexOf(start);
    }
    return value;
  }

  stripTableIdentity(text) {
    return this.stripInvisibleUid(text || '')
      .replace(/<span\s+data-table-tune-id=["'][^"']+["']\s*><\/span>/ig, '')
      .replace(/%%table-tune-id:[a-z0-9_-]+%%/ig, '');
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
    if (table.classList.contains('tcr-grid-table')) {
      table.style.gridTemplateColumns = Array.from(colgroup.children,
        (col) => col.style.width || '80px').join(' ');
      table._tcrGridCols=table.style.gridTemplateColumns;
      this.updateLayoutStyle(table);
    }
    if (table._tcrAxisRails) this.positionAxisRails(table);
    if (this._sel?.table === table) this.positionSelectionOverlay();
  }

  // Always left-align the table at the wrapper's left edge (requirement:
  // the table must sit at the leftmost in reading mode). No centering, even
  // when the table is narrower than the wrapper.
  alignTableLeft(table) {
    table.style.marginLeft = '0';
    table.style.marginRight = '0';
  }

  // Persist column widths, row heights and cell merges together as one object.
  persist() {
    this.saveData({
      widths: this.widths,
      rowHeights: this.rowHeights,
      merges: this.merges,
      tableDims: this.tableDims,
      alignments: this.alignments || {},
    });
  }

  // Attach layout metadata to the SAME native history event as its cell/source
  // edits. No document snapshots, parallel undo stack or text-history guessing.
  installTableHistory() {
    try {
      const {StateEffect}=require('@codemirror/state');
      const commands=require('@codemirror/commands');
      const {EditorView}=require('@codemirror/view');
      const effect=StateEffect.define();
      this._historyApi={...commands,effect};
      this._historyInverse=tr=>tr.effects.filter(e=>e.is(effect)).map(e=>effect.of({path:e.value.path,entries:e.value.entries.map(v=>({...v,before:v.after,after:v.before}))}));
      this.registerEditorExtension([
        commands.invertedEffects.of(this._historyInverse),
        EditorView.updateListener.of(update=>{
          const anchors=this._widthAnchors?.get(update.view);
          if(anchors)for(const tr of update.transactions)if(tr.docChanged){
            for(const entry of anchors){
              let removed=false;
              tr.changes.iterChangedRanges((a,b)=>{if(a<=entry.from && b>=entry.to && b>a)removed=true;});
              entry.from=tr.changes.mapPos(entry.from,-1);
              entry.to=tr.changes.mapPos(entry.to,1);
              if(removed)entry.invalid=true;
            }
          }
          for(const tr of update.transactions)for(const e of tr.effects)if(e.is(effect)){
            this.applyTableHistory(e.value);
            if(tr.isUserEvent('undo') || tr.isUserEvent('redo'))this.clearMergeSelection();
            requestAnimationFrame(()=>{
              document.querySelectorAll('table[data-tcr]').forEach(t=>{if(t.dataset.tcrPath===e.value.path && t.isConnected)this.reflowTable(t)});
            });
          }
        }),
      ]);
      this._historyOriginals=new Map();
      for(const name of ['mergeSelectedCells','splitRegion','insertTableAxis','deleteSelectionAxis','setSelectionAlignment','handleTablePaste','clearSelectedCellContents']){
        const original=this[name];this._historyOriginals.set(name,original);
        this[name]=(...args)=>this.runTableHistory(()=>original.apply(this,args));
      }
    }catch(error){
      this._historyApi=null;
      console.warn('TableTune: native history integration unavailable',error);
      new Notice('TableTune: 原生撤销组件不可用，请更新 Obsidian 后重载插件');
    }
  }

  historySnapshot(editor=null,path=null) {
    const api=this._historyApi;
    if(!api)return null;
    editor=editor || this.activeEditor();path=path || this.currentPath();
    const cm=editor?.cm;
    if(!api || !cm?.state?.facet || !cm.state.facet(api.invertedEffects).includes(this._historyInverse))return null;
    const data={};
    for(const name of ['widths','rowHeights','merges','tableDims','alignments'])data[name]=JSON.parse(JSON.stringify(this.normalizeStore(this[name]?.[path] || {})));
    return {editor,path,data};
  }

  applyTableHistory(patch) {
    for(const entry of patch.entries){
      const store=this[entry.store] || (this[entry.store]={});
      store[patch.path]=this.normalizeStore(store[patch.path] || {});
      if(entry.after===null)delete store[patch.path][entry.key];
      else store[patch.path][entry.key]=JSON.parse(JSON.stringify(entry.after));
    }
    this.persist();
  }

  runTableHistory(action,before=null) {
    if(this._historyBatch)return action();
    const snapshot=before || this.historySnapshot();
    if(!snapshot || snapshot.editor!==this.activeEditor() || snapshot.path!==this.currentPath())return action();
    const batch={...snapshot,changes:[]};this._historyBatch=batch;
    let result;
    try { result=action(); }
    catch(error){
      for(const [name,data] of Object.entries(snapshot.data))this[name][snapshot.path]=data;
      throw error;
    }finally{this._historyBatch=null;}
    const entries=[];
    for(const [store,previous] of Object.entries(snapshot.data)){
      const next=this.normalizeStore(this[store]?.[snapshot.path] || {});
      for(const key of new Set([...Object.keys(previous),...Object.keys(next)])){
        const a=previous[key]??null,b=next[key]??null;
        if(JSON.stringify(a)!==JSON.stringify(b))entries.push({store,key,before:a,after:b===null?null:JSON.parse(JSON.stringify(b))});
      }
    }
    if(!entries.length && !batch.changes.length)return result;
    const api=this._historyApi;
    try {
      batch.editor.cm.dispatch({changes:batch.changes.sort((a,b)=>a.from-b.from),effects:api.effect.of({path:snapshot.path,entries}),annotations:api.isolateHistory.of('full'),userEvent:'input.table-tune'});
    }catch(error){
      this.applyTableHistory({path:snapshot.path,entries:entries.map(v=>({...v,after:v.before}))});
      this.clearMergeSelection();
      new Notice('TableTune: 操作未能安全写入，已取消');
      console.error('TableTune transaction failed',error);
    }
    return result;
  }

  replaceTableRange(editor,text,from,to) {
    const batch=this._historyBatch;
    if(!batch || batch.editor!==editor)return editor.replaceRange(text,from,to);
    const offset=pos=>typeof pos==='number'?pos:editor.cm.state.doc.line(pos.line+1).from+pos.ch;
    batch.changes.push({from:offset(from),to:offset(to),insert:text});
  }

  dispatchTableChanges(editor,changes,toPos=null) {
    if(this._historyBatch?.editor===editor){this._historyBatch.changes.push(...changes);return;}
    if(editor.cm?.dispatch && editor.cm.state?.doc)editor.cm.dispatch({changes,userEvent:'input'});
    else for(const c of changes.slice().reverse())editor.replaceRange(c.insert,toPos?toPos(c.from):this.tableOffsetPosition(editor,c.from),toPos?toPos(c.to):this.tableOffsetPosition(editor,c.to));
  }

  tableOffsetPosition(editor,offset) {
    if(editor.offsetToPos)return editor.offsetToPos(offset);
    const line=editor.cm.state.doc.lineAt(offset);return {line:line.number-1,ch:offset-line.from};
  }

  handleTableHistoryKey(e) {
    if(!(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing || !['z','y'].includes(e.key?.toLowerCase()))return false;
    if(e.target.closest?.('input,textarea,.modal'))return false;
    const editor=this.activeEditor(),cm=editor?.cm,session=editor?.editorComponent?.tableCell;
    if(!this._historyApi || !cm || !(cm.dom?.contains(e.target) || session?.cm?.contentDOM?.contains(e.target) || (this._sel?.path===this.currentPath() && e.target.closest?.('.tcr-merge-toolbar'))))return false;
    const redo=e.key.toLowerCase()==='y' || e.shiftKey;
    if(!(redo?this._historyApi.redo:this._historyApi.undo)(cm))return false;
    e.preventDefault();e.stopImmediatePropagation();return true;
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
    if (table.classList.contains('tcr-grid-table')) this.updateMergeGridRows(table, path, tid);
  }

  reconcileTableDimensions(table, path, tid, cols) {
    if (!this.tableDims[path]) this.tableDims[path] = {};
    const rows = table.rows.length;
    const previous = this.tableDims[path][tid];
    if (!previous) {
      this.tableDims[path][tid] = { rows, cols };
      this.persist();
      return;
    }
    if (previous.rows === rows && previous.cols === cols) return;

    let merges = (this.merges[path] && this.merges[path][tid]) || [];
    let alignments=this.alignments?.[path]?.[tid];
    if (previous.rows !== rows) {
      const at = this.dimensionChangeIndex(path, tid, 'row', previous.rows, rows);
      merges = this.adjustMergesForDimension(merges, 'row', previous.rows, rows, at);
      const delta=rows-previous.rows;
      if(alignments)alignments=this.remapAlignments(alignments,'row',i=>delta>0?(i>=at?i+delta:i):(i>=at&&i<at-delta?null:i>=at-delta?i+delta:i));
      const heights = (this.getRowHeights(path, tid) || []).slice();
      while (heights.length < previous.rows) heights.push(null);
      if (rows > previous.rows) heights.splice(at, 0, ...new Array(rows - previous.rows).fill(null));
      else heights.splice(at, previous.rows - rows);
      this.setRowHeights(path, tid, heights.slice(0, rows));
    }
    if (previous.cols !== cols) {
      const at = this.dimensionChangeIndex(path, tid, 'col', previous.cols, cols);
      merges = this.adjustMergesForDimension(merges, 'col', previous.cols, cols, at);
      const delta=cols-previous.cols;
      if(alignments)alignments=this.remapAlignments(alignments,'col',i=>delta>0?(i>=at?i+delta:i):(i>=at&&i<at-delta?null:i>=at-delta?i+delta:i));
    }
    if (!this.merges[path]) this.merges[path] = {};
    this.merges[path][tid] = merges;
    if(alignments)this.alignments[path][tid]=alignments;
    this.tableDims[path][tid] = { rows, cols };
    this.persist();
  }

  adjustMergesForDimension(regions, axis, oldCount, newCount, at) {
    const key = axis === 'row' ? 'r' : 'c';
    const spanKey = axis === 'row' ? 'rowspan' : 'colspan';
    const otherSpan = axis === 'row' ? 'colspan' : 'rowspan';
    const delta = newCount - oldCount;
    if (delta > 0) {
      return regions.map((original) => {
        const reg = { ...original };
        if (at <= reg[key]) reg[key] += delta;
        else if (at < reg[key] + reg[spanKey]) {
          // Only insertion strictly inside a merge belongs to that merge.
          // At either outer boundary, leave the new axis independent.
          reg[spanKey] += delta;
        }
        if (axis === 'row') delete reg.height;
        return reg;
      });
    }
    const removeCount = -delta;
    const end = at + removeCount;
    const result = [];
    for (const original of regions) {
      const reg = { ...original };
      const surviving = [];
      for (let i = reg[key]; i < reg[key] + reg[spanKey]; i++) if (i < at || i >= end) surviving.push(i);
      if (!surviving.length) continue;
      reg[key] = surviving[0] >= end ? surviving[0] - removeCount : surviving[0];
      reg[spanKey] = surviving.length;
      if (axis === 'row') delete reg.height;
      if (reg[spanKey] > 1 || reg[otherSpan] > 1) result.push(reg);
    }
    return result;
  }

  // Ensure a colgroup with one <col> per header column exists.
  ensureColgroup(table, n) {
    let colgroup = table.querySelector('colgroup');
    if (!colgroup) {
      colgroup = document.createElement('colgroup');
      table.prepend(colgroup);
    }
    while (colgroup.children.length < n) colgroup.appendChild(document.createElement('col'));
    while (colgroup.children.length > n) colgroup.lastElementChild.remove();
    return colgroup;
  }

  dimensionChangeIndex(path, tid, axis, oldCount, newCount) {
    // Native append buttons must not inherit a stale selection/cursor position.
    // Our explicit boundary insertion writes dimensions/metadata atomically.
    if (newCount > oldCount) return oldCount;
    const sel = this._sel;
    if (sel && sel.path === path && sel.tid === tid) {
      const edge = axis === 'row' ? sel.r2 : sel.c2;
      const start = axis === 'row' ? sel.r1 : sel.c1;
      return newCount > oldCount
        ? Math.max(0, Math.min(oldCount, edge + 1))
        : Math.max(0, Math.min(newCount, start));
    }
    const recent = this._lastTableCell;
    if (recent && recent.path === path && recent.tid === tid && Date.now() - recent.time < 15000) {
      const point = axis === 'row' ? recent.r : recent.c;
      return newCount > oldCount
        ? Math.max(0, Math.min(oldCount, point + 1))
        : Math.max(0, Math.min(newCount, point));
    }
    return Math.min(oldCount, newCount);
  }

  adaptSavedWidths(saved, fit, n, path, tid) {
    const out = saved.slice();
    if (out.length < n) {
      const add = n - out.length;
      const at = this.dimensionChangeIndex(path, tid, 'col', out.length, n);
      out.splice(at, 0, ...fit.slice(at, at + add).map((v) => v + 'px'));
    } else if (out.length > n) {
      const remove = out.length - n;
      const at = this.dimensionChangeIndex(path, tid, 'col', out.length, n);
      out.splice(at, remove);
    }
    while (out.length < n) out.push(fit[out.length] + 'px');
    if (out.length > n) out.length = n;
    for (let i = 0; i < n; i++) if (!(parseFloat(out[i]) > 0)) out[i] = fit[i] + 'px';
    return out;
  }

  // Apply saved (or freshly computed default) column widths to a table.
  applyWidths(table, colgroup, path, tid, preview) {
    // Native editor mutations can trigger a reflow between pointer moves.
    // Keep the live drag authoritative until the release has been committed.
    if (table._tcrColumnDrag) {
      table._tcrColumnDrag.forEach((width, i) => {
        if (colgroup.children[i]) colgroup.children[i].style.width = width;
      });
      this.syncTableWidth(table, colgroup);
      return colgroup.children.length;
    }
    const headCols = table.querySelectorAll('thead th, thead td');
    const n = headCols.length;
    // Header text is not an identity: before a table has a source UID, typing
    // changes its legacy hash. Keep width tracks tied to its source range (and
    // map that range through native edits), including replacement widget DOM.
    let anchor=null;
    try {
      const editor=this.activeEditor();
      const info=editor && this.currentPath()===path && this.tableSourceInfo(editor,table);
      if(info && editor.cm){
        if(!this._widthAnchors)this._widthAnchors=new WeakMap();
        let entries=this._widthAnchors.get(editor.cm);
        if(!entries){entries=[];this._widthAnchors.set(editor.cm,entries);}
        anchor=entries.find(e=>!e.invalid && e.path===path && e.from===info.from);
        if(!anchor){anchor={path,from:info.from,to:info.to};entries.push(anchor);}
        anchor.to=info.to;
      }
    }catch(_) { /* Reading mode or a temporarily unavailable source mapping. */ }
    const fixed=anchor?.widths || table._tcrFixedWidths;
    const previousTid=anchor?.tid || table._tcrFixedTid;
    const stored=this.getWidths(path,tid,n);
    const saved = (!tid.startsWith('u') && previousTid && previousTid!==tid && fixed?.length===n)
      ? fixed : stored || (fixed?.length===n ? fixed : null);
    let shouldPersist = false;
    let effective = saved;
    if (saved && saved.length !== n) {
      effective = this.adaptSavedWidths(saved, this.autoFitWidths(table, n), n, path, tid);
      this.setWidths(path, tid, effective);
      shouldPersist = true;
    }
    if (effective && effective.length === n) {
      const tablePx = table.getBoundingClientRect().width || 1;
      for (let i = 0; i < n; i++) {
        const px = this.toPx(effective[i], tablePx);
        colgroup.children[i].style.width = (px && px > 0 ? Math.round(px) : 80) + 'px';
      }
    } else {
      // No stored widths yet: fit each column to its content (capped) so wide,
      // text-heavy tables are readable without manual dragging. This also
      // avoids the old equal-split default persisting tiny "40px" values when
      // the table had not laid out yet (a table hidden/loading reports width 0,
      // which used to produce min-width defaults that clobbered real ones).
      // Freeze the displayed initial tracks, not their text's natural width.
      // Hidden/loading tables have no geometry and use the normal fallback.
      const measured=Array.from(headCols,c=>c.getBoundingClientRect().width);
      const fit = measured.every(w=>w>=40) && !table.classList.contains('tcr-grid-table')
        ? measured.map(Math.round) : this.autoFitWidths(table, n);
      for (let i = 0; i < n; i++) colgroup.children[i].style.width = fit[i] + 'px';
      shouldPersist = true;
    }
    this.syncTableWidth(table, colgroup);
    table._tcrFixedWidths=Array.from(colgroup.children,c=>c.style.width);
    table._tcrFixedTid=tid;
    if(anchor){anchor.widths=table._tcrFixedWidths.slice();anchor.tid=tid;}
    if(saved && saved!==stored){this.setWidths(path,tid,table._tcrFixedWidths.slice());shouldPersist=true;}
    // Persist the freshly computed default so the other mode mirrors it
    // exactly (Reading column widths == Edit column widths). Only this
    // table's entry is touched; other tables in the note keep their own.
    if (shouldPersist) {
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
    const path = table.dataset.tcrPath || (file ? file.path : 'unknown');
    const preview = table.closest('.markdown-preview-view');
    const allowDrag = !preview; // edit (Live Preview) => drag handles
    const headCols = table.querySelectorAll('thead th, thead td');
    const n = headCols.length;
    if (!n) return;
    const tid = this.tableId(table);
    this.reconcileTableDimensions(table, path, tid, n);

    // Live Preview (and other renderers) may wipe our <col> widths / handles on
    // re-render. Re-apply the stored widths, and rebuild anything missing, so the
    // table always matches the saved state (and therefore matches Reading view).
    const colgroup = this.ensureColgroup(table, n);
    this.applyWidths(table, colgroup, path, tid, preview);
    this.applyRowHeights(table, path, tid);
    this.applyMerges(table, path, tid);
    this.applyCellAlignments(table,path,tid);

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
      table.querySelectorAll('.tcr-row-handle').forEach(h => h.remove());
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
    if (allowDrag && table._tcrAxisRails) this.positionAxisRails(table);
    if (this._sel?.table === table) this.positionSelectionOverlay();
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
    if (this._sel && !this._sel.table.isConnected) this.clearMergeSelection();
    else this.positionSelectionOverlay();
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
    this.reconcileTableDimensions(table, path, tid, n);

    table.dataset.tcr = '1';
    table.dataset.tcrPath = path;
    table.style.tableLayout = 'fixed';
    table.style.maxWidth = 'none';

    const colgroup = this.ensureColgroup(table, n);
    this.applyWidths(table, colgroup, path, tid, preview);
    this.applyRowHeights(table, path, tid);
    this.applyMerges(table, path, tid);
    this.applyCellAlignments(table,path,tid);

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
      this.setupCellSelection(table, path, tid);
    }
  }

  // ---- cell merge (Excel-style) ----------------------------------------
  // Merge info is stored per table in data.json:
  //   merges[path][tid] = [{ r, c, rowspan, colspan }, ...]
  // On merge the source is rewritten like Excel: the top-left cell keeps all
  // inherited content (same-row cells first, then following rows; joined with
  // <br>), and the other cells in the range are emptied. Splitting restores
  // the grid; the content stays consolidated in the top-left cell.

  currentPath() {
    const file = this.app.workspace.getActiveFile();
    return file ? file.path : 'unknown';
  }

  activeEditor() {
    const view = this.app?.workspace?.getActiveViewOfType?.(MarkdownView);
    return view && view.editor ? view.editor : null;
  }

  cellRow(cell) {
    const tr = cell.closest('tr');
    const table = tr && tr.closest('table');
    if (!table) return -1;
    return Array.from(table.rows).indexOf(tr);
  }

  cellCol(cell) {
    const tr = cell.closest('tr');
    if (!tr) return -1;
    return Array.from(tr.children).indexOf(cell);
  }

  getMerges(path, tid) {
    if (!this.merges[path]) this.merges[path] = {};
    if (!Array.isArray(this.merges[path][tid])) this.merges[path][tid] = [];
    return this.merges[path][tid];
  }

  effectiveMerges(table, path, tid) {
    const list = (this.merges[path] && this.merges[path][tid]) || [];
    const valid = this.validMergeRegions(table, list);
    const stable = !!this.tableUid(table);
    if (stable) return valid;
    const grid = table ? Array.from(table.rows).map((row) => Array.from(row.cells)) : [];
    return valid.filter((reg) => {
      const anchor = grid[reg.r] && grid[reg.r][reg.c];
      return !!(anchor && (anchor.textContent || '').trim());
    });
  }

  validMergeRegions(table, regions) {
    const rows = table && table.rows;
    const occupied = new Set();
    return regions.filter((m) => {
      if (!m || ![m.r, m.c, m.rowspan, m.colspan].every(Number.isInteger) ||
          m.r < 0 || m.c < 0 || m.rowspan < 1 || m.colspan < 1) return false;
      if (!rows) return true;
      if (m.r + m.rowspan > rows.length) return false;
      const keys = [];
      for (let r = m.r; r < m.r + m.rowspan; r++) {
        if (m.c + m.colspan > rows[r].cells.length) return false;
        for (let c = m.c; c < m.c + m.colspan; c++) {
          const key = r + ',' + c;
          if (occupied.has(key)) return false;
          keys.push(key);
        }
      }
      keys.forEach((key) => occupied.add(key));
      return true;
    });
  }

  regionContains(reg, r, c) {
    return r >= reg.r && r < reg.r + reg.rowspan && c >= reg.c && c < reg.c + reg.colspan;
  }

  resetMerges(table, keepStyles = false) {
    table.classList.remove('tcr-grid-table');
    table.style.gridTemplateColumns = '';
    table.style.gridTemplateRows = '';
    table.querySelectorAll('th, td').forEach((cell) => {
      if (cell.dataset.tcrMerge) cell.style.height = '';
      cell.colSpan = 1;
      cell.rowSpan = 1;
      cell.style.display = '';
      cell.classList.remove('tcr-merged', 'tcr-merged-hidden');
      delete cell.dataset.tcrMerge;
      cell.style.gridRow = '';
      cell.style.gridColumn = '';
    });
    if (!keepStyles && this._layoutStyles?.has(table)) {
      this._layoutStyles.get(table).remove();this._layoutStyles.delete(table);
    }
  }

  updateMergeGridRows(table, path, tid) {
    const heights = this.getRowHeights(path, tid) || [];
    table.style.gridTemplateRows = Array.from(table.rows, (_, r) =>
      'minmax(' + Math.max(24, parseFloat(heights[r]) || 30) + 'px, auto)').join(' ');
    table._tcrGridRows = table.style.gridTemplateRows;
    this.updateLayoutStyle(table);
  }

  prepareMergeGrid(table, path, tid, grid) {
    // Native rowspan stops at THEAD/TBODY boundaries. Preserve those DOM nodes
    // for Obsidian's editor, but lay out every logical cell in one CSS grid.
    table.classList.add('tcr-grid-table');
    const colgroup = table.querySelector('colgroup');
    const widths = this.getWidths(path, tid, grid[0].length) || [];
    table.style.gridTemplateColumns = grid[0].map((_, c) =>
      (colgroup && colgroup.children[c] && colgroup.children[c].style.width) ||
      widths[c] || '80px').join(' ');
    table._tcrGridCols = table.style.gridTemplateColumns;
    this.updateMergeGridRows(table, path, tid);
    grid.forEach((row, r) => row.forEach((cell, c) => {
      cell.style.gridRow = String(r + 1);
      cell.style.gridColumn = String(c + 1);
      cell.dataset.tcrCell = r+','+c;
    }));
  }

  applyMerges(table, path, tid) {
    const regions = this.effectiveMerges(table, path, tid);
    table._tcrRegions = regions;
    this.resetMerges(table,true);
    if (!regions.length) {this.updateLayoutStyle(table);return;}
    // Snapshot the physical grid before assigning rowspan/colspan. Never index
    // the live HTMLTableRowElement.cells collection after structure changes.
    const grid = Array.from(table.rows).map((row) => Array.from(row.cells));
    this.prepareMergeGrid(table, path, tid, grid);
    // Legacy tables had no persistent identity, so a newly created empty table
    // could inherit merges from an older table with the same blank header. Only
    // trust a legacy region when its anchor still contains content. Every new
    // merge receives an invisible persistent id and is not subject to this rule.
    const occupied = new Set();
    regions.forEach((reg) => {
      if (!reg || reg.r < 0 || reg.c < 0 || reg.rowspan < 1 || reg.colspan < 1) return;
      const cells = [];
      for (let rr = reg.r; rr < reg.r + reg.rowspan; rr++) {
        for (let cc = reg.c; cc < reg.c + reg.colspan; cc++) {
          const cell = grid[rr] && grid[rr][cc];
          const key = rr + ',' + cc;
          // Ignore stale, out-of-bounds or overlapping records as a whole so a
          // damaged record can never hide only part of the visible table.
          if (!cell || occupied.has(key)) return;
          cells.push({ rr, cc, cell, key });
        }
      }
      const anchor = grid[reg.r][reg.c];
      anchor.colSpan = reg.colspan;
      anchor.rowSpan = reg.rowspan;
      anchor.classList.add('tcr-merged');
      anchor.dataset.tcrMerge = reg.r + ',' + reg.c;
      anchor.style.gridRow = (reg.r + 1) + ' / span ' + reg.rowspan;
      anchor.style.gridColumn = (reg.c + 1) + ' / span ' + reg.colspan;
      // Row tracks own heights; a summed cell height must not inflate row one.
      anchor.style.height = '';
      cells.forEach(({ rr, cc, cell, key }) => {
        occupied.add(key);
        if (rr === reg.r && cc === reg.c) return;
        cell.classList.add('tcr-merged-hidden');
        cell.style.display = 'none';
        cell.dataset.tcrMerge = reg.r + ',' + reg.c;
      });
    });
    this.updateLayoutStyle(table);
  }

  // Cell editors temporarily remove the entire style attribute. Keep the
  // presentation outside their DOM, indexed by persistent data attributes.
  updateLayoutStyle(table) {
    if (typeof document.createElement !== 'function') return;
    if (!this._layoutStyles) this._layoutStyles = new Map();
    const grid = table.classList.contains('tcr-grid-table');
    const aligned = Array.from(table.querySelectorAll('[data-tcr-align], [data-tcr-valign]'));
    if (!grid && !aligned.length && !this._layoutStyles.has(table)) return;
    if (!table.dataset.tcrLayout) {
      this._layoutSequence=(this._layoutSequence||0)+1;
      table.dataset.tcrLayout='l'+this._layoutSequence;
    }
    const selector='table[data-tcr-layout="'+table.dataset.tcrLayout+'"]';
    const rules=[];
    if (grid) {
      const widths=(table._tcrGridCols || '').split(' ').map(parseFloat);
      const width=widths.every(Number.isFinite)?'width:'+widths.reduce((a,b)=>a+b,0)+'px!important;':'';
      rules.push(selector+'{'+width+'grid-template-columns:'+table._tcrGridCols+'!important;grid-template-rows:'+table._tcrGridRows+'!important;}');
      const regions=table._tcrRegions || [];
      Array.from(table.rows).forEach((row,r)=>Array.from(row.cells).forEach((cell,c)=>{
        cell.dataset.tcrCell=r+','+c;
        const m=regions.find(m=>m.r===r&&m.c===c);
        rules.push(selector+' [data-tcr-cell="'+r+','+c+'"]{grid-row:'+(r+1)+(m?' / span '+m.rowspan:'')+'!important;grid-column:'+(c+1)+(m?' / span '+m.colspan:'')+'!important;}');
      }));
    }
    for (const cell of aligned) {
      const target=selector+' [data-tcr-cell="'+cell.dataset.tcrCell+'"]';
      if(cell.dataset.tcrAlign)rules.push(target+'{text-align:'+cell.dataset.tcrAlign+'!important;}');
      if(cell.dataset.tcrValign){
        const value=cell.dataset.tcrValign,content={top:'start',middle:'center',bottom:'end'}[value];
        rules.push(target+'{vertical-align:'+value+'!important;}');
        rules.push(target+' > .table-cell-wrapper{height:auto!important;}');
        // Grid items are blockified: vertical-align alone has no effect. Block
        // content alignment preserves inline markup and the native editor DOM.
        if(grid)rules.push(target+'{align-content:'+content+'!important;}');
      }
    }
    let style=this._layoutStyles.get(table);
    if (!style) {style=document.createElement('style');style.className='tcr-layout-style';document.head.appendChild(style);this._layoutStyles.set(table,style);}
    const text=rules.join('\n');if(style.textContent!==text)style.textContent=text;
  }

  applyCellAlignments(table,path,tid) {
    const map=this.alignments?.[path]?.[tid] || {};
    Array.from(table.rows).forEach((row,r)=>Array.from(row.cells).forEach((cell,c)=>{
      cell.dataset.tcrCell=r+','+c;
      const value=map[r+','+c],alignment=typeof value==='string'?value:value?.horizontal,vertical=value?.vertical;
      if (['left','center','right'].includes(alignment)) {cell.dataset.tcrAlign=alignment;cell.style.textAlign=alignment;}
      else if (cell.dataset.tcrAlign) {delete cell.dataset.tcrAlign;cell.style.textAlign='';}
      if(['top','middle','bottom'].includes(vertical)){cell.dataset.tcrValign=vertical;cell.style.verticalAlign=vertical;}
      else if(cell.dataset.tcrValign){delete cell.dataset.tcrValign;cell.style.verticalAlign='';}
    }));
    this.updateLayoutStyle(table);
  }

  remapAlignments(map, axis, transform) {
    const next={};
    for(const [key,value] of Object.entries(map || {})) {
      const [r,c]=key.split(',').map(Number), index=transform(axis==='row'?r:c);
      if(index!==null)next[(axis==='row'?index:r)+','+(axis==='col'?index:c)]=value;
    }
    return next;
  }

  alignmentSelectionCells(sel) {
    if (!sel.axis) return this.selectionCells(sel);
    const selected=new Set(), merges=this.effectiveMerges(sel.table,sel.path,sel.tid);
    for(let r=0;r<sel.table.rows.length;r++)for(let c=0;c<sel.table.rows[r].cells.length;c++){
      const m=merges.find(m=>this.regionContains(m,r,c));
      const start=sel.axis==='row'?(m?m.r:r):(m?m.c:c),span=m?(sel.axis==='row'?m.rowspan:m.colspan):1;
      if(Array.from({length:span},(_,i)=>start+i).every(i=>sel.indices.has(i)))selected.add(r+','+c);
    }
    return selected;
  }

  setSelectionAlignment(alignment, axis='horizontal') {
    const sel=this._sel, editor=this.activeEditor();
    const allowed=axis==='horizontal'?['left','center','right']:axis==='vertical'?['top','middle','bottom']:[];
    if(!sel || !editor || !allowed.includes(alignment))return;
    if(sel.table.isConnected===false || this.currentPath()!==sel.path)return;
    const cells=this.alignmentSelectionCells(sel),info=this.tableSourceInfo(editor,sel.table);
    if(!info){new Notice('TableTune: 无法定位表格源码，对齐已取消');return;}
    if(!cells.size)return;
    const uid=info.uid || this.uidFromGrid(info.grid) || ('m'+Date.now().toString(36)+Math.random().toString(36).slice(2,8)),tid='u'+uid;
    const oldTid=info.uid?tid:sel.tid;
    if(!info.uid){
      // Alignment changes metadata only. Replacing the entire source table
      // forces native Live Preview to rebuild its active header editor. Insert
      // just the missing identity inside the first cell, preserving all text,
      // padding, escapes and the active cell's incremental update path.
      if(typeof info.header!=='string'){new Notice('TableTune: 无法安全保存表格标识，对齐已取消');return;}
      const prefix=info.header.match(/^\s*\|?\s*/)[0].length;
      const at=info.toPos(info.from+prefix);
      try{this.replaceTableRange(editor,this.encodeInvisibleUid(uid),at,at);}
      catch(e){new Notice('TableTune: 对齐保存失败');return;}
      for(const store of [this.widths,this.rowHeights,this.merges,this.tableDims,this.alignments || {}]) {
        if(store?.[sel.path]?.[oldTid]!==undefined)store[sel.path][tid]=store[sel.path][oldTid];
      }
      sel.table.dataset.tableTuneUid=uid;
    }
    if(!this.alignments)this.alignments={};if(!this.alignments[sel.path])this.alignments[sel.path]={};
    const map={...(this.alignments[sel.path][tid] || {})};
    for(const key of cells){
      const previous=map[key];
      // Keep legacy horizontal strings readable; add the second axis without
      // overwriting an existing horizontal or vertical setting.
      if(axis==='horizontal' && (!previous || typeof previous==='string'))map[key]=alignment;
      else map[key]={...(typeof previous==='string'?{horizontal:previous}:previous),[axis]:alignment};
    }
    this.alignments[sel.path][tid]=map;sel.tid=tid;
    this.applyCellAlignments(sel.table,sel.path,tid);this.persist();
    // The insertion is reconciled by the native cell editor. Do not schedule
    // another table enhancement/rebuild while that editor is still active.
  }

  addAlignmentMenu(menu) {
    if(!this._sel)return;
    for(const [value,title] of [['left','左对齐'],['center','居中对齐'],['right','右对齐']])menu.addItem(item=>{
      item.setTitle(title);item.onClick(()=>this.setSelectionAlignment(value));
      item.setChecked?.(this.selectionAlignment('horizontal')===value);
    });
    for(const [value,title] of [['top','顶部对齐'],['middle','垂直居中'],['bottom','底部对齐']])menu.addItem(item=>{
      item.setTitle(title);item.onClick(()=>this.setSelectionAlignment(value,'vertical'));
      item.setChecked?.(this.selectionAlignment('vertical')===value);
    });
  }

  selectionAlignment(axis) {
    const sel=this._sel;
    if(!sel)return null;
    const map=this.alignments?.[sel.path]?.[sel.tid] || {},values=new Set();
    for(const key of this.alignmentSelectionCells(sel)){
      const entry=map[key];
      values.add((typeof entry==='string'?(axis==='horizontal'?entry:null):entry?.[axis]) || (axis==='vertical'?'top':'left'));
    }
    return values.size===1?values.values().next().value:null;
  }

  setMerge(path, tid, reg) {
    const list = this.getMerges(path, tid);
    // Never discard an intersected merge unless the new rectangle contains it
    // completely. Callers must close their selection before changing content.
    const partial = list.some((m) => {
      const overlaps = reg.r < m.r + m.rowspan && m.r < reg.r + reg.rowspan &&
        reg.c < m.c + m.colspan && m.c < reg.c + reg.colspan;
      const contains = reg.r <= m.r && reg.c <= m.c &&
        reg.r + reg.rowspan >= m.r + m.rowspan && reg.c + reg.colspan >= m.c + m.colspan;
      return overlaps && !contains;
    });
    if (partial) return false;
    const kept = list.filter((m) => {
      return !(
        reg.r < m.r + m.rowspan &&
        m.r < reg.r + reg.rowspan &&
        reg.c < m.c + m.colspan &&
        m.c < reg.c + reg.colspan
      );
    });
    kept.push(reg);
    this.merges[path][tid] = kept;
    return true;
  }

  // ---- source-level table parsing --------------------------------------
  isTableRowLine(line) {
    const s = (line || '').trim();
    return s.includes('|') && !/^```/.test(s);
  }
  isSepLine(line) {
    const s = (line || '').trim();
    if (!s.includes('|')) return false;
    return this.splitRow(s).every((c) => /^\s*:?-+:?\s*$/.test(c));
  }
  splitRow(line) {
    let s = (line || '').trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    const out = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < s.length) { cur += ch + s[i + 1]; i++; continue; }
      if (ch === '|') { out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur.trim());
    return out;
  }
  buildRow(cells) {
    return '| ' + cells.join(' | ') + ' |';
  }
  tableSourceInfo(editor, table) {
    const doc = editor.getDoc();
    const cm = editor.cm;
    const cmDoc = cm && cm.state && cm.state.doc;
    const useCM = cmDoc && Number.isInteger(cmDoc.lines) && typeof cmDoc.line === 'function';
    const lineCount = useCM ? cmDoc.lines : typeof doc.lineCount === 'function' ? doc.lineCount() :
      Array.isArray(doc.lines) ? doc.lines.length : Number.isInteger(doc.lines) ? doc.lines : 0;
    const getLine = i => useCM ? cmDoc.line(i+1).text : typeof doc.getLine === 'function' ? doc.getLine(i) :
      typeof doc.line === 'function' ? doc.line(i+1).text : doc.lines[i];
    const starts = new Array(lineCount);
    let acc = 0;
    for (let i = 0; i < lineCount; i++) { starts[i] = acc; acc += (getLine(i) || '').length + 1; }
    const blocks = [];
    for (let i = 0; i + 1 < lineCount; i++) {
      const header = getLine(i) || '';
      const sep = getLine(i + 1) || '';
      if (!this.isTableRowLine(header) || !this.isSepLine(sep)) continue;
      const grid = [this.splitRow(header)];
      let endLine = i + 1;
      for (let j = i + 2; j < lineCount; j++) {
        const line = getLine(j) || '';
        if (!this.isTableRowLine(line)) break;
        grid.push(this.splitRow(line));
        endLine = j;
      }
      let markerLine = -1, marker = null;
      const directlyAbove = i > 0 ? (getLine(i - 1) || '').trim() : '';
      const twoLinesAbove = i > 1 ? (getLine(i - 2) || '').trim() : '';
      marker = directlyAbove.match(/^%%table-tune-id:([a-z0-9_-]+)%%$/i) ||
        directlyAbove.match(/^<!--\s*table-tune-id:([a-z0-9_-]+)\s*-->$/i);
      if (marker) markerLine = i - 1;
      if (!marker && directlyAbove === '') {
        marker = twoLinesAbove.match(/^<!--\s*table-tune-id:([a-z0-9_-]+)\s*-->$/i) ||
          twoLinesAbove.match(/^%%table-tune-id:([a-z0-9_-]+)%%$/i);
        if (marker) markerLine = i - 2;
      }
      blocks.push({
        grid, sep, startLine: i, endLine,
        uid: marker ? marker[1] : this.uidFromGrid(grid), markerLine,
      });
      i = endLine;
    }
    if (!blocks.length) return null;

    // Prefer CodeMirror's source position when available, but use a cell rather
    // than the synthetic table wrapper. During Live Preview re-render this call
    // can legitimately fail, so two deterministic fallbacks follow.
    const head = table.querySelector('thead th, thead td');
    const liveUid = head && this.decodeInvisibleUid(head.textContent || '');
    const uid = liveUid || (table.dataset && table.dataset.tableTuneUid);
    const uidMatches = uid ? blocks.filter(b => b.uid === uid) : [];
    let block = liveUid && uidMatches.length === 1 ? uidMatches[0] : null;
    const domHead = Array.from(table.querySelectorAll('thead th, thead td'))
      .map(c => {
        const content = c.querySelector && (c.querySelector('.table-cell-wrapper .cm-content') || c.querySelector('.table-cell-content'));
        return this.sourceCellText((content || c).textContent || '');
      });
    const sameShapeAndHeader = b => (!table.rows || b.grid.length === table.rows.length) &&
      b.grid[0].length === domHead.length && b.grid[0].every((v, i) => this.sourceCellText(v) === domHead[i]);
    if (!liveUid && block && table.rows && !sameShapeAndHeader(block)) block = null;
    try {
      const probe = table.querySelector('th,td') || table;
      const off = cm ? cm.posAtDOM(probe) : null;
      if (!block && typeof off === 'number') {
        const mapped = blocks.find((b) => off >= starts[b.startLine] && off <= starts[b.endLine] + (getLine(b.endLine) || '').length);
        // A header edit/undo may remove or change the invisible id while the
        // editor keeps the same DOM node. Recover only with a verified position
        // AND matching dimensions/header, never a stale ordinal alone.
        if (mapped && sameShapeAndHeader(mapped)) block = mapped;
      }
    } catch (e) { /* Keep an identity match when DOM mapping is unavailable. */ }
    const domTables = this.tablePeers(table);
    const ordinal = domTables.indexOf(table);
    if (!block && !uid && domTables.length === blocks.length && ordinal >= 0 && ordinal < blocks.length &&
      sameShapeAndHeader(blocks[ordinal])) block = blocks[ordinal];
    // Cached DOM identity is only a last resort: CodeMirror may reuse a node
    // previously belonging to a different table during a document rerender.
    if (!block && uidMatches.length === 1 && sameShapeAndHeader(uidMatches[0])) block = uidMatches[0];
    if (!block) {
      const matches = blocks.filter(b => (!uid || sameShapeAndHeader(b)) && b.grid[0].length === domHead.length &&
        b.grid[0].every((v, i) => this.sourceCellText(v) === domHead[i]));
      if (matches.length === 1) block = matches[0];
    }
    if (!block) return null;
    const { grid, sep, startLine, endLine, uid: blockUid, markerLine } = block;
    const from = starts[markerLine >= 0 ? markerLine : startLine];
    const to = starts[endLine] + (getLine(endLine) || '').length;
    return {
      grid,
      header: getLine(startLine),
      rowSources: grid.map((_, r) => {
        const line = startLine + r + (r ? 1 : 0);
        return { text: getLine(line), from: starts[line] };
      }),
      sep,
      startLine,
      endLine,
      uid: blockUid,
      markerLine,
      from,
      to,
      toPos: (off) => {
        if (typeof editor.offsetToPos === 'function') return editor.offsetToPos(off);
        const l = cm.state.doc.lineAt(off);
        return { line: l.number - 1, ch: off - l.from };
      },
    };
  }

  sourceCellText(value) {
    return this.stripTableIdentity(value || '')
      .replace(/<br\s*\/?>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/!??\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[\[([^\]|]*\|)?([^\]]+)\]\]/g, '$2')
      .replace(/[*_`~]/g, '')
      .replace(/\\\|/g, '|')
      .trim();
  }

  rowCellRanges(line) {
    const start = line.length - line.trimStart().length;
    const end = line.trimEnd().length;
    let from = start + (line[start] === '|' ? 1 : 0), stop = end;
    const pipes = [];
    for (let i = from; i < end; i++) {
      if (line[i] === '\\') { i++; continue; }
      if (line[i] === '|') pipes.push(i);
    }
    if (pipes[pipes.length - 1] === end - 1) { stop--; pipes.pop(); }
    const ranges = [];
    for (const to of [...pipes, stop]) {
      const raw = line.slice(from, to), text = raw.trim();
      const at = from + raw.length - raw.trimStart().length;
      ranges.push({ from: at, to: at + text.length, text });
      from = to + 1;
    }
    return ranges;
  }
  rewriteSourceMerge(editor, table, r1, c1, r2, c2) {
    const info = this.tableSourceInfo(editor, table);
    if (!info) return false;
    const { grid } = info;
    if (![r1, c1, r2, c2].every(Number.isInteger) || r1 < 0 || c1 < 0 ||
        r2 < r1 || c2 < c1 || r2 >= grid.length) return false;
    for (let r = r1; r <= r2; r++) if (!grid[r] || c2 >= grid[r].length) return false;
    const parts = [grid[r1][c1]];
    for (let cc = c1 + 1; cc <= c2; cc++) parts.push(grid[r1][cc]);
    for (let rr = r1 + 1; rr <= r2; rr++)
      for (let cc = c1; cc <= c2; cc++) parts.push(grid[rr][cc]);
    const combined = parts.map((p) => this.stripTableIdentity(p))
      .filter((p) => p && p.trim() !== '').join('<br>');
    const ng = grid.map((row) => row.slice());
    for (let rr = r1; rr <= r2; rr++)
      for (let cc = c1; cc <= c2; cc++) ng[rr][cc] = '';
    ng[r1][c1] = combined;
    // Give every actively merged table a zero-width persistent id. Earlier
    // builds used visible HTML/comment markers; remove them during this rewrite.
    const uid = info.uid || this.uidFromGrid(ng) || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    for (let c = 0; c < ng[0].length; c++) {
      ng[0][c] = this.stripTableIdentity(ng[0][c]);
    }
    ng[0][0] = this.encodeInvisibleUid(uid) + (ng[0][0] || '');
    // Keep every change inside ONE native cell. Replacing a whole table (or
    // even a range spanning two header cells) bypasses Obsidian's incremental
    // cell updates and tears down the live header editor, losing its content.
    if (!info.rowSources || info.rowSources.length !== grid.length) return false;
    const changes = [];
    for (let r = 0; r < grid.length; r++) {
      const row = info.rowSources[r], ranges = this.rowCellRanges(row.text);
      if (ranges.length !== grid[r].length || ranges.some((range,c) => range.text !== grid[r][c])) return false;
      for (let c = 0; c < grid[r].length; c++) {
        if (ng[r][c] === grid[r][c]) continue;
        const range = ranges[c], before = range.text, after = ng[r][c];
        let prefix = 0, suffix = 0;
        while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
        while (suffix < before.length-prefix && suffix < after.length-prefix && before[before.length-1-suffix] === after[after.length-1-suffix]) suffix++;
        changes.push({from:row.from+range.from+prefix,to:row.from+range.to-suffix,insert:after.slice(prefix,after.length-suffix)});
      }
    }
    try {
      // One atomic CodeMirror transaction lets the native table reconcile all
      // changed cells without replacing any editor or table DOM.
      this.dispatchTableChanges(editor,changes,info.toPos);
    } catch (e) { return null; }
    return { tid: 'u' + uid };
  }

  mergeSelectedCells() {
    let sel = this._sel;
    if (!sel || sel.axis) return;
    if (sel.table.isConnected === false || (this.app && this.currentPath() !== sel.path)) {
      this.clearMergeSelection();
      new Notice('TableTune: 表格已刷新或笔记已切换，请重新框选');
      return;
    }
    this.selectRect(sel.table, sel.r1, sel.c1, sel.r2, sel.c2, sel.path, sel.tid);
    sel = this._sel;
    if (this.selectionCells(sel).size < 2) return;
    if (this.isMergeRegion(sel)) return;
    const editor = this.activeEditor();
    if (!editor) { new Notice('TableTune: merge cells is available in Edit mode only'); return; }
    if (!this.selectionIsRectangle(sel)) {
      new Notice('TableTune: 当前选区包含完整合并格后不是连续矩形，请调整拖拽范围');
      return;
    }
    const previousRegions = this.effectiveMerges(sel.table, sel.path, sel.tid)
      .map((m) => ({ ...m }));
    const priorHeights = this.getRowHeights(sel.path, sel.tid);
    const mergedHeight = this.preserveSelectedRowHeights(sel.table, sel.path, sel.tid, sel.r1, sel.r2);
    const editTables = Array.from(document.querySelectorAll('.cm-content table'));
    const tableOrdinal = Math.max(0, editTables.indexOf(sel.table));
    const result = this.rewriteSourceMerge(editor, sel.table, sel.r1, sel.c1, sel.r2, sel.c2);
    if (!result) {
      if (priorHeights) this.setRowHeights(sel.path, sel.tid, priorHeights);
      else if (this.rowHeights[sel.path]) delete this.rowHeights[sel.path][sel.tid];
      new Notice('TableTune: 无法定位完整表格，合并已取消'); return;
    }
    const oldTid = sel.tid;
    const newTid = result.tid;
    if (newTid !== oldTid) this.adoptStableTableId(sel.table, sel.path, oldTid, newTid);
    if (!this.merges[sel.path]) this.merges[sel.path] = {};
    this.merges[sel.path][newTid] = previousRegions;
    const reg = {
      r: sel.r1, c: sel.c1,
      rowspan: sel.r2 - sel.r1 + 1, colspan: sel.c2 - sel.c1 + 1,
      height: mergedHeight > 0 ? Math.round(mergedHeight) + 'px' : undefined,
    };
    this.setMerge(sel.path, newTid, reg);
    this.persist();
    this.clearMergeSelection();
    // The source edit invalidates the current Live Preview DOM. Do not mutate
    // that stale table: wait for the new node, migrate a changed header-based
    // id if needed, and enhance only the fresh render.
    this.rekeyAfterSourceChange(sel.path, newTid, tableOrdinal, sel.table);
  }

  preserveSelectedRowHeights(table, path, tid, r1, r2) {
    const previous = this.getRowHeights(path, tid) || [];
    const heights = previous.slice();
    const tracks = table.classList && table.classList.contains('tcr-grid-table') &&
      typeof getComputedStyle === 'function'
      ? getComputedStyle(table).gridTemplateRows.split(' ').map(parseFloat) : [];
    let total = 0;
    for (let r = r1; r <= r2; r++) {
      const row = table.rows[r];
      const measured = row && row.getBoundingClientRect ? row.getBoundingClientRect().height : 0;
      const px = Math.max(measured, tracks[r] || 0, parseFloat(heights[r]) || 0, 24);
      heights[r] = Math.ceil(px) + 'px';
      total += px;
    }
    this.setRowHeights(path, tid, heights);
    return total;
  }

  adoptStableTableId(table, path, oldTid, newTid) {
    for (const store of [this.widths, this.rowHeights, this.tableDims, this.alignments || {}]) {
      if (!store[path] || store[path][oldTid] === undefined) continue;
      store[path][newTid] = store[path][oldTid];
    }
    if (!this.merges[path]) this.merges[path] = {};
    // Carry forward only legacy merges that visibly still have a non-empty
    // anchor. This discards stale empty-table records that caused missing cells.
    const grid = Array.from(table.rows).map((row) => Array.from(row.cells));
    const legacy = (this.merges[path][oldTid] || []).filter((reg) => {
      const anchor = grid[reg.r] && grid[reg.r][reg.c];
      return !!(anchor && (anchor.textContent || '').trim());
    });
    this.merges[path][newTid] = legacy;
  }

  deleteSelectedRows() { this.deleteSelectionAxis('row'); }
  deleteSelectedColumns() { this.deleteSelectionAxis('col'); }

  insertTableAxis(table, axis, at) {
    const editor = this.activeEditor(), path = table.dataset.tcrPath || this.currentPath();
    if (!editor || table.isConnected === false || path !== this.currentPath()) return;
    const info = this.tableSourceInfo(editor, table);
    if (!info) { new Notice('TableTune: 无法定位表格源码，插入已取消'); return; }
    const grid = info.grid.map(row => row.slice()), oldRows = grid.length, oldCols = grid[0].length;
    const total = axis === 'row' ? oldRows : oldCols;
    if (!Number.isInteger(at) || at < 0 || at > total || grid.some(row => row.length !== oldCols)) return;
    const oldTid = info.uid ? 'u'+info.uid : this.tableId(table), uid = info.uid || this.uidFromGrid(grid) || ('m'+Date.now().toString(36)+Math.random().toString(36).slice(2,8));
    const tid = 'u'+uid;
    const regions = this.validMergeRegions({rows:grid.map(cells=>({cells}))}, (this.merges[path]?.[oldTid] || [])).map(m=>({...m}));
    grid[0] = grid[0].map(v => this.stripTableIdentity(v));
    const sep = this.splitRow(info.sep);
    if (axis === 'row') grid.splice(at,0,Array(oldCols).fill(''));
    else { grid.forEach(row=>row.splice(at,0,'')); sep.splice(at,0,'---'); }
    grid[0][0] = this.encodeInvisibleUid(uid)+grid[0][0];
    const lines = [this.buildRow(grid[0]),this.buildRow(sep),...grid.slice(1).map(row=>this.buildRow(row))];
    const widths = (this.getWidths(path,oldTid,oldCols) || Array.from(table.querySelector('colgroup')?.children || [], c=>c.style.width)).slice();
    while (widths.length < oldCols) widths.push('80px');
    const heights = (this.getRowHeights(path,oldTid) || Array(oldRows).fill(null)).slice();
    while (heights.length < oldRows) heights.push(null);
    if (axis === 'col') widths.splice(at,0,'80px'); else heights.splice(at,0,null);
    try { this.replaceTableRange(editor,lines.join('\n'),info.toPos(info.from),info.toPos(info.to)); }
    catch (e) { new Notice('TableTune: 插入失败'); return; }
    this.setWidths(path,tid,widths); this.setRowHeights(path,tid,heights);
    if (!this.merges[path]) this.merges[path]={};
    this.merges[path][tid]=this.adjustMergesForDimension(regions,axis,total,total+1,at);
    if(this.alignments?.[path]?.[oldTid])this.alignments[path][tid]=this.remapAlignments(this.alignments[path][oldTid],axis,i=>i>=at?i+1:i);
    if (!this.tableDims[path]) this.tableDims[path]={};
    this.tableDims[path][tid]={rows:grid.length,cols:grid[0].length};
    const ordinal=Array.from(document.querySelectorAll('.cm-content table')).indexOf(table);
    this.clearMergeSelection(); this.persist();
    this.rekeyAfterSourceChange(path,tid,Math.max(0,ordinal),table);
  }

  // Delete complete rows/columns only; individual cells are deliberately not
  // deletable. Merge anchors move to the first surviving cell, spans shrink,
  // and a 1x1 remainder automatically becomes a normal cell.
  deleteSelectionAxis(axis) {
    const sel = this._sel;
    const editor = this.activeEditor();
    if (!sel || !editor) {
      new Notice('TableTune: 请先在编辑模式中框选表格单元格');
      return;
    }
    if (sel.axis && ((axis === 'row') !== (sel.axis === 'row'))) return;
    if (sel.table.isConnected === false || (this.app && this.currentPath() !== sel.path)) {
      this.clearMergeSelection();
      new Notice('TableTune: 表格已刷新或笔记已切换，请重新选择');
      return;
    }
    const editTables = Array.from(document.querySelectorAll('.cm-content table'));
    const tableOrdinal = Math.max(0, editTables.indexOf(sel.table));
    const info = this.tableSourceInfo(editor, sel.table);
    if (!info) {
      new Notice('TableTune: 无法定位表格源码，删除已取消');
      return;
    }
    // Source identity wins over a cached id from before a header edit/undo.
    if (info.uid) sel.tid = 'u' + info.uid;
    const oldGrid = info.grid.map((row) => row.slice());
    const rowCount = oldGrid.length;
    const colCount = oldGrid.reduce((n, row) => Math.max(n, row.length), 0);
    const total = axis === 'row' ? rowCount : colCount;
    const first = axis === 'row' ? sel.r1 : sel.c1, last = axis === 'row' ? sel.r2 : sel.c2;
    const indices = sel.axis && sel.indices ? Array.from(sel.indices) :
      Array.from({ length: last-first+1 }, (_, i) => first+i);
    if (!indices.length || indices.some(i => !Number.isInteger(i) || i < 0 || i >= total)) return;
    const deleted = new Set(indices);
    if (deleted.size === total) {
      try { this.replaceTableRange(editor,'', info.toPos(info.from), info.toPos(info.to)); }
      catch (e) { new Notice('TableTune: 表格删除失败'); return; }
      for (const store of [this.widths, this.rowHeights, this.merges, this.tableDims, this.alignments || {}])
        if (store[sel.path]) delete store[sel.path][sel.tid];
      this.clearMergeSelection(); this.persist();
      return;
    }

    while (oldGrid.some((row) => row.length < colCount)) {
      oldGrid.forEach((row) => { while (row.length < colCount) row.push(''); });
    }
    const removed = (i) => deleted.has(i);
    const regions = this.validMergeRegions({rows: oldGrid.map(cells => ({cells}))},
      ((this.merges[sel.path] && this.merges[sel.path][sel.tid]) || []))
      .map((m) => ({ ...m }));
    const alignmentMap=this.alignments?.[sel.path]?.[sel.tid] ? {...this.alignments[sel.path][sel.tid]} : null;

    // If an anchor is removed while part of its merge survives, carry its full
    // content to the new top-left anchor before deleting the source row/column.
    for (const m of regions) {
      const rows = [];
      const cols = [];
      for (let r = m.r; r < m.r + m.rowspan; r++) if (axis !== 'row' || !removed(r)) rows.push(r);
      for (let c = m.c; c < m.c + m.colspan; c++) if (axis !== 'col' || !removed(c)) cols.push(c);
      if (!rows.length || !cols.length) continue;
      if ((axis === 'row' && removed(m.r)) || (axis === 'col' && removed(m.c))) {
        oldGrid[rows[0]][cols[0]] = oldGrid[m.r][m.c];
        if(alignmentMap?.[m.r+','+m.c])alignmentMap[rows[0]+','+cols[0]]=alignmentMap[m.r+','+m.c];
      }
    }

    const newGrid = axis === 'row'
      ? oldGrid.filter((_, r) => !removed(r))
      : oldGrid.map((row) => row.filter((_, c) => !removed(c)));
    const stableUid = info.uid || this.uidFromGrid(newGrid);
    if (newGrid[0]) {
      newGrid[0] = newGrid[0].map((v) => this.stripTableIdentity(v));
      if (stableUid) newGrid[0][0] = this.encodeInvisibleUid(stableUid) + (newGrid[0][0] || '');
    }
    const sepCells = this.splitRow(info.sep);
    while (sepCells.length < colCount) sepCells.push('---');
    const newSep = axis === 'col' ? sepCells.filter((_, c) => !removed(c)) : sepCells;
    const lines = [this.buildRow(newGrid[0]), this.buildRow(newSep)];
    for (let r = 1; r < newGrid.length; r++) lines.push(this.buildRow(newGrid[r]));
    try {
      this.replaceTableRange(editor,lines.join('\n'), info.toPos(info.from), info.toPos(info.to));
    } catch (e) {
      new Notice('TableTune: 表格删除失败');
      return;
    }

    const before = (i) => i - indices.filter(index => index < i).length;
    if(alignmentMap)this.alignments[sel.path][sel.tid]=this.remapAlignments(alignmentMap,axis,i=>removed(i)?null:before(i));
    const nextRegions = [];
    for (const m of regions) {
      const rows = [], cols = [];
      for (let r = m.r; r < m.r + m.rowspan; r++) if (axis !== 'row' || !removed(r)) rows.push(r);
      for (let c = m.c; c < m.c + m.colspan; c++) if (axis !== 'col' || !removed(c)) cols.push(c);
      if (!rows.length || !cols.length) continue;
      const reg = {
        r: axis === 'row' ? before(rows[0]) : rows[0],
        c: axis === 'col' ? before(cols[0]) : cols[0],
        rowspan: rows.length,
        colspan: cols.length,
      };
      if (reg.rowspan > 1 || reg.colspan > 1) nextRegions.push(reg);
    }
    if (!this.merges[sel.path]) this.merges[sel.path] = {};
    this.merges[sel.path][sel.tid] = nextRegions;

    if (axis === 'row') {
      const heights = this.getRowHeights(sel.path, sel.tid);
      if (heights) this.setRowHeights(sel.path, sel.tid, heights.filter((_, r) => !removed(r)));
    } else {
      const widths = this.getWidths(sel.path, sel.tid, colCount);
      if (widths) this.setWidths(sel.path, sel.tid, widths.filter((_, c) => !removed(c)));
    }
    if (!this.tableDims[sel.path]) this.tableDims[sel.path] = {};
    this.tableDims[sel.path][sel.tid] = {
      rows: newGrid.length,
      cols: newGrid[0] ? newGrid[0].length : 0,
    };
    this.clearMergeSelection();
    this.persist();
    this.rekeyAfterSourceChange(sel.path, sel.tid, tableOrdinal, sel.table);
  }

  // A table id is derived from its header. Deleting the header or a column can
  // therefore change that id. Once Live Preview has rendered the edited source,
  // move all saved state to the new id of the same table in document order.
  rekeyAfterSourceChange(path, oldTid, tableOrdinal, sourceTable) {
    const root = sourceTable?.closest?.('.cm-content, .markdown-preview-view');
    setTimeout(() => {
      if (path !== this.currentPath()) return;
      const tables = Array.from((root || document).querySelectorAll(root ? 'table' : '.cm-content table'));
      const stable = oldTid.startsWith('u');
      // Never transfer a stable table's metadata to a positional neighbour.
      // Partial rendering/virtualization can change both table count and order.
      const matching = stable ? tables.filter(t => {
        const head = t.querySelector('thead th, thead td');
        const marker = t.querySelector('[data-table-tune-id]');
        const uid = (head && this.decodeInvisibleUid(head.textContent || '')) || marker?.getAttribute('data-table-tune-id');
        return uid && 'u'+uid === oldTid;
      }) : [];
      const table = stable ? (matching.length === 1 ? matching[0] : null) : tables[tableOrdinal];
      if (!table) return;
      const newTid = this.tableId(table);
      if (newTid !== oldTid && !stable) {
        for (const store of [this.widths, this.rowHeights, this.merges, this.tableDims, this.alignments || {}]) {
          if (!store[path] || store[path][oldTid] === undefined) continue;
          store[path][newTid] = store[path][oldTid];
          delete store[path][oldTid];
        }
        this.persist();
      }
      delete table.dataset.tcr;
      this.enhance(table, { sourcePath: path }, true);
      this.processActive();
    }, 120);
  }

  splitRegion(path, tid, reg) {
    const list = this.getMerges(path, tid);
    const idx = list.findIndex((m) => m.r === reg.r && m.c === reg.c && m.rowspan === reg.rowspan && m.colspan === reg.colspan);
    if (idx < 0) return;
    list.splice(idx, 1);
    this.clearMergeSelection();
    this.persist();
    document.querySelectorAll('table[data-tcr]').forEach((t) => {
      if (t.dataset.tcrPath === path && this.tableId(t) === tid) {
        this.applyRowHeights(t, path, tid);
        this.applyMerges(t, path, tid);
      }
    });
  }

  installSelectedCellCommands() {
    const commands=this.app?.commands;
    if(this._selectedCommandBinding || typeof commands?.executeCommand!=='function')return;
    const plugin=this,original=commands.executeCommand;
    const wrapped=function(command,event,...args){
      // Obsidian's hotkey scope executes at window capture, before our document
      // key listener. Intercept only bold's command, not the global keymap.
      if(command?.id==='editor:toggle-bold' && plugin.handleSelectedCellKey({
        key:'b',ctrlKey:true,isComposing:event?.isComposing,
        target:event?.target || document.activeElement || document.body,
        preventDefault:()=>event?.preventDefault?.(),
        stopImmediatePropagation:()=>event?.stopImmediatePropagation?.(),
      }))return true;
      return original.call(this,command,event,...args);
    };
    commands.executeCommand=wrapped;
    this._selectedCommandBinding={commands,original,wrapped};
  }

  uninstallSelectedCellCommands() {
    const binding=this._selectedCommandBinding;
    if(binding && binding.commands.executeCommand===binding.wrapped)binding.commands.executeCommand=binding.original;
    this._selectedCommandBinding=null;
  }

  handleSelectedCellKey(e) {
    const key=e.key?.toLowerCase(),bold=(e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && key==='b';
    const clear=key==='delete' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    if((!bold && !clear) || e.isComposing || e.target.closest?.('input,textarea,.modal'))return false;
    const sel=this._sel,editor=this.activeEditor(),session=editor?.editorComponent?.tableCell;
    if(!sel || !sel.table.isConnected || this.currentPath()!==sel.path || !editor)return false;
    if(!(editor.cm?.dom?.contains(e.target) || session?.cm?.contentDOM?.contains(e.target) ||
      sel.table.contains(e.target) || e.target.closest?.('.tcr-merge-toolbar,.tcr-axis-rail') ||
      e.target===document.body))return false;
    e.preventDefault();e.stopImmediatePropagation();
    this.clearSelectedCellContents(bold?'bold':'clear');
    return true;
  }

  clearSelectedCellContents(mode='clear') {
    const sel=this._sel,editor=this.activeEditor();
    if(!sel || !editor || !sel.table.isConnected || this.currentPath()!==sel.path)return;
    const info=this.tableSourceInfo(editor,sel.table);
    if(!info?.rowSources)return new Notice('TableTune: 无法定位表格，清空已取消');
    const selected=this.alignmentSelectionCells(sel),changes=[];
    const texts=info.grid.flatMap((row,r)=>row.filter((text,c)=>selected.has(r+','+c))
      .map(text=>this.stripTableIdentity(text).trim())).filter(Boolean);
    const unbold=mode==='bold' && texts.length>0 && texts.every(text=>/^\*\*[\s\S]*\*\*$/.test(text));
    const needsId=Array.from(selected).some(k=>k.startsWith('0,'));
    const uid=info.uid || (needsId?'m'+Date.now().toString(36)+Math.random().toString(36).slice(2,8):null);
    for(let r=0;r<info.grid.length;r++){
      const row=info.rowSources[r],ranges=this.rowCellRanges(row.text);
      if(ranges.length!==info.grid[r].length)return new Notice('TableTune: 表格结构不完整，清空已取消');
      for(let c=0;c<ranges.length;c++){
        const range=ranges[c];
        let after=range.text;
        if(selected.has(r+','+c)){
          after='';
          if(mode==='bold'){
            const text=this.stripTableIdentity(range.text).trim(),already=/^\*\*[\s\S]*\*\*$/.test(text);
            after=!text?range.text:unbold?text.slice(2,-2):already?text:'**'+text+'**';
          }
        }
        if(r===0 && c===0 && uid)after=this.encodeInvisibleUid(uid)+this.stripTableIdentity(after);
        if(after!==range.text)changes.push({from:row.from+range.from,to:row.from+range.to,insert:after});
      }
    }
    if(!changes.length)return;
    this.dispatchTableChanges(editor,changes,info.toPos);
    const tid=uid?'u'+uid:sel.tid;
    if(tid!==sel.tid)this.adoptStableTableId(sel.table,sel.path,sel.tid,tid);
    const ordinal=this.tablePeers(sel.table).indexOf(sel.table);
    this.clearMergeSelection();
    this.persist();
    this.rekeyAfterSourceChange(sel.path,tid,ordinal,sel.table);
  }

  splitSelectedCell() {
    const sel = this._sel;
    if (!sel || sel.axis || !this.isMergeRegion(sel)) return;
    this.splitRegion(sel.path, sel.tid, {
      r: sel.r1, c: sel.c1, rowspan: sel.r2 - sel.r1 + 1, colspan: sel.c2 - sel.c1 + 1,
    });
  }

  // ---- table clipboard (separate from ordinary text editing) ----------
  clipboardSize(value) {
    if(typeof value!=='number' && (typeof value!=='string' || !/^\d+(?:\.\d+)?(?:px)?$/.test(value.trim())))return null;
    const size=parseFloat(value);
    return Number.isFinite(size) && size>0 && size<=100000 ? size+'px' : null;
  }

  clipboardLayout(table,path,tid,rows,cols) {
    const savedWidths=this.getWidths(path,tid,table.rows[0]?.cells.length || 0) || [];
    const savedHeights=this.getRowHeights(path,tid) || [];
    const tracks=table.classList.contains('tcr-grid-table') ? getComputedStyle(table).gridTemplateRows.split(' ') : [];
    const columns=Array.from(table.querySelector('colgroup')?.children || []);
    return {
      columnWidths:cols.map(c=>this.clipboardSize(columns[c]?.getBoundingClientRect().width) ||
        this.clipboardSize(columns[c]?.style.width) || this.clipboardSize(savedWidths[c]) ||
        this.clipboardSize(Array.from(table.rows).map(row=>row.cells[c]).find(cell=>cell && !cell.classList.contains('tcr-merged-hidden') && cell.colSpan===1)?.getBoundingClientRect().width)),
      rowHeights:rows.map(r=>this.clipboardSize(tracks[r]) || this.clipboardSize(table.rows[r]?.getBoundingClientRect().height) || this.clipboardSize(savedHeights[r])),
    };
  }

  handleTableCopy(e) {
    const editor=this.activeEditor();
    const whole=editor?.cm?.dom?.querySelector('.cm-table-widget.is-selected table[data-tcr]');
    const sel=this._sel || (whole && {table:whole,path:whole.dataset.tcrPath,tid:this.tableId(whole),r1:0,c1:0,r2:whole.rows.length-1,c2:whole.rows[0].cells.length-1});
    if(!sel || !sel.table.isConnected || sel.path!==this.currentPath() || !e.clipboardData ||
      e.target?.closest?.('input,textarea,.modal'))return false;
    const root=sel.table.closest('.cm-content'),targetRoot=e.target?.closest?.('.cm-content');
    if(root&&targetRoot&&!root.contains(e.target))return false;
    const info=editor && this.tableSourceInfo(editor,sel.table);
    if(!info)return false;
    const rows=sel.axis==='row'?[...sel.indices].sort((a,b)=>a-b):Array.from({length:sel.r2-sel.r1+1},(_,i)=>sel.r1+i);
    const cols=sel.axis==='column'?[...sel.indices].sort((a,b)=>a-b):Array.from({length:sel.c2-sel.c1+1},(_,i)=>sel.c1+i);
    const regions=this.effectiveMerges(sel.table,sel.path,sel.tid);
    const complete=regions.filter(m=>
      Array.from({length:m.rowspan},(_,i)=>m.r+i).every(r=>rows.includes(r)) &&
      Array.from({length:m.colspan},(_,i)=>m.c+i).every(c=>cols.includes(c)));
    const grid=rows.map(r=>cols.map(c=>{
      const m=regions.find(m=>this.regionContains(m,r,c));
      return m&&!complete.includes(m)?'':this.stripTableIdentity(info.grid[r]?.[c] || '');
    }));
    const merges=complete
      .map(m=>({r:rows.indexOf(m.r),c:cols.indexOf(m.c),rowspan:m.rowspan,colspan:m.colspan}));
    const layout=this.clipboardLayout(sel.table,sel.path,sel.tid,rows,cols);
    const alignment=cols.map(()=>null),payload={version:2,rows:grid,merges,...layout};
    const plain=grid.map(row=>row.map(v=>{
      const text=this.sourceCellText(v.replace(/<br\s*\/?>/gi,'\n'));
      return /[\t\n"]/.test(text)?'"'+text.replace(/"/g,'""')+'"':text;
    }).join('\t')).join('\n');
    const html=document.createElement('table');
    html.style.tableLayout='fixed';html.style.borderCollapse='collapse';
    const colgroup=html.appendChild(document.createElement('colgroup'));
    layout.columnWidths.forEach(width=>{const col=colgroup.appendChild(document.createElement('col'));if(width)col.style.width=width;});
    if(layout.columnWidths.every(Boolean))html.style.width=layout.columnWidths.reduce((sum,w)=>sum+parseFloat(w),0)+'px';
    grid.forEach((row,r)=>{const tr=html.insertRow();if(layout.rowHeights[r])tr.style.height=layout.rowHeights[r];row.forEach((value,c)=>{
      const m=merges.find(m=>this.regionContains(m,r,c));if(m&&(m.r!==r||m.c!==c))return;
      const td=tr.insertCell();if(m){td.rowSpan=m.rowspan;td.colSpan=m.colspan;}
      value.split(/<br\s*\/?>/gi).forEach((part,i)=>{if(i)td.appendChild(document.createElement('br'));td.appendChild(document.createTextNode(this.sourceCellText(part)));});
    });});
    try {
      e.clipboardData.setData('text/plain',plain);
      e.clipboardData.setData('text/html',html.outerHTML);
      e.clipboardData.setData('obsidian/table',JSON.stringify({rows:grid,alignment}));
      e.clipboardData.setData('application/x-table-tune',JSON.stringify(payload));
    }catch(error){return false;}
    e.preventDefault();e.stopImmediatePropagation();return true;
  }

  clipboardTable(data,allowSingle=false) {
    const valid=payload=>{
      const rows=payload?.rows;
      if(!Array.isArray(rows)||!rows.length||rows.length>1000)return null;
      const width=Math.max(...rows.map(row=>Array.isArray(row)?row.length:0));
      if(!width||width>1000||width*rows.length>100000||rows.some(row=>!Array.isArray(row)||row.some(v=>typeof v!=='string')))return null;
      const grid=rows.map(row=>Array.from({length:width},(_,c)=>this.stripTableIdentity(row[c] || '').replace(/\r?\n/g,'<br>')));
      const merges=this.validMergeRegions({rows:grid.map(cells=>({cells}))},Array.isArray(payload.merges)?payload.merges.slice(0,grid.length*width):[]);
      const sizes=(values,count)=>Array.from({length:count},(_,i)=>this.clipboardSize(Array.isArray(values)?values[i]:null));
      return {rows:grid,merges,columnWidths:sizes(payload.columnWidths,width),rowHeights:sizes(payload.rowHeights,grid.length)};
    };
    for(const type of ['application/x-table-tune','obsidian/table']){
      const raw=data.getData(type);if(raw)try{const parsed=valid(JSON.parse(raw));if(parsed)return parsed;}catch(error){}
    }
    const html=data.getData('text/html');
    if(html){
      const doc=new DOMParser().parseFromString(html,'text/html'),table=doc.querySelector('table');
      if(table){
        const rows=[],merges=[],columnWidths=[],rowHeights=[];let invalid=false;
        table.querySelectorAll('colgroup > col').forEach(col=>{
          if(col.closest('table')!==table)return;
          const size=this.clipboardSize(col.style.width || col.getAttribute('width'));
          for(let i=0;i<Math.min(1000,col.span||1) && columnWidths.length<1000;i++)columnWidths.push(size);
        });
        Array.from(table.rows).filter(tr=>tr.closest('table')===table).forEach((tr,r)=>{
          if(r>=1000){invalid=true;return;}rows[r] ||= [];let c=0;
          rowHeights[r]=this.clipboardSize(tr.style.height || tr.getAttribute('height'));
          Array.from(tr.cells).forEach(cell=>{
            while(rows[r][c]!==undefined)c++;
            const rs=Math.min(1000,cell.rowSpan||1),cs=Math.min(1000,cell.colSpan||1);
            if(c+cs>1000||r+rs>1000||(r+rs)*(c+cs)>100000){invalid=true;return;}
            const cellWidth=this.clipboardSize(cell.style.width || cell.getAttribute('width'));
            if(cellWidth && cs===1 && !columnWidths[c])columnWidths[c]=cellWidth;
            if(rs===1 && !rowHeights[r])rowHeights[r]=this.clipboardSize(cell.style.height || cell.getAttribute('height'));
            const copy=cell.cloneNode(true);copy.querySelectorAll('script,style').forEach(n=>n.remove());
            copy.querySelectorAll('br').forEach(br=>br.replaceWith('\n'));
            copy.querySelectorAll('p,div,li').forEach(block=>block.appendChild(doc.createTextNode('\n')));
            rows[r][c]=copy.textContent.trim().replace(/\r?\n/g,'<br>');
            if(rs>1||cs>1)merges.push({r,c,rowspan:rs,colspan:cs});
            for(let rr=r;rr<r+rs;rr++){rows[rr] ||= [];for(let cc=c;cc<c+cs;cc++)if(rr!==r||cc!==c)rows[rr][cc]='';}
            c+=cs;
          });
        });
        if(!invalid)return valid({rows,merges,columnWidths,rowHeights});return null;
      }
    }
    const text=data.getData('text/plain');
    const markdown=data.getData('text/markdown') || text;
    if(markdown){
      const lines=markdown.trim().split(/\r?\n/);
      if(lines.length>=2&&this.isTableRowLine(lines[0])&&this.isSepLine(lines[1])&&lines.slice(2).every(line=>this.isTableRowLine(line)))
        return valid({rows:[this.splitRow(lines[0]),...lines.slice(2).map(line=>this.splitRow(line))]});
    }
    if(!text || (!allowSingle&&!text.includes('\t')))return null;
    // Quoted TSV preserves spreadsheet cells containing line breaks/tabs.
    const rows=[[]];let value='',quoted=false;
    for(let i=0;i<text.length;i++){
      const ch=text[i];
      if(ch==='"' && (quoted || value==='')){if(quoted&&text[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}
      else if(!quoted&&(ch==='\t'||ch==='\n'||ch==='\r')){
        rows.at(-1).push(value);value='';if(ch!=='\t'){if(ch==='\r'&&text[i+1]==='\n')i++;rows.push([]);}
      }else value+=ch;
    }
    if(quoted)return null;
    rows.at(-1).push(value);if(rows.length>1&&rows.at(-1).length===1&&rows.at(-1)[0]==='')rows.pop();
    return valid({rows});
  }

  handleTablePaste(e) {
    if(!e.clipboardData||e.target?.closest?.('input,textarea,.modal'))return false;
    const cell=e.target?.closest?.('td,th'),targetTable=cell?.closest('table[data-tcr]');
    const sel=this._sel&&(!targetTable||targetTable===this._sel.table)?this._sel:null,table=targetTable || sel?.table;
    if(!table)return this.pasteNewClipboardTable(e);
    if(!table.isConnected || table.closest('.cm-table-widget.is-selected'))return false;
    const root=table.closest('.cm-content'),targetRoot=e.target?.closest?.('.cm-content');
    if(root&&targetRoot&&!root.contains(e.target))return false;
    const path=table.dataset.tcrPath || this.currentPath(),editor=this.activeEditor();
    if(!editor || path!==this.currentPath())return false;
    const payload=this.clipboardTable(e.clipboardData,!!sel);if(!payload)return false;
    // Once identified as a matrix, never fall through to native single-cell
    // text paste if source verification or merge checks fail.
    e.preventDefault();e.stopImmediatePropagation();
    const info=this.tableSourceInfo(editor,table);
    if(!info){new Notice('TableTune: 无法定位表格源码，粘贴已取消');return true;}
    const r=sel?sel.r1:this.cellRow(cell),c=sel?sel.c1:this.cellCol(cell);
    if(r<0||c<0)return true;
    const height=payload.rows.length,width=payload.rows[0].length,oldTid=info.uid?'u'+info.uid:(sel?.tid || this.tableId(table));
    const regions=this.effectiveMerges(table,path,oldTid).map(m=>({...m}));
    const overlaps=m=>m.r<r+height&&m.r+m.rowspan>r&&m.c<c+width&&m.c+m.colspan>c;
    if(regions.some(m=>overlaps(m)&&!(r<=m.r&&c<=m.c&&r+height>=m.r+m.rowspan&&c+width>=m.c+m.colspan))){
      new Notice('TableTune: 粘贴范围只覆盖了部分合并单元格，请先拆分或选择完整区域');return true;
    }
    const grid=info.grid.map(row=>row.slice()),cols=Math.max(grid[0].length,c+width),rows=Math.max(grid.length,r+height);
    if(rows*cols>100000){new Notice('TableTune: 粘贴范围过大');return true;}
    while(grid.length<rows)grid.push([]);grid.forEach(row=>{while(row.length<cols)row.push('');});
    const escape=value=>value.replace(/(?<!\\)\|/g,'\\|');
    payload.rows.forEach((row,rr)=>row.forEach((value,cc)=>grid[r+rr][c+cc]=escape(value)));
    grid[0]=grid[0].map(value=>this.stripTableIdentity(value));
    const uid=info.uid || ('m'+Date.now().toString(36)+Math.random().toString(36).slice(2,8)),tid='u'+uid;
    grid[0][0]=this.encodeInvisibleUid(uid)+grid[0][0];
    const sep=this.splitRow(info.sep);while(sep.length<cols)sep.push('---');
    const text=[this.buildRow(grid[0]),this.buildRow(sep),...grid.slice(1).map(row=>this.buildRow(row))].join('\n');
    try{this.replaceTableRange(editor,text,info.toPos(info.from),info.toPos(info.to));}
    catch(error){new Notice('TableTune: 表格粘贴失败');return true;}
    for(const store of [this.widths,this.rowHeights,this.alignments])if(store?.[path]?.[oldTid]!==undefined){store[path][tid]=JSON.parse(JSON.stringify(store[path][oldTid]));}
    this.merges[path] ||= {};this.merges[path][tid]=regions.filter(m=>!overlaps(m)).concat(payload.merges.map(m=>({...m,r:r+m.r,c:c+m.c})));
    this.tableDims[path] ||= {};this.tableDims[path][tid]={rows,cols};
    const widths=(this.getWidths(path,tid,cols)||[]).slice();while(widths.length<cols)widths.push('80px');
    payload.columnWidths.forEach((size,i)=>{if(size)widths[c+i]=size;});this.setWidths(path,tid,widths);
    const heights=(this.getRowHeights(path,tid)||[]).slice();while(heights.length<rows)heights.push(null);
    payload.rowHeights.forEach((size,i)=>{if(size)heights[r+i]=size;});this.setRowHeights(path,tid,heights);
    this.clearMergeSelection();this.persist();
    this.rekeyAfterSourceChange(path,tid,Math.max(0,this.tablePeers(table).indexOf(table)),table);
    return true;
  }

  pasteNewClipboardTable(e) {
    const editor=this.activeEditor(),root=e.target?.closest?.('.cm-content');
    if(!editor?.getCursor || !root || !editor.cm?.dom?.contains(e.target))return false;
    const payload=this.clipboardTable(e.clipboardData);if(!payload)return false;
    const from=editor.getCursor('from'),to=editor.getCursor('to'),path=this.currentPath();
    // Never replace an ordinary text selection spanning existing tables.
    const doc=editor.getDoc(),line=i=>doc.getLine(i);
    for(let i=from.line;i<=to.line;i++)if(this.isTableRowLine(line(i)))return false;
    e.preventDefault();e.stopImmediatePropagation();
    const uid='m'+Date.now().toString(36)+Math.random().toString(36).slice(2,8),tid='u'+uid;
    const grid=payload.rows.map(row=>row.map(text=>text.replace(/(?<!\\)\|/g,'\\|')));
    grid[0][0]=this.encodeInvisibleUid(uid)+grid[0][0];
    const text=[this.buildRow(grid[0]),this.buildRow(grid[0].map(()=> '---')),...grid.slice(1).map(row=>this.buildRow(row))].join('\n');
    const before=line(from.line).slice(0,from.ch),after=line(to.line).slice(to.ch);
    // A real Markdown header is the first copied row, not a blank header added
    // by the native HTML converter. Separate the table from surrounding prose.
    const prefix=before?'\n\n':from.line>0 && line(from.line-1).trim()?'\n':'';
    const suffix=after?'\n\n':'\n';
    try{this.replaceTableRange(editor,prefix+text+suffix,from,to);}
    catch(error){new Notice('TableTune: 表格粘贴失败');return true;}
    this.setWidths(path,tid,payload.columnWidths.map(size=>size || '80px'));
    this.setRowHeights(path,tid,payload.rowHeights);
    this.merges[path] ||= {};this.merges[path][tid]=payload.merges;
    this.tableDims[path] ||= {};this.tableDims[path][tid]={rows:grid.length,cols:grid[0].length};
    this.clearMergeSelection();this.persist();this.rekeyAfterSourceChange(path,tid,0,null);
    return true;
  }

  // ---- cell selection (drag like a spreadsheet) ------------------------
  resetNativeCellSelection(table) {
    const session=this.activeEditor()?.editorComponent?.tableCell,native=session?.table;
    if(!native || native.tableEl!==table)return;
    const hadRange=!!(native.selectionAnchor || native.selectionHead || native.selectedCells?.length);
    if(!hadRange && session.cm?.state?.readOnly!==true)return;
    // Removing CSS paint does not release Obsidian's read-only cell editor.
    // Use its own deselection path, then clear orphaned anchors as well (the
    // native implementation skips cleanup when selectedCells is already empty).
    if(typeof native.deselectCells==='function')native.deselectCells();
    native.selectionAnchor=null;native.selectionHead=null;
    native.containerEl?.classList?.remove('has-selection');
    if(typeof native.updateCellReadonly==='function')native.updateCellReadonly();
    // Native updateCellReadonly is debounced. Release it immediately so the
    // very first click can place a caret instead of waiting for another click.
    if(typeof session.setReadonly==='function')session.setReadonly(false);
  }

  bindNativeTableSelection(table) {
    const native = this.activeEditor()?.editorComponent?.tableCell?.table;
    if (!native || native.tableEl !== table || typeof native.selectCells !== 'function' || !native.getCellAt) return null;
    if (!this._nativeSelectionBindings) this._nativeSelectionBindings = new Map();
    const existing=this._nativeSelectionBindings.get(native);
    if (existing) return native;
    const plugin=this,original=native.selectCells,originalFocus=native.setCellFocus;
    const wrapped=function(anchor,head,...args) {
      if(plugin.ownsCellTextRange(table)){
        plugin.resetNativeCellSelection(table);return;
      }
      // A completed pointer range remains authoritative until the next user
      // gesture. Native mouseup/RAF callbacks may still carry an older anchor.
      const owned=plugin._pointerRange;
      if(owned && owned===plugin._sel && owned.table===table){
        const first=this.getCellAt(owned.r1,owned.c1),last=this.getCellAt(owned.r2,owned.c2);
        if(first && last)return original.call(this,first,last,...args);
        return;
      }
      // Only an explicit keyboard range gesture may import a native range.
      // Source edits/merge rerenders can replay an obsolete native anchor.
      if(table._tcrNativeRangeBlocked && anchor!==head)return;
      if (plugin._drag?.table===table && plugin._drag.textPending) return;
      if (!table.isConnected || !anchor || !head || anchor===head) return original.call(this,anchor,head,...args);
      const path=table.dataset.tcrPath || plugin.currentPath(),tid=plugin.tableId(table);
      const cells=plugin.completeSelectionCells(table,path,tid,anchor.row,anchor.col,head.row,head.col);
      const points=Array.from(cells,key=>key.split(',').map(Number));
      const r1=Math.min(...points.map(p=>p[0])),r2=Math.max(...points.map(p=>p[0]));
      const c1=Math.min(...points.map(p=>p[1])),c2=Math.max(...points.map(p=>p[1]));
      const first=this.getCellAt(r1,c1),last=this.getCellAt(r2,c2);
      if (!first || !last) return original.call(this,anchor,head,...args);
      const result=original.call(this,first,last,...args);
      if (!(plugin._sel?.table===table && plugin._sel.axis)) plugin.selectRect(table,r1,c1,r2,c2,path,tid);
      return result;
    };
    const focusWrapped=typeof originalFocus==='function'?function(...args){
      const text=plugin.ownsCellTextRange(table);
      // Native click/end callbacks may refocus the cell twice after release.
      // An already-active cell editor owns its text range; do not rebuild it
      // or replace that range with stale pointer coordinates.
      if(text?.cm)return;
      const result=originalFocus.apply(this,args);
      if(text){const captured=plugin.captureCellTextRange(text);if(captured)plugin._textRange=captured;}
      return result;
    }:null;
    native.selectCells=wrapped;
    if(focusWrapped)native.setCellFocus=focusWrapped;
    this._nativeSelectionBindings.set(native,{table,original,wrapped,originalFocus,focusWrapped});
    return native;
  }

  unbindNativeTableSelection(table) {
    if (!this._nativeSelectionBindings) return;
    for (const [native,binding] of this._nativeSelectionBindings) {
      if (binding.table!==table) continue;
      if (native.selectCells===binding.wrapped) native.selectCells=binding.original;
      if(binding.focusWrapped && native.setCellFocus===binding.focusWrapped)native.setCellFocus=binding.originalFocus;
      this._nativeSelectionBindings.delete(native);
    }
  }

  setupCellSelection(table, path, tid) {
    if (table._tcrSelectionCleanup) return;
    table._tcrNativeRangeBlocked=true;
    table.querySelectorAll('.is-selected').forEach(cell=>cell.classList.remove('is-selected'));
    // Obsidian can establish selection through mouse/keyboard handlers after
    // our pointer event, or replace the table DOM entirely. Reconcile its raw
    // physical-cell selection with merged logical rectangles as well.
    let nativeFrame = 0;
    const syncNative = () => {
      if (nativeFrame) return;
      nativeFrame = requestAnimationFrame(() => {
        nativeFrame = 0;
        if(table._tcrNativeRangeBlocked){
          if(!this._sel || this._sel.table!==table)this.resetNativeCellSelection(table);
          table.querySelectorAll('.is-selected').forEach(cell=>cell.classList.remove('is-selected'));
          return;
        }
        if (!table.isConnected || (this._pointerRange===this._sel && this._sel?.table===table) || (this._drag?.table===table && (this._drag.active || this._drag.textPending)) || (this._sel?.table===table && this._sel.axis)) return;
        const native=this.bindNativeTableSelection(table);
        // Correct native bounds too (copy/delete/keyboard must agree with paint).
        if (native?.selectionAnchor && native.selectionHead && native.selectionAnchor!==native.selectionHead) {
          native.selectCells(native.selectionAnchor,native.selectionHead);
          return;
        }
        const cells = Array.from(table.querySelectorAll('td.is-selected, th.is-selected'));
        if (!cells.length) return;
        // A focused merged cell is not a range. Its covered physical cells
        // share one visible owner, so count owners rather than native nodes.
        const merges=this.effectiveMerges(table,table.dataset.tcrPath || path,this.tableId(table));
        const owners=new Set(cells.map(cell=>{
          const r=this.cellRow(cell),c=this.cellCol(cell),m=merges.find(m=>this.regionContains(m,r,c));
          return m ? m.r+','+m.c : r+','+c;
        }));
        if (owners.size===1) return;
        const rows=cells.map(c=>this.cellRow(c)), cols=cells.map(c=>this.cellCol(c));
        this.selectRect(table,Math.min(...rows),Math.min(...cols),Math.max(...rows),Math.max(...cols),
          table.dataset.tcrPath || path,this.tableId(table));
      });
    };
    const nativeObserver = new MutationObserver(records => {
      if (records.some(record => record.target.matches('td,th') &&
        /(?:^|\s)is-selected(?:\s|$)/.test(record.oldValue || '') !== record.target.classList.contains('is-selected'))) syncNative();
    });
    nativeObserver.observe(table,{subtree:true,attributes:true,attributeFilter:['class'],attributeOldValue:true});
    const shiftMouse = e => {
      if (e.target.closest('.tcr-handle')) return;
      if (e.shiftKey && e.target.closest('td,th')?.closest('table')===table) {
        e.preventDefault();e.stopImmediatePropagation();
      }
    };
    const axisDown = e => {
      const handle = e.target.closest('.table-row-drag-handle, .table-col-drag-handle');
      if (!handle || e.button !== 0) return;
      e.preventDefault(); e.stopImmediatePropagation();
      this.selectTableAxis(table, handle, e);
    };
    const cellDown = e => {
      // Column resizing owns the entire gesture, even while the pointer is
      // over cell text. Do not install a competing range/text drag listener.
      if (e.target.closest('.tcr-handle')) return;
      const cell = e.target.closest('td,th');
      if (e.button !== 0 || !cell || cell.closest('table') !== table) return;
      if (e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); }
      this.startCellDrag(e, table, cell, table.dataset.tcrPath || path, this.tableId(table));
    };
    const contextMenu = e => {
      const handle = e.target.closest('.table-row-drag-handle, .table-col-drag-handle');
      const cell = e.target.closest('td,th');
      if (!cell || cell.closest('table') !== table) return;
      const path = table.dataset.tcrPath || this.currentPath(), tid = this.tableId(table);
      e.preventDefault(); e.stopImmediatePropagation();
      if (handle) this.selectTableAxis(table, handle, e, true);
      else {
        const pos = this.logicalPointInCell(table, cell, e.clientX, e.clientY, path, tid);
        const sel = this._sel;
        if (!sel || sel.table !== table || pos.r < sel.r1 || pos.r > sel.r2 || pos.c < sel.c1 || pos.c > sel.c2)
          this.selectRect(table, pos.r, pos.c, pos.r, pos.c, path, tid);
      }
      this.refreshMergeToolbar();
    };
    table.addEventListener('pointerdown', axisDown, true);
    table.addEventListener('pointerdown', cellDown, true);
    table.addEventListener('mousedown',shiftMouse,true);
    table.addEventListener('contextmenu', contextMenu, true);
    const releaseIntent=e=>{
      // Toolbar/axis actions still need the established range. Ordinary cell
      // pointerdown clears it in startCellDrag; only Shift navigation imports
      // native keyboard ranges, never an unrelated key or late callback.
      if(e.type==='keydown'){
        if(['Delete','Backspace'].includes(e.key) && this.ownsCellTextRange(table)?.cm)this._textRange.keepCaret=true;
        if(!['Delete','Backspace','Control','Meta','Shift','Alt'].includes(e.key))this._textRange=null;
        if(e.shiftKey && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(e.key) &&
          (table.contains(e.target) || this.activeEditor()?.editorComponent?.tableCell?.table?.tableEl===table)){
          this._pointerRange=null;table._tcrNativeRangeBlocked=false;
        }
      }else {this._pointerRange=null;this._textRange=null;}
    };
    const releaseMouse=e=>{
      if(this._pointerRange===this._sel && this._sel?.table===table){e.preventDefault();e.stopImmediatePropagation();}
    };
    // Consume compatibility events from the completed drag only. A genuine
    // next click begins with pointerdown and releases ownership first.
    window.addEventListener('click',releaseMouse,true);
    window.addEventListener('pointerdown',releaseIntent,true);
    window.addEventListener('keydown',releaseIntent,true);
    table._tcrSelectionCleanup = () => {
      window.removeEventListener('click',releaseMouse,true);
      window.removeEventListener('pointerdown',releaseIntent,true);
      window.removeEventListener('keydown',releaseIntent,true);
      this.unbindNativeTableSelection(table);
      nativeObserver.disconnect();
      if (nativeFrame) cancelAnimationFrame(nativeFrame);
      table.removeEventListener('pointerdown', axisDown, true);
      table.removeEventListener('pointerdown', cellDown, true);
      table.removeEventListener('mousedown',shiftMouse,true);
      table.removeEventListener('contextmenu', contextMenu, true);
      delete table._tcrSelectionCleanup;
    };
    if (!this._selectionTables) this._selectionTables = new Set();
    this._selectionTables.add(table);
    this.setupAxisRails(table);
    this.bindNativeTableSelection(table);
    this.resetNativeCellSelection(table);
    if (table.querySelector('.is-selected')) syncNative();
  }

  // Native handles live in cells that may be hidden by a rowspan/colspan.
  // Independent logical-axis rails keep every row and column reachable.
  setupAxisRails(table) {
    if (table._tcrAxisRails) return;
    table._tcrAxisRails = [];
    if (!this._axisRails) this._axisRails = [];
    const host = table.parentElement;
    for (const axis of ['row','column','insert','row-insert']) {
      const rail = document.createElement('div');
      rail.className = 'tcr-axis-rail tcr-axis-' + (axis === 'insert' ? 'insertions' : axis === 'row-insert' ? 'row-insertions' : axis);
      rail._tcrTable = table;
      if (getComputedStyle(host).position === 'static') {
        rail._tcrHostPosition = host.style.position;
        host.style.position = 'relative';
      }
      rail.addEventListener('pointerdown', e => {
        if(this._columnDragCleanup){e.preventDefault();e.stopImmediatePropagation();return;}
        const insert = e.target.closest('.tcr-axis-insert');
        if (insert && e.button === 0) {
          e.preventDefault(); e.stopImmediatePropagation();
          this.insertTableAxis(table,insert.dataset.tcrInsertAxis,Number(insert.dataset.tcrIndex)); return;
        }
        const h = e.target.closest('.tcr-axis-pick');
        if (!h || e.button !== 0) return;
        e.preventDefault(); e.stopImmediatePropagation();
        this.selectTableAxis(table, h, e);
      });
      rail.addEventListener('contextmenu', e => {
        const h = e.target.closest('.tcr-axis-pick');
        if (!h) return;
        e.preventDefault(); e.stopImmediatePropagation();
        this.selectTableAxis(table, h, e, true);
        this.refreshMergeToolbar();
      });
      host.appendChild(rail); table._tcrAxisRails.push(rail); this._axisRails.push(rail);
    }
    this.positionAxisRails(table);
  }

  removeAxisRail(rail) {
    if (rail._tcrHostPosition !== undefined && rail.parentElement)
      rail.parentElement.style.position = rail._tcrHostPosition;
    rail.remove();
  }

  positionAxisRails(table) {
    if (!table._tcrAxisRails) return;
    const rect = table.getBoundingClientRect(), host = table.parentElement;
    const base = host.getBoundingClientRect(), css = getComputedStyle(table);
    const grid = table.classList.contains('tcr-grid-table');
    const rowSizes = grid ? css.gridTemplateRows.split(' ').map(parseFloat) :
      Array.from(table.rows, row => row.getBoundingClientRect().height);
    const cols = table.querySelector('colgroup');
    const colSizes = grid ? css.gridTemplateColumns.split(' ').map(parseFloat) :
      Array.from(table.rows[0]?.cells || [], (cell,i) => cols?.children[i]?.getBoundingClientRect().width || cell.getBoundingClientRect().width);
    for (const rail of table._tcrAxisRails) {
      const rowInsert=rail.classList.contains('tcr-axis-row-insertions');
      const row = rail.classList.contains('tcr-axis-row') || rowInsert, insert = rail.classList.contains('tcr-axis-insertions') || rowInsert;
      const sizes = insert ? [...(row?rowSizes:colSizes),0] : row ? rowSizes : colSizes;
      rail.style.setProperty('--tcr-table-height',rect.height+'px');
      rail.style.setProperty('--tcr-table-width',rect.width+'px');
      Object.assign(rail.style, {left:(rect.left-base.left+host.scrollLeft-host.clientLeft-(row?14:0))+'px',
        top:(rect.top-base.top+host.scrollTop-host.clientTop-(row?0:14))+'px',
        width:(row?14:colSizes.reduce((a,b)=>a+b,0))+'px', height:(row?rowSizes.reduce((a,b)=>a+b,0):14)+'px'});
      while (rail.children.length > sizes.length) rail.lastChild.remove();
      let offset = 0;
      sizes.forEach((size,i) => {
        let h = rail.children[i];
        if (!h) {
          h = document.createElement('div'); h.className = insert ? 'tcr-axis-insert' : 'tcr-axis-pick';
          h.dataset.tcrAxis = row ? 'row' : 'column'; h.dataset.tcrIndex = String(i);
          h.setAttribute('role','button'); rail.appendChild(h);
          if (insert) { h.textContent='+'; h.title=row?'插入行':'插入列';h.dataset.tcrInsertAxis=row?'row':'col'; }
        }
        h.setAttribute('aria-label', insert ? '在第 '+(i+1)+(row?' 行位置插入行':' 列位置插入列') : (row?'选择行 ':'选择列 ')+(i+1));
        h.setAttribute('aria-pressed', String(this._sel?.table===table && this._sel.axis===(row?'row':'column') && this._sel.indices.has(i)));
        Object.assign(h.style, row ? {top:(offset-(insert?7:0))+'px',height:(insert?14:size)+'px',left:'0',width:'14px'} :
          {left:(offset-(insert?7:0))+'px',width:(insert?14:size)+'px',top:'0',height:'14px'});
        offset += size;
      });
    }
    if (this._sel?.table === table && this._sel.axis) this.highlightAxisSelection();
  }

  selectTableAxis(table, handle, event = {}, context = false) {
    const cell = handle.closest('td,th');
    if (!cell && !handle.dataset.tcrAxis) return;
    const axis = handle.dataset.tcrAxis || (handle.classList.contains('table-row-drag-handle') ? 'row' : 'column');
    const index = handle.dataset.tcrIndex !== undefined ? Number(handle.dataset.tcrIndex) :
      axis === 'row' ? this.cellRow(cell) : this.cellCol(cell);
    const old = this._sel;
    const compatible = old && old.table === table && old.axis === axis;
    if (context && compatible && old.indices.has(index)) return;
    let indices = new Set([index]);
    let anchor = index;
    if (compatible) {
      anchor = old.anchor;
      if (event.shiftKey) {
        indices = event.ctrlKey || event.metaKey ? new Set(old.indices) : new Set();
        for (let i = Math.min(anchor,index); i <= Math.max(anchor,index); i++) indices.add(i);
      } else if (event.ctrlKey || event.metaKey) {
        indices = new Set(old.indices);
        if (indices.has(index)) indices.delete(index); else indices.add(index);
        anchor = index;
      } else anchor = index;
    }
    const path = table.dataset.tcrPath || this.currentPath(), tid = this.tableId(table);
    const closedRectangle = !!event.shiftKey && !event.ctrlKey && !event.metaKey;
    if (closedRectangle && indices.size) {
      const first = Math.min(...indices), last = Math.max(...indices);
      const cells = this.completeSelectionCells(table,path,tid,
        axis==='row'?first:0, axis==='column'?first:0,
        axis==='row'?last:table.rows.length-1, axis==='column'?last:table.rows[0].cells.length-1);
      indices = new Set(Array.from(cells,key=>Number(key.split(',')[axis==='row'?0:1])));
    }
    this.clearMergeSelection();
    if (!indices.size) return;
    const first = Math.min(...indices), last = Math.max(...indices);
    this._sel = { table, path, tid, axis,
      indices, anchor,
      r1: axis === 'row' ? first : 0, r2: axis === 'row' ? last : table.rows.length - 1,
      c1: axis === 'column' ? first : 0, c2: axis === 'column' ? last : table.rows[0].cells.length - 1 };
    this.highlightAxisSelection();
    if (closedRectangle) this.highlightSelection();
    this.refreshMergeToolbar();
  }

  highlightAxisSelection() {
    const sel = this._sel;
    if (!sel || !sel.axis) return;
    const {table, indices, axis} = sel;
    table.classList.add('tcr-selection-owned');
    table.classList.remove('tcr-cell-editing');
    this.clearTableTextSelection(table);
    const merges = this.effectiveMerges(table, sel.path, sel.tid);
    for (let r = 0; r < table.rows.length; r++) for (let c = 0; c < table.rows[r].cells.length; c++) {
      const cell = table.rows[r].cells[c];
      if (cell.classList.contains('tcr-merged-hidden')) continue;
      const reg = merges.find(m => m.r === r && m.c === c);
      const start = axis === 'row' ? r : c;
      const span = reg ? (axis === 'row' ? reg.rowspan : reg.colspan) : 1;
      let selected = true;
      for (let i = start; i < start+span; i++) if (!indices.has(i)) selected = false;
      cell.classList.toggle('tcr-axis-cell-selected', selected);
    }
    this._axisHandles = [];
    const root = table.parentElement;
    root.querySelectorAll('.table-row-drag-handle, .table-col-drag-handle, .tcr-axis-pick').forEach(h => {
      if (h.closest('table') !== table && h.closest('.tcr-axis-rail')?._tcrTable !== table) return;
      const a = h.dataset.tcrAxis || (h.classList.contains('table-row-drag-handle') ? 'row' : 'column');
      const cell = h.closest('td,th');
      const i = h.dataset.tcrIndex !== undefined ? Number(h.dataset.tcrIndex) :
        a === 'row' ? this.cellRow(cell) : this.cellCol(cell);
      const selected = a === axis && indices.has(i) && (!table._tcrAxisRails || h.classList.contains('tcr-axis-pick'));
      h.classList.toggle('tcr-axis-selected', selected);
      if (h.classList.contains('tcr-axis-pick')) h.setAttribute('aria-pressed',String(selected));
      if (selected) this._axisHandles.push(h);
    });
  }

  cellDragText(cell) {
    // Ignore handles, hidden merge placeholders and CodeMirror decorations.
    const content=cell.querySelector('.cm-content,[contenteditable="true"],.table-cell-wrapper') || cell;
    const walker=cell.ownerDocument.createTreeWalker(content,4);
    let text='',node;
    while ((node=walker.nextNode())) {
      if (node.parentElement.closest('.table-row-drag-handle,.table-col-drag-handle,.cm-cursorLayer,.cm-selectionLayer,.tcr-merged-hidden')) continue;
      text+=node.nodeValue;
    }
    return text.replace(/[\u200b-\u200d\u2060-\u206f\ufeff]/g,'');
  }

  selectCellDragText(d, selectAll=false) {
    const session=this.activeEditor()?.editorComponent?.tableCell,cm=session?.cm;
    if (session?.table?.tableEl===d.table && cm?.contentDOM && d.cell.contains(cm.contentDOM)) {
      const length=cm.state.doc.length,range=cm.state.selection.main;
      if (selectAll) cm.dispatch({selection:{anchor:0,head:length}});
      return length>0 && (selectAll || (range.from===0 && range.to===length));
    }
    const selection=d.table.ownerDocument.defaultView.getSelection();
    if (!selection) return false;
    if (selectAll) {
      const range=d.table.ownerDocument.createRange();
      range.selectNodeContents(d.cell.querySelector('[contenteditable="true"],.table-cell-wrapper') || d.cell);
      selection.removeAllRanges();selection.addRange(range);
    }
    return d.cell.contains(selection.anchorNode) && d.cell.contains(selection.focusNode) &&
      selection.toString().replace(/\s/g,'')===this.cellDragText(d.cell).replace(/\s/g,'');
  }

  captureCellTextRange(d) {
    const session=this.activeEditor()?.editorComponent?.tableCell,cm=session?.cm;
    if(session?.table?.tableEl===d.table && d.cell.contains(cm?.contentDOM)){
      const range=cm.state.selection.main;
      if(range.from<range.to)return {table:d.table,cell:d.cell,session,cm};
      return null;
    }
    const selection=d.table.ownerDocument.defaultView.getSelection();
    if(selection && !selection.isCollapsed && d.cell.contains(selection.anchorNode) && d.cell.contains(selection.focusNode))
      return {table:d.table,cell:d.cell};
    return null;
  }

  ownsCellTextRange(table) {
    const text=this._textRange;
    if(!text || text.table!==table || !table.isConnected || !text.cell.isConnected)return null;
    const session=this.activeEditor()?.editorComponent?.tableCell;
    // Delete collapses the text range normally. Keep its resulting caret safe
    // from a pending native release callback until the next deliberate intent.
    if(text.keepCaret && text.cm && session===text.session && session.cm===text.cm && text.cell.contains(text.cm.contentDOM))return text;
    const current=this.captureCellTextRange(text);
    if(!current || (text.cm && current.cm!==text.cm))return null;
    return current;
  }

  startCellDrag(e, table, cell, path, tid) {
    this.bindNativeTableSelection(table);
    const start = this.logicalPointInCell(table, cell, e.clientX, e.clientY, path, tid);
    const previous = this._cellSelectionAnchor;
    const extending = e.shiftKey && previous?.table === table && previous.path === path && previous.tid === tid;
    const startR = extending ? previous.r : start.r, startC = extending ? previous.c : start.c;
    if (!extending) this._cellSelectionAnchor = {table,path,tid,r:startR,c:startC};
    if (!extending) {
      this.clearMergeSelection();
      // A previous merge may have replaced the DOM or cleared plugin state
      // while the native editor still owns a read-only range.
      this.resetNativeCellSelection(table);
      table.classList.add('tcr-cell-editing');
    }
    this._lastTableCell = { path, tid, r: startR, c: startC, time: Date.now() };
    this._drag = { table, cell, path, tid, startR, startC, endR: start.r, endC: start.c,
      textPending: !extending && !!this.cellDragText(cell).trim(),
      x: e.clientX, y: e.clientY, active: !!extending };
    if (extending) this.selectRect(table,startR,startC,start.r,start.c,path,tid);
    const onMove = (ev) => {
      const d = this._drag; if (!d) return;
      if (d.textPending) {
        const rect=d.cell.getBoundingClientRect();
        const inside=ev.clientX>=rect.left && ev.clientX<=rect.right && ev.clientY>=rect.top && ev.clientY<=rect.bottom;
        // Let the cell editor/browser own dragging while inside the text cell.
        if (inside) { d.textExit=null;return; }
        ev.preventDefault();ev.stopImmediatePropagation();
        if (!d.textExit && !this.selectCellDragText(d)) {
          this.selectCellDragText(d,true);
          d.textExit={x:ev.clientX,y:ev.clientY};return;
        }
        if (d.textExit && Math.abs(ev.clientX-d.textExit.x)+Math.abs(ev.clientY-d.textExit.y)<6) return;
        d.textPending=false;
      }
      if (!d.active) {
        if (Math.abs(ev.clientX - d.x) + Math.abs(ev.clientY - d.y) < 6) return;
        d.active = true;
      }
      ev.preventDefault();
      ev.stopImmediatePropagation();
      let endR = d.endR, endC = d.endC;
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const tcell = target && target.closest('td,th');
      if (tcell && d.table.contains(tcell)) {
        const end = this.logicalPointInCell(d.table, tcell, ev.clientX, ev.clientY, d.path, d.tid);
        endR = end.r; endC = end.c;
      }
      d.endR = endR; d.endC = endC;
      this.selectRect(d.table, Math.min(d.startR, endR), Math.min(d.startC, endC),
        Math.max(d.startR, endR), Math.max(d.startC, endC), d.path, d.tid);
    };
    const onTextMouseMove = ev => {
      const d=this._drag;
      if (!d || d.table!==table) return;
      const rect=d.cell.getBoundingClientRect();
      if (d.active || (d.textPending && (ev.clientX<rect.left || ev.clientX>rect.right || ev.clientY<rect.top || ev.clientY>rect.bottom))) {
        // The compatibility mousemove follows pointermove. Do not let the
        // native editor overwrite the completed text or cell selection.
        ev.preventDefault();ev.stopImmediatePropagation();
        if (d.textPending && d.textExit) requestAnimationFrame(()=>{
          if (this._drag===d && d.textPending && d.textExit) this.selectCellDragText(d,true);
        });
      }
    };
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('mousemove', onTextMouseMove, true);
      const d = this._drag; this._drag = null;
      if (d && !d.active) {
        // Keep native click/focus handling intact so the caret can enter text.
        this.clearMergeSelection();
        if (d.textPending && d.textExit) this.selectCellDragText(d,true);
        this._textRange=this.captureCellTextRange(d);
      }
      if(d?.active){
        ev.preventDefault();ev.stopImmediatePropagation();
        this._pointerRange=this._sel;
        this.refreshMergeToolbar();
      }
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('mousemove', onTextMouseMove, true);
  }

  logicalPointInCell(table, cell, x, y, path, tid) {
    let r = this.cellRow(cell), c = this.cellCol(cell);
    const reg = this.effectiveMerges(table, path, tid).find((m) => this.regionContains(m, r, c));
    if (!reg) return { r, c };

    // A rowspan/colspan is one DOM cell, but the pointer may be over any of its
    // logical rows/columns. Resolve that sub-position so the raw drag rectangle
    // does not accidentally include neighbouring ordinary cells.
    if (table.classList && table.classList.contains('tcr-grid-table')) {
      const rect = cell.getBoundingClientRect();
      const tracks = typeof getComputedStyle === 'function'
        ? getComputedStyle(table).gridTemplateRows.split(' ').map(parseFloat) : [];
      let edge = rect.top;
      for (let rr = reg.r; rr < reg.r + reg.rowspan; rr++) {
        const height = tracks[rr] || rect.height / reg.rowspan;
        if (y < edge + height || rr === reg.r + reg.rowspan - 1) { r = rr; break; }
        edge += height;
      }
    } else for (let rr = reg.r; rr < reg.r + reg.rowspan; rr++) {
      const row = table.rows[rr];
      const rect = row && row.getBoundingClientRect ? row.getBoundingClientRect() : null;
      if (rect && y >= rect.top && y <= rect.bottom) { r = rr; break; }
    }
    const colgroup = table.querySelector('colgroup');
    if (colgroup) {
      const cellRect = cell.getBoundingClientRect();
      let edge = cellRect.left;
      for (let cc = reg.c; cc < reg.c + reg.colspan; cc++) {
        const col = colgroup.children[cc];
        const width = (col && col.getBoundingClientRect().width) ||
          (col && col.style && parseFloat(col.style.width)) || cellRect.width / reg.colspan;
        if (x <= edge + width || cc === reg.c + reg.colspan - 1) { c = cc; break; }
        edge += width;
      }
    }
    return { r, c };
  }

  selectRect(table, r1, c1, r2, c2, path, tid) {
    // Repainting/replacing a range is not the same as cancelling it. Keep
    // the native keyboard range alive until a genuine clear or text click.
    this.clearMergeSelection(true);
    const cells = this.completeSelectionCells(table, path, tid, r1, c1, r2, c2);
    const points = Array.from(cells, (key) => key.split(',').map(Number));
    const rows = points.map((p) => p[0]), cols = points.map((p) => p[1]);
    this._sel = {
      table,
      r1: Math.min(...rows), c1: Math.min(...cols),
      r2: Math.max(...rows), c2: Math.max(...cols),
      cells, path, tid,
    };
    this.highlightSelection();
    this.refreshMergeToolbar();
  }

  // Keep the selection rectangular. When it touches a merged region, expand
  // the rectangle to that region's outer boundary; repeat because the larger
  // rectangle may encounter another merged region.
  completeSelectionCells(table, path, tid, r1, c1, r2, c2) {
    [r1, r2] = [Math.min(r1, r2), Math.max(r1, r2)];
    [c1, c2] = [Math.min(c1, c2), Math.max(c1, c2)];
    const merges = this.effectiveMerges(table, path, tid);
    let changed = true;
    while (changed) {
      changed = false;
      for (const m of merges) {
        const mr2 = m.r + m.rowspan - 1, mc2 = m.c + m.colspan - 1;
        const touches = r1 <= mr2 && m.r <= r2 && c1 <= mc2 && m.c <= c2;
        if (!touches) continue;
        const nr1 = Math.min(r1, m.r), nc1 = Math.min(c1, m.c);
        const nr2 = Math.max(r2, mr2), nc2 = Math.max(c2, mc2);
        if (nr1 !== r1 || nc1 !== c1 || nr2 !== r2 || nc2 !== c2) changed = true;
        r1 = nr1; c1 = nc1; r2 = nr2; c2 = nc2;
      }
    }
    const cells = new Set();
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) cells.add(r + ',' + c);
    return cells;
  }

  selectionCells(sel) {
    if (sel.cells instanceof Set) return sel.cells;
    const cells = new Set();
    for (let r = sel.r1; r <= sel.r2; r++) for (let c = sel.c1; c <= sel.c2; c++) cells.add(r + ',' + c);
    return cells;
  }

  selectionIsRectangle(sel) {
    return this.selectionCells(sel).size === (sel.r2 - sel.r1 + 1) * (sel.c2 - sel.c1 + 1);
  }

  highlightSelection() {
    const sel = this._sel; if (!sel) return;
    sel.table.querySelectorAll('.tcr-sel').forEach((c) => c.classList.remove('tcr-sel'));
    // Selection edges existed in earlier 1.1.6 iterations. They are no longer
    // part of the design; clean stale DOM nodes before applying fill-only state.
    sel.table.querySelectorAll('.tcr-sel-edge').forEach((edge) => edge.remove());
    const selected = this.selectionCells(sel);
    for (const key of selected) {
      const [rr, cc] = key.split(',').map(Number);
      const cell = sel.table.rows[rr] && sel.table.rows[rr].cells[cc];
      if (!cell || cell.classList.contains('tcr-merged-hidden')) continue;
      cell.classList.add('tcr-sel');
    }
    // One outline for the completed logical rectangle. Native per-cell edge
    // classes describe the raw drag and cannot represent merged cell closure.
    sel.table.classList.add('tcr-selection-owned');
    sel.table.classList.remove('tcr-cell-editing');
    this.clearTableTextSelection(sel.table);
    const host = sel.table.parentElement;
    const overlay = document.createElement('div');
    overlay.className = 'tcr-selection-rect';
    overlay.setAttribute('aria-hidden', 'true');
    this._selectionHost = host;
    this._selectionHostPosition = host.style.position;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(overlay);
    this._selectionOverlay = overlay;
    this.positionSelectionOverlay();
  }

  clearTableTextSelection(table) {
    // Pointer dragging can leave a browser text range across empty-cell <br>s.
    // Clear only a non-collapsed range touching this explicitly selected table;
    // preserve editor focus/caret and unrelated document/window selections.
    const selection=table.ownerDocument?.defaultView?.getSelection();
    if (!selection || selection.isCollapsed) return;
    if (table.contains(selection.anchorNode) || table.contains(selection.focusNode)) selection.removeAllRanges();
  }

  positionSelectionOverlay() {
    const sel = this._sel, overlay = this._selectionOverlay, host = this._selectionHost;
    if (!sel || !overlay || !host) return;
    const rects = Array.from(sel.table.querySelectorAll('.tcr-sel'), c => c.getBoundingClientRect())
      .filter(r => r.width && r.height);
    if (!rects.length) return;
    const base = host.getBoundingClientRect();
    const left = Math.min(...rects.map(r => r.left)), top = Math.min(...rects.map(r => r.top));
    Object.assign(overlay.style, { left: (left-base.left+host.scrollLeft-host.clientLeft)+'px',
      top: (top-base.top+host.scrollTop-host.clientTop)+'px',
      width: (Math.max(...rects.map(r => r.right))-left)+'px',
      height: (Math.max(...rects.map(r => r.bottom))-top)+'px' });
  }

  clearMergeSelection(preserveNative=false) {
    this._pointerRange=null;
    this._textRange=null;
    const table=this._sel?.table;
    if(table){
      if(!preserveNative)this.resetNativeCellSelection(table);
      table._tcrNativeRangeBlocked=true;
      table.querySelectorAll('.is-selected').forEach(cell=>cell.classList.remove('is-selected'));
    }
    if (this._selectionOverlay) { this._selectionOverlay.remove(); this._selectionOverlay = null; }
    if (this._selectionHost) {
      this._selectionHost.style.position = this._selectionHostPosition;
      this._selectionHost = null;
    }
    if (this._axisHandles) {
      this._axisHandles.forEach(h => { h.classList.remove('tcr-axis-selected'); h.setAttribute('aria-pressed','false'); });
      this._axisHandles = null;
    }
    if (this._sel) {
      this._sel.table.classList.remove('tcr-selection-owned');
      this._sel.table.querySelectorAll('.tcr-axis-cell-selected').forEach(c => c.classList.remove('tcr-axis-cell-selected'));
      this._sel.table.querySelectorAll('.tcr-sel').forEach((c) => c.classList.remove('tcr-sel'));
      this._sel.table.querySelectorAll('.tcr-sel-edge').forEach((edge) => edge.remove());
      this._sel = null;
    }
    this.hideMergeToolbar();
  }

  // ---- floating Merge/Split toolbar -----------------------------------
  isMergeRegion(sel) {
    if (!sel) return false;
    const list = this.effectiveMerges(sel.table, sel.path, sel.tid);
    return list.some((m) =>
      m.r === sel.r1 && m.c === sel.c1 &&
      m.rowspan === sel.r2 - sel.r1 + 1 &&
      m.colspan === sel.c2 - sel.c1 + 1 && this.selectionIsRectangle(sel)
    );
  }

  refreshMergeToolbar() {
    const sel=this._sel;
    if(!sel || this._drag?.active || !sel.table.isConnected){this.hideMergeToolbar();return;}
    this.showMergeToolbar(true);
    const bar=this._toolbar;
    // Reuse the existing command definitions so counts, merge constraints,
    // disjoint axis selection and source-safe mutations stay identical.
    const actions=[];
    this.populateEditorMenu({addItem:build=>{
      const action={},item={setTitle:title=>{action.title=title;return item;},onClick:run=>{action.run=run;return item;},setChecked:checked=>{action.checked=checked;return item;}};
      build(item);actions.push(action);
    }});
    bar.replaceChildren();
    let previousGroup=null;
    for(const action of actions){
      const title=action.title,group=/顶部对齐|垂直居中|底部对齐/.test(title)?'vertical-align':/对齐/.test(title)?'align':/删除/.test(title)?'delete':/插入/.test(title)?'insert':'merge';
      if(previousGroup && previousGroup!==group){const sep=document.createElement('span');sep.className='tcr-toolbar-separator';sep.setAttribute('role','separator');bar.appendChild(sep);}
      previousGroup=group;
      const icon=title==='清空内容'?'eraser':title==='合并单元格'?'combine':title==='拆分单元格'?'split':
        title==='左对齐'?'align-left':title==='居中对齐'?'align-center':title==='右对齐'?'align-right':
        title==='顶部对齐'?'align-vertical-justify-start':title==='垂直居中'?'align-vertical-justify-center':title==='底部对齐'?'align-vertical-justify-end':
        /上方/.test(title)?'arrow-up-to-line':/下方/.test(title)?'arrow-down-to-line':
        /左侧/.test(title)?'arrow-left-to-line':/右侧/.test(title)?'arrow-right-to-line':/行/.test(title)?'rows-3':'columns-3';
      const button=document.createElement('button');button.type='button';button.className='tcr-toolbar-button';
      button.title=title;button.setAttribute('aria-label',title);button.dataset.icon=icon;
      if(action.checked!==undefined)button.setAttribute('aria-pressed',String(action.checked));
      if(group==='delete')button.classList.add('tcr-toolbar-danger');
      if(typeof setIcon==='function')setIcon(button,icon);
      button.addEventListener('click',e=>{e.stopPropagation();if(this._sel!==sel)return;action.run();this.refreshMergeToolbar();});
      bar.appendChild(button);
    }
    this.positionMergeToolbar(sel);
  }

  showMergeToolbar(show) {
    if (!this._toolbar) {
      this._toolbar = document.createElement('div');
      this._toolbar.className = 'tcr-merge-toolbar';
      this._toolbar.setAttribute('role','toolbar');
      this._toolbar.setAttribute('aria-label','表格操作');
      // Keep the editor selection and active leaf when clicking a command.
      this._toolbar.addEventListener('pointerdown', (e) => e.preventDefault());
      document.body.appendChild(this._toolbar);
    }
    this._toolbar.style.display = show ? 'flex' : 'none';
  }

  hideMergeToolbar() {
    if (this._toolbar) this._toolbar.style.display = 'none';
  }

  positionMergeToolbar(sel) {
    if (!this._toolbar || this._toolbar.style.display==='none') return;
    let rect = null;
    for (const key of this.selectionCells(sel)) {
        const [rr, cc] = key.split(',').map(Number);
        const cell = sel.table.rows[rr] && sel.table.rows[rr].cells[cc];
        if (!cell || cell.classList.contains('tcr-merged-hidden')) continue;
        const r = cell.getBoundingClientRect();
        if (!r || r.width === 0 || r.height === 0) continue;
        if (!rect) rect = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
        else {
          rect.top = Math.min(rect.top, r.top);
          rect.bottom = Math.max(rect.bottom, r.bottom);
          rect.left = Math.min(rect.left, r.left);
          rect.right = Math.max(rect.right, r.right);
        }
      }
    if (!rect) return;
    const toolbarWidth = this._toolbar.offsetWidth || 300;
    const toolbarHeight = this._toolbar.offsetHeight || 40;
    this._toolbar.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - toolbarWidth - 4)) + 'px';
    const tableRect=sel.table.getBoundingClientRect();
    if(tableRect.bottom<0 || tableRect.top>window.innerHeight){this._toolbar.style.visibility='hidden';return;}
    this._toolbar.style.visibility='';
    const top=tableRect.top-toolbarHeight-24;
    this._toolbar.style.top = Math.max(4,Math.min(top>=4?top:tableRect.bottom+14,window.innerHeight-toolbarHeight-4))+'px';
  }

  // ---- native right-click menu (injected into Obsidian's editor menu) ---
  populateEditorMenu(menu) {
    const sel = this._sel;
    if(sel)menu.addItem(item=>{item.setTitle('清空内容');item.onClick(()=>this.clearSelectedCellContents());});
    if (sel && sel.axis) {
      menu.addItem(item => {
        const count = sel.indices.size;
        item.setTitle(sel.axis === 'row' ? (count === 1 ? '删除行' : `删除 ${count} 行`) : (count === 1 ? '删除列' : `删除 ${count} 列`));
        item.onClick(() => sel.axis === 'row' ? this.deleteSelectedRows() : this.deleteSelectedColumns());
      });
      const row = sel.axis === 'row';
      for (const after of [false,true]) menu.addItem(item => {
        item.setTitle(row ? (after?'在下方插入行':'在上方插入行') : (after?'在右侧插入列':'在左侧插入列'));
        item.onClick(()=>this.insertTableAxis(sel.table,row?'row':'col',
          (after?Math.max(...sel.indices)+1:Math.min(...sel.indices))));
      });
      this.addAlignmentMenu(menu);
      return;
    }
    const area = sel ? this.selectionCells(sel).size : 0;
    const isRegion = sel ? this.isMergeRegion(sel) : false;
    if (sel && area >= 2 && !isRegion && this.selectionIsRectangle(sel)) {
      menu.addItem((item) => {
        item.setTitle('合并单元格');
        item.onClick(() => this.mergeSelectedCells());
      });
    }
    if (sel) {
      menu.addItem((item) => {
        item.setTitle(sel.r1 === sel.r2 ? '删除行' : `删除 ${sel.r2 - sel.r1 + 1} 行`);
        item.onClick(() => this.deleteSelectedRows());
      });
      menu.addItem((item) => {
        item.setTitle(sel.c1 === sel.c2 ? '删除列' : `删除 ${sel.c2 - sel.c1 + 1} 列`);
        item.onClick(() => this.deleteSelectedColumns());
      });
    }
    let splitReg = null, path = null, tid = null;
    if (sel && isRegion) {
      splitReg = { r: sel.r1, c: sel.c1, rowspan: sel.r2 - sel.r1 + 1, colspan: sel.c2 - sel.c1 + 1 };
      path = sel.path; tid = sel.tid;
    } else {
      const c = this.cellAtCursor();
      if (c) {
        const table = c.closest('table');
        path = this.currentPath();
        tid = table ? this.tableId(table) : null;
        const r = this.cellRow(c), cc = this.cellCol(c);
        const list = this.effectiveMerges(table, path, tid);
        const reg = list.find((m) => this.regionContains(m, r, cc));
        if (reg) splitReg = reg;
      }
    }
    if (splitReg && path && tid) {
      menu.addItem((item) => {
        item.setTitle('拆分单元格');
        item.onClick(() => this.splitRegion(path, tid, splitReg));
      });
    }
    this.addAlignmentMenu(menu);
  }

  cellAtCursor() {
    const editor = this.activeEditor();
    const cm = editor && editor.cm;
    if (!editor || !editor.getCursor || !cm || !cm.domAtPos) return null;
    try {
      const cur = editor.getCursor();
      const doc = editor.getDoc();
      const line = typeof doc.line === 'function' ? doc.line(cur.line) : null;
      const off = line ? line.from + cur.ch : 0;
      const dom = cm.domAtPos(off);
      const node = dom && dom.node;
      if (!node) return null;
      return node.nodeType === 1 ? node.closest('td,th') : (node.parentElement && node.parentElement.closest('td,th'));
    } catch (e) { return null; }
  }

  handleCellEnter(e) {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey) return false;
    const table = e.target.closest && e.target.closest('table[data-tcr]');
    if (!table || !e.target.closest('.table-cell-wrapper')) return false;
    const session = this.activeEditor()?.editorComponent?.tableCell;
    const cm = session && session.cm;
    if (!cm || session.table?.tableEl !== table || !cm.contentDOM.contains(e.target)) return false;
    e.preventDefault(); e.stopImmediatePropagation();
    this.clearMergeSelection();
    if (typeof session.table.deselectCells === 'function') session.table.deselectCells();
    cm.dispatch({...cm.state.replaceSelection('\n'), userEvent:'input.type'});
    requestAnimationFrame(()=>{if (table.isConnected) {this.positionAxisRails(table);this.positionSelectionOverlay();}});
    return true;
  }

  // Ctrl+A inside a merged cell selects the whole merged cell (for split).
  handleCellSelectAll(e) {
    if (!(e.ctrlKey || e.metaKey) || !(e.key === 'a' || e.key === 'A')) return false;
    const editor = this.activeEditor();
    const cm = editor && editor.cm;
    if (!editor || !cm || !editor.getCursor || !cm.domAtPos) return false;
    try {
      const cur = editor.getCursor();
      const doc = editor.getDoc();
      const line = typeof doc.line === 'function' ? doc.line(cur.line) : null;
      const off = line ? line.from + cur.ch : 0;
      const dom = cm.domAtPos(off);
      const node = dom && dom.node;
      const cell = node ? (node.nodeType === 1 ? node.closest('td,th') : (node.parentElement && node.parentElement.closest('td,th'))) : null;
      if (!cell) return false;
      const table = cell.closest('table[data-tcr]');
      if (!table) return false;
      const path = this.currentPath();
      const tid = this.tableId(table);
      const r = this.cellRow(cell), c = this.cellCol(cell);
      const list = this.effectiveMerges(table, path, tid);
      const reg = list.find((m) => this.regionContains(m, r, c));
      if (!reg) return false;
      e.preventDefault();
      e.stopPropagation();
      const anchor = table.rows[reg.r] && table.rows[reg.r].cells[reg.c];
      if (anchor) {
        this.selectRect(table, reg.r, reg.c,
          reg.r + reg.rowspan - 1, reg.c + reg.colspan - 1, path, tid);
      }
      return true;
    } catch (err) { return false; }
  }

  startDrag(e, colgroup, i, key, tid) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const cell = e.currentTarget && e.currentTarget.closest('th,td');
    // Handles survive header edits and colgroup replacement. Never use the
    // identity/DOM captured when the handle was first attached.
    const table = cell?.closest('table') || colgroup.closest('table');
    if (!table || table.isConnected === false) return;
    key = table.dataset.tcrPath || key;
    tid = this.tableId(table);
    colgroup = this.ensureColgroup(table, table.querySelectorAll('thead th, thead td').length || colgroup.children.length);
    if (cell) i = this.cellCol(cell);
    if (cell && cell.dataset.tcrMerge) i = this.cellCol(cell) + cell.colSpan - 1;
    let col = colgroup.children[i];
    if (!col) return;
    const history=this.historySnapshot();
    const handle=e.currentTarget;
    if(handle && e.pointerId!=null)try{handle.setPointerCapture(e.pointerId)}catch(_){}
    table.dataset.tcrResizing='1';
    table._tcrAxisRails?.forEach(rail=>rail.classList.add('tcr-resizing'));
    const startX = e.clientX;
    const startW = col.getBoundingClientRect().width || parseFloat(col.style.width) || 80;
    const initialWidths=Array.from(colgroup.children,c=>c.style.width || '');
    const updateStore = () => {
      const arr = [];
      for (const c of colgroup.children) arr.push(c.style.width || '');
      table._tcrColumnDrag = arr;
      this.setWidths(key, this.tableId(table), arr);
    };
    const onMove = (ev) => {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const liveGroup = table.querySelector('colgroup');
      if (liveGroup && liveGroup !== colgroup) {
        colgroup = liveGroup;
        (table._tcrColumnDrag || []).forEach((width, index) => {
          if (colgroup.children[index]) colgroup.children[index].style.width = width;
        });
        col = colgroup.children[i];
      }
      if (!col || table.isConnected === false) return;
      const w = Math.max(40, startW + (ev.clientX - startX));
      col.style.width = w + 'px';
      this.syncTableWidth(table, colgroup);
      // Keep the in-memory store current on every move so Reading view (and any
      // Live Preview re-render) always reflects the latest width immediately.
      updateStore();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      updateStore();
      const widths = table._tcrColumnDrag.slice();
      delete table._tcrColumnDrag;
      if(widths.every((width,index)=>width===initialWidths[index])){cleanup();return;}
      this.runTableHistory(()=>this.commitColumnWidths(table, key, widths),history);
      this.persist();
      cleanup();
    };
    const cleanup=()=>{
      window.removeEventListener('pointermove', onMove, true);window.removeEventListener('pointerup', onUp, true);window.removeEventListener('pointercancel', onUp, true);
      delete table.dataset.tcrResizing;delete table._tcrColumnDrag;
      table._tcrAxisRails?.forEach(rail=>rail.classList.remove('tcr-resizing'));
      if(handle && e.pointerId!=null)try{handle.releasePointerCapture(e.pointerId)}catch(_){}
      if(this._columnDragCleanup===cleanup)this._columnDragCleanup=null;
    };
    this._columnDragCleanup=cleanup;
    // A release over an insertion rail must not become a native button click.
    const swallowClick=event=>{event.preventDefault();event.stopImmediatePropagation();};
    handle?.addEventListener('click',swallowClick,{once:true,capture:true});
    updateStore();
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
  }

  commitColumnWidths(table, path, widths) {
    const oldTid = this.tableId(table);
    this.setWidths(path, oldTid, widths);
    // Give a resized table a source-backed identity so later header edits,
    // view switches and reopening the note cannot discard its saved widths.
    const editor = this.app?.workspace && this.activeEditor();
    if (!editor || this.currentPath() !== path || table.isConnected === false) return;
    const info = this.tableSourceInfo(editor, table);
    if (!info || info.uid || typeof info.header !== 'string') return;
    const uid = 'm'+Date.now().toString(36)+Math.random().toString(36).slice(2,8);
    const at = info.toPos(info.from + info.header.match(/^\s*\|?\s*/)[0].length);
    try { this.replaceTableRange(editor,this.encodeInvisibleUid(uid), at, at); }
    catch (_) { return; }
    const tid = 'u'+uid;
    for (const store of [this.widths,this.rowHeights,this.merges,this.tableDims,this.alignments]) {
      if (store?.[path]?.[oldTid] !== undefined) store[path][tid] = store[path][oldTid];
    }
    table.dataset.tableTuneUid = uid;
    if (this._sel?.table === table) this._sel.tid = tid;
  }

  // Row-resize: drag the bottom edge of the leftmost cell of a row to change
  // that row's height. Edit-mode only (mirrors into Reading via this.rowHeights).
  startRowDrag(e, tr, rowIndex, key, tid) {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const table = tr.closest('table');
    const cell = e.currentTarget && e.currentTarget.closest('th,td');
    if (cell && cell.dataset.tcrMerge) {
      rowIndex = this.cellRow(cell) + cell.rowSpan - 1;
      tr = table.rows[rowIndex];
    }
    const tracks = table.classList.contains('tcr-grid-table')
      ? getComputedStyle(table).gridTemplateRows.split(' ').map(parseFloat) : [];
    const startH = tracks[rowIndex] || parseFloat(tr.style.height) || tr.getBoundingClientRect().height || 30;
    const prev = this.getRowHeights(key, tid) || [];
    const arr = prev.slice();
    let lastY = startY;
    const apply = (h) => {
      tr.style.height = h + 'px';
      arr[rowIndex] = Math.round(h) + 'px';
      // In-memory store updated every move so Live Preview re-renders and
      // Reading view both reflect the new height immediately.
      this.setRowHeights(key, tid, arr.slice());
      if (table.classList.contains('tcr-grid-table')) this.updateMergeGridRows(table, key, tid);
      this.positionAxisRails(table);
      if (this._sel?.table === table) this.positionSelectionOverlay();
    };
    const onMove = (ev) => {
      lastY = ev.clientY;
      const h = Math.max(24, startH + (ev.clientY - startY));
      apply(h);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      const h = Math.max(24, startH + (lastY - startY));
      apply(h);
      this.refreshMergeHeights(tr.closest('table'), key, tid);
      this.persist();
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
  }

  refreshMergeHeights(table, path, tid) {
    if (!table) return;
    const heights = this.getRowHeights(path, tid) || [];
    for (const reg of this.getMerges(path, tid)) {
      let total = 0;
      for (let r = reg.r; r < reg.r + reg.rowspan; r++) {
        const row = table.rows[r];
        total += parseFloat(heights[r]) || (row && row.getBoundingClientRect().height) || 0;
      }
      if (total > 0) reg.height = Math.round(total) + 'px';
    }
  }
};












