/* SQLDex Merge UI — wires the Queryboard, the sheet and the live output together.
   All SQL logic lives in engine.js; reading uploaded files lives in importer.js. */
(function () {
  'use strict';

  const E = window.SqlDexEngine;
  const I = window.SqlDexImport;

  const MIN_COLS = 10;
  const MAX_COLS = 100;
  const MIN_ROWS = 20;
  const MAX_ROWS = 100000;
  const SPARE_ROWS = 5;
  const GROW_BY = 10;
  const OVERSCAN = 20; // sheet rows drawn above and below the visible ones
  const PREVIEW_LINES = 300; // output lines drawn on screen; Copy always takes the whole script
  const MAX_FILE_MB = 100;
  const STORAGE_KEY = 'sqldex-merge:v1';

  // Every SQL type wears a Pokémon type color (the [data-poke] tokens in styles.css).
  const TYPE_INFO = {
    AUTO: { label: 'Auto', poke: 'normal' },
    INT: { label: 'INT', poke: 'electric' },
    BIGINT: { label: 'BIGINT', poke: 'rock' },
    DECIMAL: { label: 'DECIMAL', poke: 'psychic' },
    BIT: { label: 'BIT', poke: 'fire' },
    VARCHAR: { label: 'VARCHAR', poke: 'grass' },
    NVARCHAR: { label: 'NVARCHAR', poke: 'water' },
    DATE: { label: 'DATE', poke: 'ice' },
    DATETIME: { label: 'DATETIME', poke: 'dragon' },
    UNIQUEIDENTIFIER: { label: 'GUID', poke: 'ghost' },
  };
  const VERB_POKE = { EXEC: 'electric', SELECT: 'water', INSERT: 'grass', UPDATE: 'psychic', DELETE: 'fire', MERGE: 'dragon' };

  const SQL_TYPES = new Set(['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'DECIMAL', 'NUMERIC', 'MONEY', 'BIT', 'VARCHAR',
    'NVARCHAR', 'CHAR', 'NCHAR', 'DATE', 'DATETIME', 'DATETIME2', 'TIME', 'UNIQUEIDENTIFIER', 'FLOAT']);
  const SQL_KEYWORDS = new Set(('SELECT FROM WHERE AND OR NOT IN IS LIKE BETWEEN JOIN INNER LEFT RIGHT OUTER FULL ' +
    'CROSS APPLY ON AS ORDER BY GROUP HAVING TOP DISTINCT UNION ALL INSERT INTO VALUES UPDATE SET DELETE MERGE ' +
    'USING WHEN MATCHED THEN ELSE END CASE BEGIN WHILE IF DECLARE TABLE IDENTITY PRIMARY KEY NOCOUNT RETURN ' +
    'OUTPUT OUT WITH NOLOCK MIN MAX COUNT SUM AVG EXISTS TRAN TRANSACTION COMMIT ROLLBACK TRY CATCH PRINT GO ' +
    'TRUNCATE DROP CREATE ALTER PROCEDURE PROC DEFAULT ASC DESC OFFSET FETCH NEXT ROWS ONLY').split(' '));

  const ICON = {
    fill: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3.5 13.5h9"/></svg>',
    clear: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
    remove: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4.2 4.5l.7 8.6a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.7-8.6"/></svg>',
    plus: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
  };

  const $ = id => document.getElementById(id);
  const sheetTable = $('sheet');
  const els = {
    query: $('query'),
    queryHl: $('queryHighlight'),
    qbVerb: $('qbVerb'),
    qbParams: $('qbParams'),
    sheet: sheetTable,
    thead: sheetTable.tHead,
    tbody: sheetTable.tBodies[0],
    sheetScroll: $('sheetScroll'),
    rowCount: $('rowCount'),
    importBtn: $('importBtn'),
    fileInput: $('fileInput'),
    addRows: $('addRowsBtn'),
    sample: $('sampleBtn'),
    clear: $('clearBtn'),
    legend: $('legend'),
    storageNote: $('storageNote'),
    colStyles: $('colStyles'),
    output: $('output'),
    copy: $('copyBtn'),
    lens: $('lens'),
    modeHint: $('modeHint'),
    stats: $('stats'),
    warnings: $('warnings'),
    optBlankNull: $('optBlankNull'),
    optTrim: $('optTrim'),
    optLower: $('optLower'),
    optTran: $('optTran'),
    pokeball: $('pokeball'),
    toast: $('toast'),
    importDialog: $('importDialog'),
    importFile: $('importFile'),
    importSheetField: $('importSheetField'),
    importSheet: $('importSheet'),
    importHeader: $('importHeader'),
    importSummary: $('importSummary'),
    importMap: $('importMap'),
    importPreview: $('importPreview'),
    importConfirm: $('importConfirm'),
  };
  const modeButtons = Array.from(document.querySelectorAll('[data-mode]'));

  const letter = E.letter;
  const count = n => n.toLocaleString('en-US');
  const plural = (n, word) => `${count(n)} ${word}${n === 1 ? '' : 's'}`;
  const pokeOf = type => (TYPE_INFO[type] || TYPE_INFO.AUTO).poke;
  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const sameName = (a, b) => E.cleanParamName(a).toLowerCase() === E.cleanParamName(b).toLowerCase();
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve)));

  // Every DOM write makes the browser lay the page out again, which is slow next to a long script: skip no-op writes.
  function setProp(target, prop, value) {
    if (target[prop] !== value) target[prop] = value;
  }
  const shownHTML = new WeakMap();
  function setHTML(el, html) {
    if (shownHTML.get(el) === html) return;
    shownHTML.set(el, html);
    el.innerHTML = html;
  }

  /* ---------- state ---------- */

  const blankRow = width => Array(width).fill('');
  const blankColumn = () => ({ name: '', type: 'AUTO', auto: false, seed: null });
  const colCount = () => state.columns.length;

  function emptyState() {
    return {
      query: '',
      columns: Array.from({ length: MIN_COLS }, blankColumn),
      rows: Array.from({ length: MIN_ROWS }, () => blankRow(MIN_COLS)),
      mode: 'direct',
      options: { tran: true, blankAsNull: true, trim: true, lowercase: false },
    };
  }

  function sampleState() {
    const s = emptyState();
    s.query = "exec re.nsp_customerledger_details @querytype = 1, @customername = 'rene'";
    s.columns[0] = { name: 'querytype', type: 'INT', auto: true, seed: '1' };
    s.columns[1] = { name: 'customername', type: 'VARCHAR', auto: true, seed: 'rene' };
    s.rows[0][0] = '1';
    s.rows[0][1] = 'rene';
    s.rows[1][0] = '1';
    s.rows[1][1] = 'norman';
    return s;
  }

  function lastFilledRow(rows) {
    for (let r = rows.length - 1; r >= 0; r--) if (rows[r].some(v => v !== '')) return r;
    return -1;
  }

  function padRows(rows, width) {
    const want = Math.max(MIN_ROWS, lastFilledRow(rows) + 1 + SPARE_ROWS);
    while (rows.length < want) rows.push(blankRow(width));
  }

  // Adds blank columns up to `total` (never past MAX_COLS).
  function ensureColumns(total) {
    while (colCount() < Math.min(total, MAX_COLS)) {
      state.columns.push(blankColumn());
      state.rows.forEach(r => r.push(''));
    }
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!saved || typeof saved !== 'object') return null;
      const s = emptyState();
      if (typeof saved.query === 'string') s.query = saved.query;
      if (Array.isArray(saved.columns)) {
        s.columns = saved.columns.slice(0, MAX_COLS).map(c => (c && typeof c === 'object' ? {
          name: typeof c.name === 'string' ? c.name : '',
          type: E.TYPES.includes(c.type) ? c.type : 'AUTO',
          auto: c.auto === true,
          seed: typeof c.seed === 'string' ? c.seed : null,
        } : blankColumn()));
        while (s.columns.length < MIN_COLS) s.columns.push(blankColumn());
      }
      const width = s.columns.length;
      s.rows = (Array.isArray(saved.rows) ? saved.rows.slice(0, MAX_ROWS) : [])
        .map(r => Array.from({ length: width }, (_, c) => (Array.isArray(r) && typeof r[c] === 'string' ? r[c] : '')));
      if (saved.mode === 'loop') s.mode = 'loop';
      if (saved.options && typeof saved.options === 'object') {
        Object.keys(s.options).forEach(k => {
          if (typeof saved.options[k] === 'boolean') s.options[k] = saved.options[k];
        });
      }
      padRows(s.rows, width);
      return s;
    } catch {
      return null;
    }
  }

  // A sheet too big for the browser's storage still keeps its query and column names.
  let saveTimer = 0;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      let complete = true;
      try {
        const rows = state.rows.slice(0, lastFilledRow(state.rows) + 1);
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, rows }));
      } catch {
        complete = false;
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, rows: [] }));
        } catch {
          /* storage blocked: the app keeps working, it just won't remember */
        }
      }
      els.storageNote.hidden = complete;
    }, state.rows.length > 5000 ? 1500 : 300);
  }

  let state = loadState() || sampleState();
  let prevParams = E.parseQuery(state.query).params; // what the Queryboard said last time
  let lastResult = null;
  let lastSql = null;
  let lastLineCount = 0;
  let undoSnapshot = null;
  let invalidMap = new Map(); // "row:col" → type, for cells that don't match their column type
  let lastOverflow = '';
  const pendingRename = new Map(); // column → @param it should rename once the header holds a valid name again

  /* ---------- sheet rendering ---------- */

  const TYPE_OPTIONS = E.TYPES.map(t => `<option value="${t}">${TYPE_INFO[t].label}</option>`).join('');

  function renderHeader() {
    const tr = document.createElement('tr');
    tr.innerHTML = '<th class="corner" scope="col">#</th>' + state.columns.map((_, c) => `
      <th class="col-head" scope="col" data-c="${c}">
        <div class="col-top">
          <span class="col-letter">${letter(c)}</span>
          <span class="col-tools">
            <button type="button" class="icon-btn" data-action="fill" data-c="${c}" title="Fill blanks down" aria-label="Fill blanks down in column ${letter(c)}">${ICON.fill}</button>
            <button type="button" class="icon-btn" data-action="clear-col" data-c="${c}" title="Clear column data" aria-label="Clear data in column ${letter(c)}">${ICON.clear}</button>
            <button type="button" class="icon-btn" data-action="remove-col" data-c="${c}" title="Remove column" aria-label="Remove column ${letter(c)}">${ICON.remove}</button>
          </span>
        </div>
        <select class="type-select" data-c="${c}" aria-label="Type of column ${letter(c)}">${TYPE_OPTIONS}</select>
        <input class="param-input" data-c="${c}" placeholder="col${c + 1}" spellcheck="false" autocomplete="off" aria-label="Parameter name of column ${letter(c)}">
      </th>`).join('') +
      (colCount() < MAX_COLS
        ? `<th class="col-add" scope="col"><button type="button" class="add-col" data-action="add-col" title="Add a column" aria-label="Add a column">${ICON.plus}</button></th>`
        : '');
    tr.querySelectorAll('.col-head').forEach((th, c) => {
      th.querySelector('select').value = state.columns[c].type;
      th.querySelector('input').value = state.columns[c].name;
    });
    els.thead.replaceChildren(tr);
    // Keyboard moves scroll a cell into view below the sticky header, not under it.
    els.sheetScroll.style.scrollPaddingTop = `${els.thead.offsetHeight}px`;
    if (lastResult) decorateHeader(lastResult);
  }

  // Only the rows in view (plus OVERSCAN) are in the DOM; spacer rows stand in for the rest.
  let rowHeight = 33;
  let view = { start: 0, end: 0 };

  function spacerRow(height) {
    const tr = document.createElement('tr');
    tr.className = 'spacer';
    tr.setAttribute('aria-hidden', 'true');
    const td = document.createElement('td');
    td.colSpan = colCount() + 1;
    td.style.height = `${height}px`;
    tr.append(td);
    return tr;
  }

  function paintInvalid(input, r, c) {
    const type = invalidMap.get(`${r}:${c}`);
    input.classList.toggle('invalid', !!type);
    if (type) input.title = `Not a valid ${TYPE_INFO[type] ? TYPE_INFO[type].label : type}`;
    else input.removeAttribute('title');
  }

  function makeRow(r) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.className = 'row-num';
    th.scope = 'row';
    th.textContent = r + 1;
    tr.append(th);
    for (let c = 0; c < colCount(); c++) {
      const td = document.createElement('td');
      const input = document.createElement('input');
      input.className = 'cell';
      input.dataset.r = r;
      input.dataset.c = c;
      input.value = state.rows[r][c];
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.setAttribute('aria-label', `${letter(c)}${r + 1}`);
      if (invalidMap.size) paintInvalid(input, r, c);
      td.append(input);
      tr.append(td);
    }
    return tr;
  }

  function renderBody() {
    const scroller = els.sheetScroll;
    const first = Math.floor(scroller.scrollTop / rowHeight);
    const visible = Math.ceil((scroller.clientHeight || 600) / rowHeight) + 1;
    const start = Math.max(0, Math.min(first, state.rows.length) - OVERSCAN);
    const end = Math.min(state.rows.length, first + visible + OVERSCAN);

    const active = document.activeElement;
    const keep = active && active.classList.contains('cell') && els.tbody.contains(active)
      ? { r: +active.dataset.r, c: +active.dataset.c, from: active.selectionStart, to: active.selectionEnd }
      : null;

    view = { start, end };
    const frag = document.createDocumentFragment();
    frag.append(spacerRow(start * rowHeight));
    for (let r = start; r < end; r++) frag.append(makeRow(r));
    frag.append(spacerRow((state.rows.length - end) * rowHeight));
    els.tbody.replaceChildren(frag);

    const again = keep && cellAt(keep.r, keep.c);
    if (again) {
      again.focus({ preventScroll: true });
      again.setSelectionRange(keep.from, keep.to);
    }
  }

  // Redraws once the visible rows get close to the edge of what's drawn.
  function syncWindow() {
    const scroller = els.sheetScroll;
    const first = Math.floor(scroller.scrollTop / rowHeight);
    const last = first + Math.ceil(scroller.clientHeight / rowHeight);
    const nearTop = view.start > 0 && first < view.start + 5;
    const nearBottom = view.end < state.rows.length && last > view.end - 5;
    if (nearTop || nearBottom) renderBody();
  }

  function measureRowHeight() {
    const tr = els.tbody.rows[1];
    if (!tr || tr.classList.contains('spacer')) return;
    const h = tr.getBoundingClientRect().height;
    if (h && Math.abs(h - rowHeight) > 0.5) {
      rowHeight = h;
      renderBody();
    }
  }

  function growRows(total) {
    const from = state.rows.length;
    const target = Math.min(total, MAX_ROWS + SPARE_ROWS);
    while (state.rows.length < target) state.rows.push(blankRow(colCount()));
    if (state.rows.length === from) return;
    if (view.end === from) {
      // The drawn rows reach the bottom: draw the new ones too (keeps the focused cell where it is).
      const frag = document.createDocumentFragment();
      for (let r = from; r < state.rows.length; r++) frag.append(makeRow(r));
      els.tbody.lastChild.before(frag);
      view.end = state.rows.length;
    } else {
      els.tbody.lastChild.firstChild.style.height = `${(state.rows.length - view.end) * rowHeight}px`;
    }
  }

  const cellAt = (r, c) => {
    if (r < view.start || r >= view.end) return null;
    const tr = els.tbody.rows[r - view.start + 1];
    return tr && tr.cells[c + 1] ? tr.cells[c + 1].firstChild : null;
  };

  function refreshColumnCells(indices) {
    for (let r = view.start; r < view.end; r++) {
      indices.forEach(c => {
        const input = cellAt(r, c);
        if (input) input.value = state.rows[r][c];
      });
    }
  }

  function decorateHeader(result) {
    const dim = [];
    els.thead.querySelectorAll('.col-head').forEach(th => {
      const c = +th.dataset.c;
      const info = result.columns[c];
      if (!info) return; // a column added since the last build; the next update() decorates it
      const col = state.columns[c];
      const isAuto = col.type === 'AUTO';
      const shown = isAuto ? (info.valueCount ? info.resolved : 'AUTO') : col.type;
      setProp(th.dataset, 'poke', pokeOf(shown));
      th.classList.toggle('is-auto', isAuto);
      th.classList.toggle('is-used', info.used);
      setProp(th.querySelector('option[value="AUTO"]'), 'textContent', isAuto && info.valueCount ? `Auto · ${TYPE_INFO[info.resolved].label}` : 'Auto');
      // A column the Queryboard names itself can't be removed here; drop the @param there instead.
      const param = result.params.find(p => p.column === c && !p.fromSheet);
      const remove = th.querySelector('[data-action="remove-col"]');
      setProp(remove, 'disabled', !!param);
      setProp(remove, 'title', param ? `Used by @${param.name} in the Queryboard` : 'Remove column');
      if (!info.name || (result.kind !== 'empty' && !info.used)) dim.push(c);
    });
    // Cells in columns the query doesn't use are dimmed. (A stylesheet change restyles the whole page: only when needed.)
    const css = dim
      .map(c => `.sheet tbody td:nth-child(${c + 2}) .cell:not(:focus):not(.invalid){color:var(--faint)}`)
      .join('\n');
    if (els.colStyles.textContent !== css) els.colStyles.textContent = css;
  }

  function markInvalid(result) {
    invalidMap = new Map(result.invalid.map(({ row, col, type }) => [`${row}:${col}`, type]));
    els.tbody.querySelectorAll('.cell.invalid').forEach(input => paintInvalid(input, +input.dataset.r, +input.dataset.c));
    result.invalid.forEach(({ row, col }) => {
      const input = cellAt(row, col);
      if (input) paintInvalid(input, row, col);
    });
  }

  function renderLegend() {
    els.legend.innerHTML = E.TYPES.filter(t => t !== 'AUTO').map(t => {
      const { label, poke } = TYPE_INFO[t];
      return `<span class="legend-item" data-poke="${poke}"><b>${label}</b>${poke[0].toUpperCase() + poke.slice(1)}</span>`;
    }).join('');
  }

  /* ---------- syntax highlighting ---------- */

  function highlightParts(tokens, varAttrs) {
    const parts = [];
    let proc = 0; // 1: right after EXEC, 2: inside the procedure name
    for (const t of tokens) {
      const nameLike = t.type === 'word' || t.type === 'ident' || (t.type === 'punct' && t.text === '.');
      let attrs = '';
      if (proc && nameLike) {
        attrs = ' class="tok-proc"';
        proc = 2;
      } else {
        if (proc === 2 || (proc === 1 && t.type !== 'ws')) proc = 0;
        switch (t.type) {
          case 'comment': attrs = ' class="tok-comment"'; break;
          case 'string': attrs = ' class="tok-str"'; break;
          case 'number': attrs = ' class="tok-num"'; break;
          case 'sysvar': attrs = ' class="tok-var"'; break;
          case 'var': attrs = (varAttrs && varAttrs(t.text.slice(1))) || ' class="tok-var"'; break;
          case 'ident': attrs = ' class="tok-ident"'; break;
          case 'punct': if ('=<>+-*/%'.includes(t.text)) attrs = ' class="tok-op"'; break;
          case 'word': {
            const up = t.text.toUpperCase();
            if (up === 'EXEC' || up === 'EXECUTE') {
              attrs = ' class="tok-kw"';
              proc = 1;
            } else if (up === 'NULL') attrs = ' class="tok-null"';
            else if (SQL_TYPES.has(up)) attrs = ' class="tok-type"';
            else if (SQL_KEYWORDS.has(up)) attrs = ' class="tok-kw"';
            break;
          }
        }
      }
      parts.push([attrs, t.text]);
    }
    return parts;
  }

  const wrap = (attrs, text) => (attrs ? `<span${attrs}>${esc(text)}</span>` : esc(text));

  function countLines(text) {
    let n = 1;
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++;
    return n;
  }

  // Draws the first PREVIEW_LINES lines; a long script would make the page crawl.
  function renderOutput(sql) {
    const hidden = Math.max(0, lastLineCount - PREVIEW_LINES);
    const shown = hidden ? sql.split('\n', PREVIEW_LINES).join('\n') : sql;
    const lines = [''];
    for (const [attrs, text] of highlightParts(E.tokenize(shown))) {
      text.split('\n').forEach((piece, i) => {
        if (i) lines.push('');
        if (piece) lines[lines.length - 1] += wrap(attrs, piece);
      });
    }
    els.output.style.setProperty('--gutter', `${String(lines.length).length + 1}ch`);
    els.output.innerHTML = lines.map((line, i) => `<span class="ln" data-n="${i + 1}">${line}</span>`).join('\n') +
      (hidden ? `\n<span class="more-lines">-- … ${plural(hidden, 'more line')}. Copy gets the whole script.</span>` : '');
  }

  // The Queryboard's text is transparent; this colored copy sits right underneath it.
  function renderQueryHighlight() {
    const byName = new Map((lastResult ? lastResult.params : []).map(p => [p.name.toLowerCase(), p]));
    const varAttrs = name => {
      const p = byName.get(name.toLowerCase());
      if (!p) return '';
      if (p.column === null) return ' class="qv-missing"';
      return ` class="qv" data-poke="${pokeOf(p.type)}"`;
    };
    const text = state.query;
    setHTML(els.queryHl, highlightParts(E.tokenize(text), varAttrs).map(([a, t]) => wrap(a, t)).join('') +
      (text === '' || text.endsWith('\n') ? ' ' : ''));
  }

  function autosizeQuery() {
    els.query.style.height = 'auto';
    els.query.style.height = `${Math.min(els.query.scrollHeight, 220)}px`;
    els.queryHl.scrollTop = els.query.scrollTop;
  }

  /* ---------- output & status ---------- */

  function renderQueryMeta(result) {
    setProp(els.qbVerb, 'hidden', !result.verb);
    setProp(els.qbVerb, 'textContent', result.verb);
    setProp(els.qbVerb.dataset, 'poke', VERB_POKE[result.verb] || 'normal');
    if (!result.params.length) {
      const hint = result.kind === 'empty' ? 'Every @param you type becomes a sheet column' : 'No @params — runs once';
      setHTML(els.qbParams, `<span class="qb-empty">${hint}</span>`);
      return;
    }
    setHTML(els.qbParams, result.params.map(p => {
      if (p.column === null) {
        return `<span class="pchip is-missing" title="No sheet column is named ${esc(p.name)}">@${esc(p.name)}<small>no column</small></span>`;
      }
      const title = p.fromSheet ? `Added from sheet column ${letter(p.column)}` : `Sheet column ${letter(p.column)}`;
      return `<span class="pchip${p.fromSheet ? ' from-sheet' : ''}" data-poke="${pokeOf(p.type)}" title="${title}">@${esc(p.name)}<small>${letter(p.column)}</small></span>`;
    }).join(''));
  }

  function renderStatus(result) {
    const rows = result.rowCount;
    const params = result.params.length;
    setProp(els.rowCount, 'textContent', plural(rows, 'row'));
    setHTML(els.stats, `<b>${count(rows)}</b> ${rows === 1 ? 'row' : 'rows'} · <b>${params}</b> ${params === 1 ? 'param' : 'params'} · <b>${count(lastLineCount)}</b> lines`);

    let hint = null;
    if (state.mode === 'loop' && rows === 1) hint = ['Just 1 row — Direct is all you need here.', 'direct', 'Use Direct'];
    else if (state.mode === 'direct' && rows > 100) hint = [`${count(rows)} rows — Loop keeps the script short.`, 'loop', 'Use Loop'];
    setProp(els.modeHint, 'hidden', !hint);
    if (hint) setHTML(els.modeHint, `<span>${hint[0]}</span><button type="button" data-switch="${hint[1]}">${hint[2]}</button>`);

    setHTML(els.warnings, result.warnings.map(w => `<li class="${w.level}">${esc(w.text)}</li>`).join(''));
  }

  // Restarting a CSS animation needs a forced layout, which costs seconds next to a long script.
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const LENS_BLINK = [
    { boxShadow: '0 0 0 2px #e8ecff22, 0 0 26px rgba(160, 210, 255, 1)', filter: 'brightness(1.5)' },
    { boxShadow: '0 0 0 2px #e8ecff22, 0 0 14px rgba(108, 180, 255, .55)', filter: 'none' },
  ];
  function blinkLens() {
    if (!reducedMotion.matches && els.lens.animate) els.lens.animate(LENS_BLINK, { duration: 450, easing: 'ease-out' });
  }

  // Big sheets wait a little longer after each keystroke before rebuilding the script.
  let updateTimer = 0;
  function scheduleUpdate() {
    clearTimeout(updateTimer);
    const cells = state.rows.length * colCount();
    updateTimer = setTimeout(update, cells > 500000 ? 400 : cells > 50000 ? 150 : 60);
  }

  function update() {
    clearTimeout(updateTimer);
    lastResult = E.build({
      query: state.query,
      columns: state.columns,
      rows: state.rows,
      mode: state.mode,
      options: state.options,
    });
    if (lastResult.sql !== lastSql) {
      lastSql = lastResult.sql;
      lastLineCount = countLines(lastSql);
      renderOutput(lastSql);
      blinkLens();
    }
    decorateHeader(lastResult);
    markInvalid(lastResult);
    renderQueryMeta(lastResult);
    renderQueryHighlight();
    renderStatus(lastResult);
    scheduleSave();
  }

  function syncControls() {
    modeButtons.forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === state.mode)));
    els.optBlankNull.checked = state.options.blankAsNull;
    els.optTrim.checked = state.options.trim;
    els.optLower.checked = state.options.lowercase;
    els.optTran.checked = state.options.tran;
  }

  function renderAll() {
    els.query.value = state.query;
    autosizeQuery();
    syncControls();
    renderHeader();
    renderBody();
    update();
  }

  /* ---------- Queryboard ⇄ sheet ---------- */

  function applyQueryToSheet() {
    const next = E.parseQuery(state.query).params;
    const before = colCount();
    const { changed, overflow } = E.syncColumns(state.columns, state.rows, prevParams, next, { maxColumns: MAX_COLS });
    prevParams = next;
    if (colCount() !== before) {
      changed.forEach(c => pendingRename.delete(c));
      renderHeader();
      renderBody();
    } else if (changed.length) {
      changed.forEach(c => pendingRename.delete(c));
      renderHeader();
      refreshColumnCells(changed);
    }
    const key = overflow.join(',');
    if (key && key !== lastOverflow) toast(`No room for @${overflow.join(', @')} — the sheet holds ${MAX_COLS} columns.`);
    lastOverflow = key;
    return changed.length > 0;
  }

  // Renaming a column header renames its @param in the Queryboard too.
  function renameColumn(c, value) {
    const col = state.columns[c];
    const from = pendingRename.get(c) || E.cleanParamName(col.name);
    const to = E.cleanParamName(value);
    if (!E.cleanParamName(col.name) && !pendingRename.has(c)) col.auto = false; // a name typed into an empty column is the user's
    col.name = value;

    const linked = from && E.queryUsesParam(state.query, from) &&
      !state.columns.some((other, i) => i !== c && sameName(other.name, from));
    if (!linked) {
      pendingRename.delete(c);
      return;
    }
    if (!E.isValidName(to)) {
      pendingRename.set(c, from); // mid-edit: wait until the header holds a usable name
      return;
    }
    pendingRename.delete(c);
    if (from === to) return;
    state.query = E.renameParam(state.query, from, to);
    els.query.value = state.query;
    prevParams = E.parseQuery(state.query).params;
    autosizeQuery();
    renderQueryHighlight();
  }

  els.query.addEventListener('input', () => {
    state.query = els.query.value;
    renderQueryHighlight();
    autosizeQuery();
    if (applyQueryToSheet()) update();
    else scheduleUpdate();
  });
  els.query.addEventListener('scroll', () => { els.queryHl.scrollTop = els.query.scrollTop; });

  /* ---------- sheet editing ---------- */

  els.sheet.addEventListener('input', e => {
    const t = e.target;
    if (t.classList.contains('cell')) {
      const r = +t.dataset.r;
      state.rows[r][+t.dataset.c] = t.value;
      if (r >= state.rows.length - 2) growRows(state.rows.length + GROW_BY);
    } else if (t.classList.contains('param-input')) {
      renameColumn(+t.dataset.c, t.value);
    } else {
      return;
    }
    scheduleUpdate();
  });

  els.sheet.addEventListener('change', e => {
    if (!e.target.classList.contains('type-select')) return;
    state.columns[+e.target.dataset.c].type = e.target.value;
    update();
  });

  els.sheet.addEventListener('focusout', e => {
    if (e.target.classList.contains('param-input')) pendingRename.delete(+e.target.dataset.c);
  });

  let scrollFrame = 0;
  els.sheetScroll.addEventListener('scroll', () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      syncWindow();
    });
  });
  window.addEventListener('resize', () => {
    autosizeQuery();
    syncWindow();
  });

  els.sheet.addEventListener('paste', e => {
    const t = e.target;
    const isCell = t.classList.contains('cell');
    const isHead = t.classList.contains('param-input');
    if (!isCell && !isHead) return;
    const grid = E.parseTSV(e.clipboardData ? e.clipboardData.getData('text/plain') : '');
    if (grid.length === 1 && grid[0].length === 1) return; // a single value pastes like normal text
    e.preventDefault();
    remember();

    const c0 = +t.dataset.c;
    const width = grid.reduce((w, row) => Math.max(w, row.length), 0);
    ensureColumns(c0 + width);
    const fit = Math.min(width, colCount() - c0);
    let r0 = 0;
    let data = grid;
    if (isHead) {
      E.uniqueNames(grid[0].slice(0, fit).map(E.toParamName)).forEach((name, j) => {
        state.columns[c0 + j] = { name, type: 'AUTO', auto: false, seed: null };
        pendingRename.delete(c0 + j);
      });
      state.rows.forEach(row => row.fill('', c0, c0 + fit));
      data = grid.slice(1);
    } else {
      r0 = +t.dataset.r;
    }
    const cut = Math.max(0, r0 + data.length - MAX_ROWS);
    if (cut) data = data.slice(0, data.length - cut);
    while (state.rows.length < r0 + data.length + SPARE_ROWS) state.rows.push(blankRow(colCount()));
    data.forEach((values, i) => values.slice(0, fit).forEach((v, j) => { state.rows[r0 + i][c0 + j] = v; }));

    renderHeader();
    renderBody();
    update();
    if (isHead) els.thead.querySelector(`.param-input[data-c="${c0}"]`).focus();
    else focusCell(r0, c0);

    let msg = `Pasted ${plural(data.length, 'row')} × ${plural(fit, 'column')}${isHead ? ' with headers' : ''}.`;
    if (width > fit) msg += ` ${plural(width - fit, 'extra column')} didn't fit.`;
    if (cut) msg += ` ${plural(cut, 'row')} past row ${count(MAX_ROWS)} didn't fit.`;
    toast(msg, { undo: true });
  });

  function focusCell(r, c) {
    if (c < 0 || c >= colCount()) return;
    if (r < 0) {
      const head = els.thead.querySelector(`.param-input[data-c="${c}"]`);
      head.focus();
      head.select();
      return;
    }
    if (r >= state.rows.length) growRows(r + 1 + SPARE_ROWS);
    if (r < view.start || r >= view.end) {
      els.sheetScroll.scrollTop = Math.max(0, r * rowHeight - els.sheetScroll.clientHeight / 2);
      renderBody();
    }
    const input = cellAt(r, c);
    if (!input) return;
    input.focus();
    input.select();
  }

  // Spreadsheet-style movement: Enter / arrows jump between cells.
  els.sheet.addEventListener('keydown', e => {
    const t = e.target;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (t.classList.contains('param-input')) {
      if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        focusCell(0, +t.dataset.c);
      }
      return;
    }
    if (!t.classList.contains('cell') || (e.shiftKey && e.key !== 'Enter')) return;
    const r = +t.dataset.r;
    const c = +t.dataset.c;
    const len = t.value.length;
    const all = t.selectionStart === 0 && t.selectionEnd === len;
    const atStart = all || (t.selectionStart === 0 && t.selectionEnd === 0);
    const atEnd = all || (t.selectionStart === len && t.selectionEnd === len);
    let to = null;
    switch (e.key) {
      case 'Enter': to = e.shiftKey ? [r - 1, c] : [r + 1, c]; break;
      case 'ArrowDown': to = [r + 1, c]; break;
      case 'ArrowUp': to = [r - 1, c]; break;
      case 'ArrowLeft': if (atStart) to = [r, c - 1]; break;
      case 'ArrowRight': if (atEnd) to = [r, c + 1]; break;
      default: return;
    }
    if (!to) return;
    e.preventDefault();
    focusCell(to[0], to[1]);
  });

  function lastDataRow() {
    for (let r = state.rows.length - 1; r >= 0; r--) {
      if (state.rows[r].some((v, c) => v.trim() !== '' && E.cleanParamName(state.columns[c].name))) return r;
    }
    return -1;
  }

  function clearColumn(c) {
    if (state.rows.every(r => r[c] === '')) {
      toast(`Column ${letter(c)} is already empty.`);
      return;
    }
    remember();
    state.rows.forEach(r => { r[c] = ''; });
    state.columns[c].seed = null;
    refreshColumnCells([c]);
    update();
    toast(`Column ${letter(c)} cleared.`, { undo: true });
  }

  // Each blank cell takes the value above it, down to the last row that has data.
  function fillDown(c) {
    const before = JSON.stringify(state);
    let current = '';
    let filled = 0;
    for (let r = 0; r <= lastDataRow(); r++) {
      if (state.rows[r][c].trim() !== '') current = state.rows[r][c];
      else if (current !== '') {
        state.rows[r][c] = current;
        filled++;
      }
    }
    if (!filled) {
      toast(`Nothing to fill in column ${letter(c)}.`);
      return;
    }
    undoSnapshot = before;
    refreshColumnCells([c]);
    update();
    toast(`Filled ${plural(filled, 'blank cell')} in column ${letter(c)}.`, { undo: true });
  }

  function addColumn() {
    ensureColumns(colCount() + 1);
    renderHeader();
    renderBody();
    update();
    els.sheetScroll.scrollTo({ left: els.sheetScroll.scrollWidth, behavior: 'smooth' });
    els.thead.querySelector(`.param-input[data-c="${colCount() - 1}"]`).focus({ preventScroll: true });
  }

  function removeColumn(c) {
    remember();
    const name = E.cleanParamName(state.columns[c].name);
    state.columns.splice(c, 1);
    state.rows.forEach(r => r.splice(c, 1));
    ensureColumns(MIN_COLS);
    pendingRename.clear();
    renderHeader();
    renderBody();
    update();
    toast(`Column ${letter(c)}${name ? ` (${name})` : ''} removed.`, { undo: true });
  }

  els.thead.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const c = +btn.dataset.c;
    switch (btn.dataset.action) {
      case 'add-col': addColumn(); break;
      case 'remove-col': removeColumn(c); break;
      case 'clear-col': clearColumn(c); break;
      default: fillDown(c);
    }
  });

  els.addRows.addEventListener('click', () => {
    growRows(state.rows.length + GROW_BY);
    els.sheetScroll.scrollTo({ top: els.sheetScroll.scrollHeight, behavior: 'smooth' });
  });

  els.sample.addEventListener('click', () => {
    remember();
    const { mode, options } = state;
    state = sampleState();
    state.mode = mode;
    state.options = options;
    prevParams = E.parseQuery(state.query).params;
    pendingRename.clear();
    renderAll();
    toast('Sample loaded.', { undo: true });
  });

  els.clear.addEventListener('click', () => {
    remember();
    state.columns = Array.from({ length: MIN_COLS }, blankColumn);
    state.rows = Array.from({ length: MIN_ROWS }, () => blankRow(MIN_COLS));
    prevParams = E.parseQuery(state.query).params;
    E.syncColumns(state.columns, state.rows, [], prevParams, { maxColumns: MAX_COLS });
    pendingRename.clear();
    els.sheetScroll.scrollTo(0, 0);
    renderAll();
    toast(prevParams.length ? 'Sheet cleared — columns re-linked to the Queryboard.' : 'Sheet cleared.', { undo: true });
  });

  /* ---------- importing a file ---------- */

  let xlsxLoading = null;
  function loadXLSX() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (!xlsxLoading) {
      xlsxLoading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'vendor/xlsx.full.min.js';
        script.onload = () => resolve(window.XLSX);
        script.onerror = () => {
          xlsxLoading = null;
          reject(new Error('the Excel reader (vendor/xlsx.full.min.js) did not load'));
        };
        document.head.append(script);
      });
    }
    return xlsxLoading;
  }

  async function openFile(file) {
    if (!I.isExcelFile(file.name) && !I.isTextFile(file.name) && !I.isJsonFile(file.name)) {
      toast(`${file.name} can't be imported. Use a .xlsx, .xls, .csv or .json file.`);
      return;
    }
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      toast(`${file.name} is over ${MAX_FILE_MB} MB. Save just the rows you need into a smaller file.`);
      return;
    }
    toast(`Reading ${file.name}…`);
    await nextFrame(); // let the toast show before the browser gets busy
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const limit = { maxRows: MAX_ROWS + 1 };
      let sheets;
      if (I.isExcelFile(file.name)) sheets = I.workbookSheets(await loadXLSX(), bytes, limit);
      else if (I.isJsonFile(file.name)) sheets = I.jsonSheets(I.decodeText(bytes), file.name, limit);
      else sheets = I.textSheets(I.decodeText(bytes), file.name, limit);
      const sheet = pickSheet(sheets);
      if (sheet === -1) {
        toast(`${file.name} has no data in it.`);
        return;
      }
      els.toast.classList.remove('show');
      openImportDialog(file.name, sheets, sheet);
    } catch (err) {
      toast(`Couldn't read ${file.name}: ${err && err.message ? err.message : err}`);
    }
  }

  // The sheet whose columns match the most Queryboard @params; otherwise the first one with data.
  function pickSheet(sheets) {
    const params = E.parseQuery(state.query).params.map(p => p.name);
    let best = -1;
    let bestScore = -1;
    sheets.forEach((s, i) => {
      if (!s.grid.length) return;
      const names = I.headerNames(s.grid, s.hasHeader ?? I.looksLikeHeader(s.grid));
      const score = I.suggestMapping(names, params).filter(c => c !== -1).length;
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    });
    return best;
  }

  let importCtx = null; // { fileName, sheets, sheet, hasHeader, params, map: column index per @param }

  function openImportDialog(fileName, sheets, sheet) {
    const q = E.parseQuery(state.query);
    importCtx = { fileName, sheets, sheet, hasHeader: false, params: q.params.map(p => p.name), map: [] };
    els.importFile.textContent = fileName;
    els.importSheetField.hidden = sheets.length < 2;
    els.importSheet.innerHTML = sheets.map((s, i) => `<option value="${i}">${esc(s.name)}</option>`).join('');
    els.importSheet.value = String(sheet);
    selectImportSheet(sheet);
    els.importDialog.returnValue = '';
    els.importDialog.showModal();
  }

  function selectImportSheet(index) {
    const sheet = importCtx.sheets[index];
    importCtx.sheet = index;
    importCtx.hasHeader = sheet.hasHeader ?? I.looksLikeHeader(sheet.grid); // JSON objects: their keys are the header
    els.importHeader.checked = importCtx.hasHeader;
    suggestImportMapping();
    renderImportDialog();
  }

  // With headers, match @params by name; without, line them up with the columns in order.
  function suggestImportMapping() {
    const { params, hasHeader } = importCtx;
    const grid = importCtx.sheets[importCtx.sheet].grid;
    const names = I.headerNames(grid, hasHeader);
    importCtx.map = hasHeader
      ? I.suggestMapping(names, params)
      : params.map((_, k) => (k < names.length ? k : -1));
  }

  function importRename() {
    const rename = {};
    importCtx.map.forEach((c, k) => { if (c !== -1) rename[c] = importCtx.params[k]; });
    return rename;
  }

  function renderImportDialog() {
    const { sheets, sheet, hasHeader, params, map } = importCtx;
    const grid = sheets[sheet].grid;
    const names = I.headerNames(grid, hasHeader);
    const width = names.length;
    const dataRows = Math.max(0, grid.length - (hasHeader ? 1 : 0));

    const notes = [];
    if (sheets[sheet].truncated || dataRows > MAX_ROWS) notes.push(`Only the first ${count(MAX_ROWS)} rows come in.`);
    if (width > MAX_COLS) notes.push(`Only the first ${MAX_COLS} columns come in.`);
    els.importSummary.innerHTML = dataRows
      ? `<b>${count(Math.min(dataRows, MAX_ROWS))}</b> ${dataRows === 1 ? 'row' : 'rows'} × <b>${Math.min(width, MAX_COLS)}</b> ${width === 1 ? 'column' : 'columns'}` +
        notes.map(n => ` <span class="note">${esc(n)}</span>`).join('')
      : '<span class="note">No data rows on this sheet.</span>';
    els.importConfirm.disabled = !dataRows;

    // Which column feeds each Queryboard @param.
    els.importMap.hidden = !params.length;
    els.importMap.replaceChildren();
    if (params.length) {
      const options = names.slice(0, MAX_COLS)
        .map((n, c) => `<option value="${c}">${esc(n ? `${letter(c)} · ${n}` : `Column ${letter(c)}`)}</option>`).join('');
      els.importMap.innerHTML = '<p class="import-map-title">Fill the Queryboard @params from</p>' + params.map((p, k) => `
        <label class="map-row">
          <span class="map-param">@${esc(p)}</span>
          <select class="select" data-k="${k}" aria-label="Column for @${esc(p)}"><option value="-1">an empty column</option>${options}</select>
        </label>`).join('');
      els.importMap.querySelectorAll('select').forEach(sel => { sel.value = String(map[+sel.dataset.k]); });
    }

    const preview = I.buildSheet(grid.slice(0, 7), { hasHeader, rename: importRename(), maxColumns: MAX_COLS });
    const linked = new Set(params.map(p => p.toLowerCase()));
    els.importPreview.innerHTML =
      `<thead><tr><th></th>${preview.columns.map((col, c) => `
        <th class="${col.name && linked.has(col.name.toLowerCase()) ? 'is-linked' : ''}">
          <span class="pv-letter">${letter(c)}</span>${col.name ? `<span class="pv-name">${esc(col.name)}</span>` : '<span class="pv-name is-blank">no name</span>'}
        </th>`).join('')}</tr></thead>` +
      `<tbody>${preview.rows.slice(0, 6).map((row, i) => `<tr><th>${i + 1}</th>${row.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody>`;
  }

  function applyImport() {
    const { fileName, sheets, sheet, hasHeader } = importCtx;
    const built = I.buildSheet(sheets[sheet].grid, {
      hasHeader, rename: importRename(), minColumns: MIN_COLS, maxColumns: MAX_COLS, maxRows: MAX_ROWS,
    });
    remember();
    const imported = built.rows.length;
    const used = built.columns.filter((col, c) => col.name || built.rows.some(r => r[c] !== '')).length;
    state.columns = built.columns;
    state.rows = built.rows;
    padRows(state.rows, colCount());
    prevParams = E.parseQuery(state.query).params;
    E.syncColumns(state.columns, state.rows, [], prevParams, { maxColumns: MAX_COLS }); // unmatched @params get an empty column
    pendingRename.clear();
    els.sheetScroll.scrollTo(0, 0);
    renderAll();
    toast(`Imported ${plural(imported, 'row')} × ${plural(used, 'column')} from ${fileName}.`, { undo: true });
  }

  els.importBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    const file = els.fileInput.files[0];
    els.fileInput.value = '';
    if (file) openFile(file);
  });

  els.importSheet.addEventListener('change', () => selectImportSheet(+els.importSheet.value));
  els.importHeader.addEventListener('change', () => {
    importCtx.hasHeader = els.importHeader.checked;
    suggestImportMapping();
    renderImportDialog();
  });
  els.importMap.addEventListener('change', e => {
    const k = +e.target.dataset.k;
    const c = +e.target.value;
    importCtx.map = importCtx.map.map((v, j) => (j === k ? c : v === c ? -1 : v)); // one column feeds one @param
    renderImportDialog();
  });
  els.importDialog.addEventListener('click', e => {
    if (e.target === els.importDialog) els.importDialog.close('cancel'); // a click on the backdrop
  });
  els.importDialog.addEventListener('close', () => {
    if (els.importDialog.returnValue === 'import') applyImport();
    importCtx = null;
  });

  // Drop a file anywhere on the page.
  const hasFiles = e => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  let dragDepth = 0;
  window.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('is-dropping');
  });
  window.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', e => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) document.body.classList.remove('is-dropping');
  });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('is-dropping');
    const file = e.dataTransfer.files[0];
    if (file) openFile(file);
  });

  /* ---------- output controls ---------- */

  function setMode(mode) {
    state.mode = mode;
    syncControls();
    update();
  }

  modeButtons.forEach(b => {
    b.addEventListener('click', () => setMode(b.dataset.mode));
    b.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const other = modeButtons.find(x => x !== b);
      setMode(other.dataset.mode);
      other.focus();
    });
  });

  els.modeHint.addEventListener('click', e => {
    const btn = e.target.closest('[data-switch]');
    if (btn) setMode(btn.dataset.switch);
  });

  [[els.optTran, 'tran'], [els.optBlankNull, 'blankAsNull'], [els.optTrim, 'trim'], [els.optLower, 'lowercase']].forEach(([input, key]) => {
    input.addEventListener('change', () => {
      state.options[key] = input.checked;
      update();
    });
  });

  function legacyCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }

  let copyTimer = 0;
  els.copy.addEventListener('click', async () => {
    const text = lastResult ? lastResult.sql : '';
    let ok;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = legacyCopy(text);
    }
    if (!ok) {
      toast('The browser blocked copying — click the output, press Ctrl+A then Ctrl+C.');
      return;
    }
    const label = els.copy.querySelector('span');
    els.copy.classList.add('copied');
    label.textContent = 'Gotcha!';
    els.pokeball.classList.remove('catch');
    void els.pokeball.getBoundingClientRect();
    els.pokeball.classList.add('catch');
    toast(`Gotcha! ${plural(lastLineCount, 'line')} copied.`);
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      els.copy.classList.remove('copied');
      label.textContent = 'Copy';
    }, 1600);
  });

  // Ctrl+A inside the output selects just the SQL, not the whole page.
  els.output.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      window.getSelection().selectAllChildren(els.output);
    }
  });

  /* ---------- toast & undo ---------- */

  let toastTimer = 0;
  function toast(message, { undo = false } = {}) {
    const text = document.createElement('span');
    text.textContent = message;
    els.toast.replaceChildren(text);
    if (undo) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Undo';
      btn.addEventListener('click', restoreUndo);
      els.toast.append(btn);
    }
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), undo ? 6000 : 2800);
  }

  function remember() {
    undoSnapshot = JSON.stringify(state);
  }

  function restoreUndo() {
    if (!undoSnapshot) return;
    state = JSON.parse(undoSnapshot);
    undoSnapshot = null;
    prevParams = E.parseQuery(state.query).params;
    pendingRename.clear();
    renderAll();
    toast('Undone.');
  }

  /* ---------- go ---------- */

  renderLegend();
  renderAll();
  measureRowHeight();
})();
