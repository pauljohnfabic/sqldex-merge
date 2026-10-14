/* SQLDex Merge UI — wires the Queryboard, the sheet and the live output together.
   All SQL logic lives in engine.js. */
(function () {
  'use strict';

  const E = window.SqlDexEngine;

  const COLS = 10;
  const MIN_ROWS = 20;
  const SPARE_ROWS = 5;
  const GROW_BY = 10;
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
    addRows: $('addRowsBtn'),
    sample: $('sampleBtn'),
    clear: $('clearBtn'),
    legend: $('legend'),
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
  };
  const modeButtons = Array.from(document.querySelectorAll('[data-mode]'));

  const letter = i => String.fromCharCode(65 + i);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const pokeOf = type => (TYPE_INFO[type] || TYPE_INFO.AUTO).poke;
  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const sameName = (a, b) => E.cleanParamName(a).toLowerCase() === E.cleanParamName(b).toLowerCase();

  /* ---------- state ---------- */

  const blankRow = () => Array(COLS).fill('');
  const blankColumn = () => ({ name: '', type: 'AUTO', auto: false, seed: null });

  function emptyState() {
    return {
      query: '',
      columns: Array.from({ length: COLS }, blankColumn),
      rows: Array.from({ length: MIN_ROWS }, blankRow),
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

  function padRows(rows) {
    const want = Math.max(MIN_ROWS, lastFilledRow(rows) + 1 + SPARE_ROWS);
    while (rows.length < want) rows.push(blankRow());
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!saved || typeof saved !== 'object') return null;
      const s = emptyState();
      if (typeof saved.query === 'string') s.query = saved.query;
      if (Array.isArray(saved.columns)) {
        saved.columns.slice(0, COLS).forEach((c, i) => {
          if (!c || typeof c !== 'object') return;
          s.columns[i] = {
            name: typeof c.name === 'string' ? c.name : '',
            type: E.TYPES.includes(c.type) ? c.type : 'AUTO',
            auto: c.auto === true,
            seed: typeof c.seed === 'string' ? c.seed : null,
          };
        });
      }
      if (Array.isArray(saved.rows)) {
        s.rows = saved.rows.map(r => Array.from({ length: COLS }, (_, c) => (Array.isArray(r) && typeof r[c] === 'string' ? r[c] : '')));
      }
      if (saved.mode === 'loop') s.mode = 'loop';
      if (saved.options && typeof saved.options === 'object') {
        Object.keys(s.options).forEach(k => {
          if (typeof saved.options[k] === 'boolean') s.options[k] = saved.options[k];
        });
      }
      padRows(s.rows);
      return s;
    } catch {
      return null;
    }
  }

  let saveTimer = 0;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        const rows = state.rows.slice(0, lastFilledRow(state.rows) + 1);
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, rows }));
      } catch {
        /* storage blocked or full: the app keeps working, it just won't remember */
      }
    }, 300);
  }

  let state = loadState() || sampleState();
  let prevParams = E.parseQuery(state.query).params; // what the Queryboard said last time
  let lastResult = null;
  let lastSql = null;
  let undoSnapshot = null;
  let invalidCells = [];
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
          </span>
        </div>
        <select class="type-select" data-c="${c}" aria-label="Type of column ${letter(c)}">${TYPE_OPTIONS}</select>
        <input class="param-input" data-c="${c}" placeholder="col${c + 1}" spellcheck="false" autocomplete="off" aria-label="Parameter name of column ${letter(c)}">
      </th>`).join('');
    tr.querySelectorAll('.col-head').forEach((th, c) => {
      th.querySelector('select').value = state.columns[c].type;
      th.querySelector('input').value = state.columns[c].name;
    });
    els.thead.replaceChildren(tr);
    if (lastResult) decorateHeader(lastResult);
  }

  function makeRow(r) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.className = 'row-num';
    th.scope = 'row';
    th.textContent = r + 1;
    tr.append(th);
    for (let c = 0; c < COLS; c++) {
      const td = document.createElement('td');
      const input = document.createElement('input');
      input.className = 'cell';
      input.dataset.r = r;
      input.dataset.c = c;
      input.value = state.rows[r][c];
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.setAttribute('aria-label', `${letter(c)}${r + 1}`);
      td.append(input);
      tr.append(td);
    }
    return tr;
  }

  function renderBody() {
    const frag = document.createDocumentFragment();
    state.rows.forEach((_, r) => frag.append(makeRow(r)));
    els.tbody.replaceChildren(frag);
    invalidCells = [];
  }

  function growRows(count) {
    const frag = document.createDocumentFragment();
    while (state.rows.length < count) {
      state.rows.push(blankRow());
      frag.append(makeRow(state.rows.length - 1));
    }
    els.tbody.append(frag);
  }

  const cellAt = (r, c) => {
    const tr = els.tbody.rows[r];
    return tr ? tr.cells[c + 1].firstChild : null;
  };

  function refreshColumnCells(indices) {
    Array.from(els.tbody.rows).forEach((tr, r) => {
      indices.forEach(c => { tr.cells[c + 1].firstChild.value = state.rows[r][c]; });
    });
  }

  function decorateHeader(result) {
    const dim = [];
    els.thead.querySelectorAll('.col-head').forEach(th => {
      const c = +th.dataset.c;
      const info = result.columns[c];
      const col = state.columns[c];
      const isAuto = col.type === 'AUTO';
      const shown = isAuto ? (info.valueCount ? info.resolved : 'AUTO') : col.type;
      th.dataset.poke = pokeOf(shown);
      th.classList.toggle('is-auto', isAuto);
      th.classList.toggle('is-used', info.used);
      th.querySelector('option[value="AUTO"]').textContent = isAuto && info.valueCount ? `Auto · ${TYPE_INFO[info.resolved].label}` : 'Auto';
      if (!info.name || (result.kind !== 'empty' && !info.used)) dim.push(c);
    });
    // Cells in columns the query doesn't use are dimmed.
    els.colStyles.textContent = dim
      .map(c => `.sheet tbody td:nth-child(${c + 2}) .cell:not(:focus):not(.invalid){color:var(--faint)}`)
      .join('\n');
  }

  function markInvalid(result) {
    invalidCells.forEach(input => {
      input.classList.remove('invalid');
      input.removeAttribute('title');
    });
    invalidCells = [];
    result.invalid.forEach(({ row, col, type }) => {
      const input = cellAt(row, col);
      if (!input) return;
      input.classList.add('invalid');
      input.title = `Not a valid ${TYPE_INFO[type] ? TYPE_INFO[type].label : type}`;
      invalidCells.push(input);
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

  function renderOutput(sql) {
    const lines = [''];
    for (const [attrs, text] of highlightParts(E.tokenize(sql))) {
      text.split('\n').forEach((piece, i) => {
        if (i) lines.push('');
        if (piece) lines[lines.length - 1] += wrap(attrs, piece);
      });
    }
    els.output.style.setProperty('--gutter', `${String(lines.length).length + 1}ch`);
    els.output.innerHTML = lines.map(line => `<span class="ln">${line}</span>`).join('\n');
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
    els.queryHl.innerHTML = highlightParts(E.tokenize(text), varAttrs).map(([a, t]) => wrap(a, t)).join('') +
      (text === '' || text.endsWith('\n') ? ' ' : '');
    els.queryHl.scrollTop = els.query.scrollTop;
  }

  function autosizeQuery() {
    els.query.style.height = 'auto';
    els.query.style.height = `${Math.min(els.query.scrollHeight, 220)}px`;
    els.queryHl.scrollTop = els.query.scrollTop;
  }

  /* ---------- output & status ---------- */

  function renderQueryMeta(result) {
    els.qbVerb.hidden = !result.verb;
    els.qbVerb.textContent = result.verb;
    els.qbVerb.dataset.poke = VERB_POKE[result.verb] || 'normal';
    if (!result.params.length) {
      const hint = result.kind === 'empty' ? 'Every @param you type becomes a sheet column' : 'No @params — runs once';
      els.qbParams.innerHTML = `<span class="qb-empty">${hint}</span>`;
      return;
    }
    els.qbParams.innerHTML = result.params.map(p => {
      if (p.column === null) {
        return `<span class="pchip is-missing" title="No sheet column is named ${esc(p.name)}">@${esc(p.name)}<small>no column</small></span>`;
      }
      const title = p.fromSheet ? `Added from sheet column ${letter(p.column)}` : `Sheet column ${letter(p.column)}`;
      return `<span class="pchip${p.fromSheet ? ' from-sheet' : ''}" data-poke="${pokeOf(p.type)}" title="${title}">@${esc(p.name)}<small>${letter(p.column)}</small></span>`;
    }).join('');
  }

  function renderStatus(result) {
    const rows = result.rowCount;
    const params = result.params.length;
    els.rowCount.textContent = plural(rows, 'row');
    els.stats.innerHTML = `<b>${rows}</b> ${rows === 1 ? 'row' : 'rows'} · <b>${params}</b> ${params === 1 ? 'param' : 'params'} · <b>${result.sql.split('\n').length}</b> lines`;

    let hint = null;
    if (state.mode === 'loop' && rows === 1) hint = ['Just 1 row — Direct is all you need here.', 'direct', 'Use Direct'];
    else if (state.mode === 'direct' && rows > 100) hint = [`${rows} rows — Loop keeps the script short.`, 'loop', 'Use Loop'];
    els.modeHint.hidden = !hint;
    if (hint) els.modeHint.innerHTML = `<span>${hint[0]}</span><button type="button" data-switch="${hint[1]}">${hint[2]}</button>`;

    els.warnings.innerHTML = result.warnings.map(w => `<li class="${w.level}">${esc(w.text)}</li>`).join('');
  }

  function blinkLens() {
    els.lens.classList.remove('blink');
    void els.lens.offsetWidth; // restart the animation
    els.lens.classList.add('blink');
  }

  let updateTimer = 0;
  function scheduleUpdate() {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(update, 60);
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
    const { changed, overflow } = E.syncColumns(state.columns, state.rows, prevParams, next);
    prevParams = next;
    if (changed.length) {
      changed.forEach(c => pendingRename.delete(c));
      renderHeader();
      refreshColumnCells(changed);
    }
    const key = overflow.join(',');
    if (key && key !== lastOverflow) toast(`No free column left for @${overflow.join(', @')} — the sheet holds ${COLS}.`);
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
  window.addEventListener('resize', autosizeQuery);

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
    const width = Math.max(...grid.map(r => r.length));
    const fit = Math.min(width, COLS - c0);
    let r0 = 0;
    let data = grid;
    if (isHead) {
      grid[0].slice(0, fit).forEach((name, j) => {
        state.columns[c0 + j] = { name: name.trim(), type: 'AUTO', auto: false, seed: null };
        pendingRename.delete(c0 + j);
      });
      state.rows.forEach(row => row.fill('', c0, c0 + fit));
      data = grid.slice(1);
    } else {
      r0 = +t.dataset.r;
    }
    while (state.rows.length < r0 + data.length + SPARE_ROWS) state.rows.push(blankRow());
    data.forEach((values, i) => values.slice(0, fit).forEach((v, j) => { state.rows[r0 + i][c0 + j] = v; }));

    renderHeader();
    renderBody();
    update();
    const target = isHead ? els.thead.querySelector(`.param-input[data-c="${c0}"]`) : cellAt(r0, c0);
    if (target) target.focus();

    let msg = `Pasted ${plural(data.length, 'row')} × ${plural(fit, 'column')}${isHead ? ' with headers' : ''}.`;
    if (width > fit) msg += ` ${plural(width - fit, 'extra column')} didn't fit.`;
    toast(msg, { undo: true });
  });

  function focusCell(r, c) {
    if (c < 0 || c >= COLS) return;
    if (r < 0) {
      const head = els.thead.querySelector(`.param-input[data-c="${c}"]`);
      head.focus();
      head.select();
      return;
    }
    if (r >= state.rows.length) growRows(r + 1 + SPARE_ROWS);
    const input = cellAt(r, c);
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

  els.thead.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const c = +btn.dataset.c;
    if (btn.dataset.action === 'clear-col') clearColumn(c);
    else fillDown(c);
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
    state.columns = Array.from({ length: COLS }, blankColumn);
    state.rows = Array.from({ length: MIN_ROWS }, blankRow);
    prevParams = E.parseQuery(state.query).params;
    E.syncColumns(state.columns, state.rows, [], prevParams);
    pendingRename.clear();
    renderAll();
    toast(prevParams.length ? 'Sheet cleared — columns re-linked to the Queryboard.' : 'Sheet cleared.', { undo: true });
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
    toast(`Gotcha! ${plural(text.split('\n').length, 'line')} copied.`);
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
})();
