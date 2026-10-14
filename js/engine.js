/**
 * SQLDex Merge engine — everything that isn't UI:
 *   - reads the Queryboard (an EXEC call, or any SQL with @params),
 *   - keeps the sheet's columns in step with those @params while you type,
 *   - turns sheet rows into T-SQL: one statement per row, or a WHILE loop over @tbl.
 * No DOM in here, so the same file runs in the browser (window.SqlDexEngine) and in the Node tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SqlDexEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TYPES = ['AUTO', 'INT', 'BIGINT', 'DECIMAL', 'BIT', 'VARCHAR', 'NVARCHAR', 'DATE', 'DATETIME', 'UNIQUEIDENTIFIER'];
  const INSERT_BATCH = 1000; // SQL Server allows at most 1000 rows in one INSERT ... VALUES
  const INT_MAX = 2147483647;

  const RE = {
    int: /^[-+]?\d+$/,
    dec: /^[-+]?(\d+\.?\d*|\.\d+)$/,
    thousands: /^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/,
    leadingZero: /^[-+]?0\d/,
    guid: /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i,
    date: /^(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})([ T]\d{1,2}:\d{2}(:\d{2}(\.\d{1,7})?)?\s*([AaPp][Mm])?)?$/,
    time: /\d{1,2}:\d{2}/,
    boolWord: /^(true|false|yes|no)$/i,
    nonAscii: /[^\x00-\x7F]/,
    ident: /^[\p{L}_][\p{L}\p{N}_$#]*$/u,
    nullWord: /^null$/i,
    procPrefix: /^[a-z]{0,3}sp_/i,
    goLine: /^\s*go\s*$/i,
  };
  const WORD_START = /[\p{L}_#]/u;
  const WORD_CHAR = /[\p{L}\p{N}_$#]/u;

  // Words that start a new statement; used to tell where an EXEC call ends.
  const STATEMENT_WORDS = new Set(('EXEC EXECUTE SELECT INSERT UPDATE DELETE MERGE DECLARE SET IF ELSE WHILE ' +
    'BEGIN END GO WITH PRINT RETURN TRUNCATE DROP CREATE ALTER USE RAISERROR THROW').split(' '));

  // T-SQL reserved words that must be [bracketed] when used as a column name in @tbl.
  const RESERVED = new Set(('ADD ALL ALTER AND ANY AS ASC AUTHORIZATION BACKUP BEGIN BETWEEN BREAK BROWSE BULK BY ' +
    'CASCADE CASE CHECK CHECKPOINT CLOSE CLUSTERED COLLATE COLUMN COMMIT COMPUTE CONSTRAINT CONTAINS CONTINUE ' +
    'CONVERT CREATE CROSS CURRENT CURSOR DATABASE DBCC DEALLOCATE DECLARE DEFAULT DELETE DENY DESC DISK DISTINCT ' +
    'DISTRIBUTED DOUBLE DROP DUMP ELSE END ERRLVL ESCAPE EXCEPT EXEC EXECUTE EXISTS EXIT EXTERNAL FETCH FILE ' +
    'FILLFACTOR FOR FOREIGN FREETEXT FROM FULL FUNCTION GOTO GRANT GROUP HAVING HOLDLOCK IDENTITY IF IN INDEX ' +
    'INNER INSERT INTERSECT INTO IS JOIN KEY KILL LEFT LIKE LINENO MERGE NATIONAL NOCHECK NONCLUSTERED NOT NULL ' +
    'NULLIF OF OFF OFFSETS ON OPEN OPTION OR ORDER OUTER OVER PERCENT PIVOT PLAN PRIMARY PRINT PROC PROCEDURE ' +
    'PUBLIC RAISERROR READ READTEXT RECONFIGURE REFERENCES REPLICATION RESTORE RESTRICT RETURN REVERT REVOKE ' +
    'RIGHT ROLLBACK ROWCOUNT ROWGUIDCOL RULE SAVE SCHEMA SELECT SESSION_USER SET SETUSER SHUTDOWN SOME ' +
    'STATISTICS SYSTEM_USER TABLE TABLESAMPLE TEXTSIZE THEN TO TOP TRAN TRANSACTION TRIGGER TRUNCATE UNION ' +
    'UNIQUE UNPIVOT UPDATE UPDATETEXT USE USER VALUES VARYING VIEW WAITFOR WHEN WHERE WHILE WITH WRITETEXT').split(' '));

  /* ---------- small helpers ---------- */

  const isBlank = v => String(v ?? '').trim() === '';
  const isNullWord = v => RE.nullWord.test(String(v ?? '').trim());
  const isCode = t => t.type !== 'ws' && t.type !== 'comment';
  const isPunct = (t, text) => !!t && t.type === 'punct' && t.text === text;
  const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
  const letter = i => String.fromCharCode(65 + i);
  const quote = v => `'${v.replace(/'/g, "''")}'`;
  const textOf = tokens => tokens.map(t => t.text).join('');
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function cleanParamName(raw) {
    return String(raw ?? '').trim().replace(/^@+/, '').trim();
  }

  function isValidName(name) {
    return RE.ident.test(name);
  }

  // Only strip commas that really are thousands separators ("1,250.50"), not lists ("1,2,3").
  function normalizeNumber(v) {
    return RE.thousands.test(v) ? v.replace(/,/g, '') : v;
  }

  /* ---------- tokenizer ---------- */

  /**
   * Splits T-SQL into tokens: ws, comment, string, var (@x), sysvar (@@x), ident ([x] / "x"),
   * number, word, punct. Joining every token's text gives back the exact input.
   */
  function tokenize(src) {
    const s = String(src ?? '');
    const n = s.length;
    const tokens = [];
    let i = 0;
    while (i < n) {
      const start = i;
      const ch = s[i];
      const next = s[i + 1];
      let type = 'punct';
      let closed;
      if (/\s/.test(ch)) {
        while (i < n && /\s/.test(s[i])) i++;
        type = 'ws';
      } else if (ch === '-' && next === '-') {
        while (i < n && s[i] !== '\n') i++;
        type = 'comment';
      } else if (ch === '/' && next === '*') {
        const end = s.indexOf('*/', i + 2);
        i = end === -1 ? n : end + 2;
        type = 'comment';
      } else if (ch === "'" || ((ch === 'N' || ch === 'n') && next === "'")) {
        i += ch === "'" ? 1 : 2;
        closed = false;
        while (i < n) {
          if (s[i] === "'") {
            if (s[i + 1] === "'") { i += 2; continue; }
            i++;
            closed = true;
            break;
          }
          i++;
        }
        type = 'string';
      } else if (ch === '@' && next === '@') {
        i += 2;
        while (i < n && WORD_CHAR.test(s[i])) i++;
        type = 'sysvar';
      } else if (ch === '@' && next !== undefined && WORD_CHAR.test(next)) {
        i++;
        while (i < n && WORD_CHAR.test(s[i])) i++;
        type = 'var';
      } else if (ch === '[' || ch === '"') {
        const close = ch === '[' ? ']' : '"';
        i++;
        while (i < n) {
          if (s[i] === close) {
            if (s[i + 1] === close) { i += 2; continue; }
            i++;
            break;
          }
          i++;
        }
        type = 'ident';
      } else if (/\d/.test(ch) || (ch === '.' && next !== undefined && /\d/.test(next))) {
        i++;
        while (i < n && /[\d.]/.test(s[i])) i++;
        type = 'number';
      } else if (WORD_START.test(ch)) {
        i++;
        while (i < n && WORD_CHAR.test(s[i])) i++;
        type = 'word';
      } else {
        i++;
      }
      const token = { type, text: s.slice(start, i) };
      if (type === 'string') token.closed = closed;
      tokens.push(token);
    }
    return tokens;
  }

  /* ---------- clipboard (Excel / Google Sheets) ---------- */

  // Spreadsheets wrap a cell in quotes when it holds tabs, newlines or quotes.
  // Returns null when the quote is just part of the value.
  function readQuotedCell(src, start) {
    let value = '';
    for (let j = start + 1; j < src.length; j++) {
      if (src[j] !== '"') { value += src[j]; continue; }
      if (src[j + 1] === '"') { value += '"'; j++; continue; }
      const after = src[j + 1];
      return after === undefined || after === '\t' || after === '\n' ? { value, end: j + 1 } : null;
    }
    return null;
  }

  /** Parses tab-separated text copied from a spreadsheet into rows of cells. */
  function parseTSV(text) {
    const src = String(text ?? '').replace(/\r\n?/g, '\n');
    const rows = [];
    let row = [];
    let cell = '';
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '"' && cell === '') {
        const quoted = readQuotedCell(src, i);
        if (quoted) {
          cell = quoted.value;
          i = quoted.end;
          continue;
        }
      }
      if (ch === '\t') {
        row.push(cell);
        cell = '';
      } else if (ch === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else {
        cell += ch;
      }
      i++;
    }
    row.push(cell);
    rows.push(row);
    // A copied block ends with a newline, which leaves an empty last line behind.
    while (rows.length > 1 && rows[rows.length - 1].every(v => v === '')) rows.pop();
    return rows;
  }

  /* ---------- Queryboard parsing ---------- */

  function trimTokens(tokens) {
    let a = 0;
    let b = tokens.length;
    while (a < b && !isCode(tokens[a])) a++;
    while (b > a && !isCode(tokens[b - 1])) b--;
    return tokens.slice(a, b);
  }

  function splitTopLevel(tokens, separator) {
    const parts = [[]];
    let depth = 0;
    for (const t of tokens) {
      if (isPunct(t, '(')) depth++;
      else if (isPunct(t, ')')) depth = Math.max(0, depth - 1);
      else if (depth === 0 && isPunct(t, separator)) { parts.push([]); continue; }
      parts[parts.length - 1].push(t);
    }
    return parts;
  }

  function firstWord(tokens) {
    const t = tokens.find(isCode);
    return t && t.type === 'word' ? t.text.toUpperCase() : '';
  }

  // Variables the query declares itself (DECLARE @x ...) are locals, not sheet params.
  function findDeclared(tokens) {
    const declared = new Set();
    let inDeclare = false;
    let expectName = false;
    let depth = 0;
    for (const t of tokens) {
      if (!isCode(t)) continue;
      const word = t.type === 'word' ? t.text.toUpperCase() : '';
      if (word === 'DECLARE') {
        inDeclare = true;
        expectName = true;
        depth = 0;
        continue;
      }
      if (!inDeclare) continue;
      if (isPunct(t, '(')) depth++;
      else if (isPunct(t, ')')) depth--;
      else if (depth === 0 && isPunct(t, ',')) { expectName = true; continue; }
      else if (isPunct(t, ';') || (depth === 0 && STATEMENT_WORDS.has(word))) { inDeclare = false; continue; }
      if (expectName && t.type === 'var') declared.add(t.text.slice(1).toLowerCase());
      expectName = false;
    }
    return declared;
  }

  /**
   * Cuts the token stream into statements: at top-level ';', before every EXEC,
   * and — inside an EXEC call — before any word that starts a new statement.
   */
  function splitStatements(tokens) {
    const chunks = [];
    let current = [];
    let depth = 0;
    let isExec = false;
    let hasCode = false;
    const flush = () => {
      if (current.length) chunks.push(current);
      current = [];
      isExec = false;
      hasCode = false;
    };
    for (const t of tokens) {
      const code = isCode(t);
      const word = t.type === 'word' ? t.text.toUpperCase() : '';
      const startsExec = word === 'EXEC' || word === 'EXECUTE';
      if (code && depth === 0 && hasCode && (startsExec || (isExec && STATEMENT_WORDS.has(word)))) flush();
      current.push(t);
      if (!code) continue;
      if (!hasCode) isExec = startsExec;
      hasCode = true;
      if (isPunct(t, '(')) depth++;
      else if (isPunct(t, ')')) depth = Math.max(0, depth - 1);
      else if (depth === 0 && isPunct(t, ';')) flush();
    }
    flush();
    return chunks;
  }

  // Text with every (non-declared) @variable turned into a { param } placeholder.
  function templateSegments(tokens, declared) {
    const segments = [];
    for (const t of tokens) {
      if (t.type === 'var' && !declared.has(t.text.slice(1).toLowerCase())) {
        segments.push({ param: t.text.slice(1) });
      } else if (typeof segments[segments.length - 1] === 'string') {
        segments[segments.length - 1] += t.text;
      } else {
        segments.push(t.text);
      }
    }
    return segments;
  }

  function unquote(token) {
    let body = token.text.replace(/^[Nn]/, '').slice(1);
    if (token.closed) body = body.slice(0, -1);
    return body.replace(/''/g, "'");
  }

  // The plain value of a literal argument (1, -2.5, 'text', N'text', NULL), else undefined.
  function literalOf(code) {
    if (code.length === 1) {
      const t = code[0];
      if (t.type === 'number') return t.text;
      if (t.type === 'string') return unquote(t);
      if (t.type === 'word' && RE.nullWord.test(t.text)) return 'NULL';
    }
    if (code.length === 2 && (isPunct(code[0], '-') || isPunct(code[0], '+')) && code[1].type === 'number') {
      return (code[0].text === '-' ? '-' : '') + code[1].text;
    }
    return undefined;
  }

  function parseArg(tokens, declared) {
    const code = tokens.filter(isCode);
    if (code[0].type === 'var' && isPunct(code[1], '=')) {
      const lhs = code[0].text.slice(1);
      const expr = trimTokens(tokens.slice(tokens.indexOf(code[1]) + 1));
      const exprCode = expr.filter(isCode);
      // "@qtype = 1" or a half-typed "@qtype =": the sheet column carries the value.
      const literal = exprCode.length ? literalOf(exprCode) : null;
      if (literal !== undefined) return { lhs, literal, segments: [`@${lhs} = `, { param: lhs }] };
      return { lhs, segments: [`@${lhs} = `, ...templateSegments(expr, declared)] };
    }
    return { lhs: null, segments: templateSegments(tokens, declared) };
  }

  function parseExecChunk(chunk, declared) {
    let i = chunk.findIndex(isCode);
    const prefix = textOf(chunk.slice(0, i));
    const execWord = chunk[i].text;
    i++;
    while (i < chunk.length && !isCode(chunk[i])) i++;
    let proc = '';
    while (i < chunk.length && (chunk[i].type === 'word' || chunk[i].type === 'ident')) {
      proc += chunk[i].text;
      i++;
      if (!isPunct(chunk[i], '.')) break;
      proc += '.';
      i++;
    }
    const rest = chunk.slice(i);
    let end = rest.length;
    while (end > 0 && (!isCode(rest[end - 1]) || isPunct(rest[end - 1], ';'))) end--;
    const argTokens = rest.slice(0, end);
    // EXEC @ret = proc / EXEC('dynamic sql') — leave those as plain SQL.
    if (!proc && argTokens.some(isCode)) return null;
    const args = splitTopLevel(argTokens, ',')
      .map(trimTokens)
      .filter(arg => arg.length)
      .map(arg => parseArg(arg, declared));
    return { kind: 'exec', prefix, execWord, proc, args, suffix: textOf(rest.slice(end)) };
  }

  // "re.nsp_customerledger" or "nsp_customerledger" typed on its own means EXEC that procedure.
  function bareProcName(chunk) {
    const code = chunk.filter(isCode);
    if (isPunct(code[code.length - 1], ';')) code.pop();
    if (!code.length || code.length % 2 === 0) return null;
    for (let k = 0; k < code.length; k++) {
      const ok = k % 2 === 0 ? code[k].type === 'word' || code[k].type === 'ident' : isPunct(code[k], '.');
      if (!ok) return null;
    }
    const last = code[code.length - 1].text.replace(/^\[|\]$/g, '');
    if (code.length === 1 && (STATEMENT_WORDS.has(code[0].text.toUpperCase()) || !RE.procPrefix.test(last))) return null;
    return textOf(code);
  }

  function statementParams(statement) {
    return statement.kind === 'exec' ? statement.args.flatMap(a => a.segments) : statement.segments;
  }

  /**
   * Reads the Queryboard.
   * kind: 'empty' | 'exec' (a single EXEC call) | 'template' (any other SQL, or several statements)
   * params: the @params in order of appearance; EXEC arguments written as "@p = <literal>"
   *         also carry `literal` (null while the value is still being typed).
   */
  function parseQuery(text) {
    const tokens = tokenize(text);
    const declared = findDeclared(tokens);
    const chunks = splitStatements(tokens);
    const codeChunks = chunks.filter(ch => ch.some(isCode));
    if (!codeChunks.length) return { kind: 'empty', verb: '', statements: [], params: [], argNames: [], declared: [...declared] };

    let statements = chunks.map(ch => {
      const word = firstWord(ch);
      const exec = word === 'EXEC' || word === 'EXECUTE' ? parseExecChunk(ch, declared) : null;
      return exec || { kind: 'template', segments: templateSegments(ch, declared) };
    });

    const codeStatements = statements.filter((_, k) => chunks[k].some(isCode));
    if (codeStatements.length === 1 && codeStatements[0].kind === 'template') {
      const proc = bareProcName(codeChunks[0]);
      if (proc) statements = [{ kind: 'exec', prefix: '', execWord: null, proc, args: [], suffix: '' }];
    }

    const singleExec = codeStatements.length === 1 && statements.some(s => s.kind === 'exec');
    const kind = singleExec ? 'exec' : 'template';
    const verb = singleExec ? 'EXEC' : codeStatements.length > 1 ? 'SCRIPT' : firstWord(codeChunks[0]) || 'SQL';

    const literals = new Map();
    const argNames = [];
    statements.filter(s => s.kind === 'exec').forEach(s => s.args.forEach(a => {
      if (!a.lhs) return;
      argNames.push(a.lhs);
      if (a.literal !== undefined && !literals.has(a.lhs.toLowerCase())) literals.set(a.lhs.toLowerCase(), a.literal);
    }));

    const params = [];
    statements.flatMap(statementParams).forEach(seg => {
      if (typeof seg === 'string' || params.some(p => sameName(p.name, seg.param))) return;
      const param = { name: seg.param };
      if (literals.has(seg.param.toLowerCase())) param.literal = literals.get(seg.param.toLowerCase());
      params.push(param);
    });

    return { kind, verb, statements, params, argNames, declared: [...declared] };
  }

  /** True when the query mentions @name anywhere (as a placeholder or an EXEC parameter name). */
  function queryUsesParam(query, name) {
    return tokenize(query).some(t => t.type === 'var' && sameName(t.text.slice(1), name));
  }

  /** Renames every @from in the query to @to, leaving strings and comments alone. */
  function renameParam(query, from, to) {
    return tokenize(query)
      .map(t => (t.type === 'var' && sameName(t.text.slice(1), from) ? '@' + to : t.text))
      .join('');
  }

  /* ---------- Queryboard → sheet ---------- */

  const blankColumn = () => ({ name: '', type: 'AUTO', auto: false, seed: null });

  /**
   * Keeps sheet columns in step with the Queryboard's @params as the user types.
   *  - a new @param takes the first free column (named by the Queryboard: `auto`),
   *  - a @param being retyped renames its column instead of making a new one,
   *  - an auto column whose @param disappeared is freed again if it holds no real data,
   *  - "@p = <literal>" in an EXEC writes the literal into row 1 (unless the user typed something else there).
   * Mutates `columns` and `rows`. Returns the indexes of columns that changed and any @params that didn't fit.
   */
  function syncColumns(columns, rows, prevParams, nextParams) {
    const key = s => cleanParamName(s).toLowerCase();
    const find = name => columns.findIndex(c => key(c.name) === key(name));
    const listed = (list, name) => list.some(p => key(p.name) === key(name));
    const isFree = i => !key(columns[i].name) && rows.every(r => isBlank(r[i]));
    const changed = new Set();
    const overflow = [];

    nextParams.forEach((p, i) => {
      if (find(p.name) !== -1) return;
      const old = prevParams[i];
      const from = old && !listed(nextParams, old.name) ? find(old.name) : -1;
      if (from !== -1 && columns[from].auto) {
        columns[from].name = p.name;
        changed.add(from);
        return;
      }
      const free = columns.findIndex((_, j) => isFree(j));
      if (free === -1) {
        overflow.push(p.name);
        return;
      }
      columns[free] = { name: p.name, type: 'AUTO', auto: true, seed: null };
      changed.add(free);
    });

    prevParams.forEach(p => {
      if (listed(nextParams, p.name)) return;
      const idx = find(p.name);
      if (idx === -1 || !columns[idx].auto) return;
      const seed = columns[idx].seed;
      const onlySeed = rows.every((r, ri) => isBlank(r[idx]) || (ri === 0 && seed !== null && r[idx] === seed));
      if (!onlySeed) return;
      rows.forEach(r => { r[idx] = ''; });
      columns[idx] = blankColumn();
      changed.add(idx);
    });

    if (rows.length) {
      nextParams.forEach(p => {
        if (!('literal' in p)) return;
        const idx = find(p.name);
        if (idx === -1) return;
        const col = columns[idx];
        const literal = p.literal ?? '';
        const prevSeed = col.seed ?? '';
        if (literal === prevSeed) return;
        const current = rows[0][idx] ?? '';
        if (current !== '' && current !== prevSeed) return; // the user's own value wins
        rows[0][idx] = literal;
        col.seed = literal === '' ? null : literal;
        changed.add(idx);
      });
    }

    return { changed: [...changed], overflow };
  }

  /* ---------- values ---------- */

  /** Best-guess SQL type for a column from its (trimmed, non-blank, non-NULL) values. */
  function inferType(values) {
    if (!values.length) return 'VARCHAR';
    const nums = values.map(normalizeNumber);
    const noLeadingZeros = !values.some(v => RE.leadingZero.test(v)); // "007" is a code, not a number
    if (noLeadingZeros && nums.every(v => RE.int.test(v))) {
      return nums.every(v => Math.abs(Number(v)) <= INT_MAX) ? 'INT' : 'BIGINT';
    }
    if (noLeadingZeros && nums.every(v => RE.dec.test(v))) return 'DECIMAL';
    if (values.every(v => RE.guid.test(v))) return 'UNIQUEIDENTIFIER';
    if (values.every(v => RE.date.test(v))) return values.some(v => RE.time.test(v)) ? 'DATETIME' : 'DATE';
    if (values.every(v => RE.boolWord.test(v))) return 'BIT';
    return values.some(v => RE.nonAscii.test(v)) ? 'NVARCHAR' : 'VARCHAR';
  }

  /**
   * Turns one cell into a SQL literal for the given type.
   * Returns { sql, valid }; an invalid value is still emitted, but quoted, so it can't break the script.
   */
  function formatValue(raw, type, ctx) {
    const text = String(raw ?? '');
    const v = text.trim();
    const str = ctx.trim ? v : text;
    const ok = sql => ({ sql, valid: true });
    const bad = () => ({ sql: quote(v), valid: false });

    if (str === '' || v === '') {
      const keepEmpty = !ctx.blankAsNull && (type === 'VARCHAR' || type === 'NVARCHAR');
      if (!keepEmpty) return ok(ctx.kw('NULL'));
      return ok((type === 'NVARCHAR' ? 'N' : '') + quote(str));
    }
    if (RE.nullWord.test(v)) return ok(ctx.kw('NULL'));

    switch (type) {
      case 'INT':
      case 'BIGINT': {
        const n = normalizeNumber(v);
        return RE.int.test(n) ? ok(n.replace(/^\+/, '')) : bad();
      }
      case 'DECIMAL': {
        const n = normalizeNumber(v);
        return RE.dec.test(n) ? ok(n.replace(/^\+/, '')) : bad();
      }
      case 'BIT':
        if (/^(1|true|yes|y|t)$/i.test(v)) return ok('1');
        if (/^(0|false|no|n|f)$/i.test(v)) return ok('0');
        return bad();
      case 'DATE':
      case 'DATETIME':
        return RE.date.test(v) || !Number.isNaN(Date.parse(v)) ? ok(quote(v)) : bad();
      case 'UNIQUEIDENTIFIER':
        return RE.guid.test(v) ? ok(quote(v)) : bad();
      case 'NVARCHAR':
        return ok('N' + quote(str));
      default:
        return ok(quote(str));
    }
  }

  // Column/variable type for the loop's @tbl and DECLAREs, sized from the data.
  function declareType(type, values, kw) {
    switch (type) {
      case 'DECIMAL': {
        let intDigits = 1;
        let scale = 0;
        for (const v of values) {
          const n = normalizeNumber(v.trim()).replace(/^[-+]/, '');
          if (!RE.dec.test(n)) continue;
          const [whole, frac = ''] = n.split('.');
          intDigits = Math.max(intDigits, whole.replace(/^0+(?=\d)/, '').length);
          scale = Math.max(scale, frac.length);
        }
        scale = Math.min(Math.max(scale, 2), 38);
        const precision = Math.min(38, Math.max(18, intDigits + scale));
        return `${kw('DECIMAL')}(${precision}, ${Math.min(scale, precision)})`;
      }
      case 'VARCHAR':
      case 'NVARCHAR': {
        const longest = values.reduce((m, v) => Math.max(m, v.length), 0);
        const cap = type === 'VARCHAR' ? 8000 : 4000;
        const size = [50, 100, 255, 500, 1000, 4000, 8000].find(n => n >= longest && n <= cap);
        return `${kw(type)}(${size || kw('MAX')})`;
      }
      default:
        return kw(type);
    }
  }

  function columnIdent(name) {
    return RE.ident.test(name) && !RESERVED.has(name.toUpperCase()) ? name : `[${name.replace(/]/g, ']]')}]`;
  }

  function pickName(base, taken) {
    let name = base;
    for (let i = 1; taken.has(name.toLowerCase()); i++) name = `${base}_${i}`;
    taken.add(name.toLowerCase());
    return name;
  }

  /* ---------- SQL output ---------- */

  function renderSegments(segments, valueOf) {
    return segments.map(s => (typeof s === 'string' ? s : valueOf(s.param))).join('');
  }

  // Trim and close the statement with ';' — unless a trailing comment or GO would swallow it.
  function finishStatement(text) {
    const s = text.trim();
    if (!s || s.endsWith(';')) return s;
    const lastLine = s.slice(s.lastIndexOf('\n') + 1);
    if (RE.goLine.test(lastLine) || tokenize(lastLine).some(t => t.type === 'comment')) return s;
    return s + ';';
  }

  function statementSegments(q, extraArgs, kw) {
    const out = [];
    q.statements.forEach(st => {
      if (st.kind !== 'exec') {
        out.push(...st.segments);
        return;
      }
      const args = st.args.map(a => a.segments).concat(extraArgs.map(name => [`@${name} = `, { param: name }]));
      out.push(st.prefix, `${st.execWord || kw('EXEC')} ${st.proc}`);
      args.forEach((a, i) => out.push(i ? ', ' : ' ', ...a));
      out.push(st.suffix);
    });
    return out;
  }

  function buildDirect(segments, rowValues) {
    const statements = rowValues.map(vals =>
      finishStatement(renderSegments(segments, name => vals.get(name.toLowerCase()) ?? '@' + name)));
    return statements.join(statements.some(s => s.includes('\n')) ? '\n\n' : '\n');
  }

  // BEGIN TRAN up top, then COMMIT or ROLLBACK at the end depending on the flag.
  function tranWrap(flag, kw) {
    return {
      head: [`${kw('BEGIN TRAN')};`, `${kw('DECLARE')} ${flag} ${kw('INT')} = 0;`, ''],
      tail: ['', `${kw('IF')} ${flag} = 1`, `    ${kw('COMMIT TRAN')};`, kw('ELSE'), `    ${kw('ROLLBACK TRAN')};`],
    };
  }

  function buildLoop({ segments, bound, rowValues, columns, reserved, kw, tran }) {
    const taken = new Set([...bound.map(p => p.name.toLowerCase()), ...reserved]);
    const tbl = '@' + pickName('tbl', taken);
    const rowNo = pickName('row_no', taken);
    const min = '@' + pickName('min', taken);
    const max = '@' + pickName('max', taken);
    const ind = '    ';
    const cols = bound.map(p => columnIdent(p.name));
    const types = bound.map(p => declareType(p.type, columns[p.column].values, kw));
    const lines = [];

    lines.push(`${kw('SET NOCOUNT ON')};`, '', ...tran.head);
    lines.push(`${kw('DECLARE')} ${tbl} ${kw('TABLE')} (`);
    lines.push(`${ind}${rowNo} ${kw('INT IDENTITY')}(1, 1) ${kw('PRIMARY KEY')},`);
    bound.forEach((_, j) => lines.push(`${ind}${cols[j]} ${types[j]}${j < bound.length - 1 ? ',' : ''}`));
    lines.push(');', '');

    for (let i = 0; i < rowValues.length; i += INSERT_BATCH) {
      const chunk = rowValues.slice(i, i + INSERT_BATCH);
      lines.push(`${kw('INSERT INTO')} ${tbl} (${cols.join(', ')})`, kw('VALUES'));
      chunk.forEach((vals, j) => {
        const tuple = bound.map(p => vals.get(p.name.toLowerCase())).join(', ');
        lines.push(`${ind}(${tuple})${j < chunk.length - 1 ? ',' : ';'}`);
      });
      lines.push('');
    }

    const decls = [`${min} ${kw('INT')}`, `${max} ${kw('INT')}`, ...bound.map((p, j) => `@${p.name} ${types[j]}`)];
    lines.push(`${kw('DECLARE')} ${decls.join(',\n        ')};`, '');
    lines.push(`${kw('SELECT')} ${min} = ${kw('MIN')}(${rowNo}), ${max} = ${kw('MAX')}(${rowNo}) ${kw('FROM')} ${tbl};`, '');
    lines.push(`${kw('WHILE')} ${min} <= ${max}`, kw('BEGIN'));
    lines.push(`${ind}${kw('SELECT')} ${bound.map((p, j) => `@${p.name} = ${cols[j]}`).join(`,\n${ind}       `)}`);
    lines.push(`${ind}${kw('FROM')} ${tbl}`, `${ind}${kw('WHERE')} ${rowNo} = ${min};`, '');
    finishStatement(renderSegments(segments, name => '@' + name))
      .split('\n')
      .forEach(line => lines.push(line ? ind + line : ''));
    lines.push('', `${ind}${kw('SET')} ${min} = ${min} + 1;`, kw('END'), ...tran.tail);
    return lines.join('\n');
  }

  /**
   * Builds the final SQL.
   * input: { query, columns: [{ name, type }], rows: string[][], mode: 'direct' | 'loop',
   *          options: { blankAsNull, trim, lowercase, tran } }
   */
  function build(input = {}) {
    const opts = { blankAsNull: true, trim: true, lowercase: false, tran: false, ...(input.options || {}) };
    const kw = s => (opts.lowercase ? s.toLowerCase() : s);
    const ctx = { trim: opts.trim, blankAsNull: opts.blankAsNull, kw };
    const rows = input.rows || [];
    const cellText = (r, c) => String((rows[r] || [])[c] ?? '');
    const warnings = [];
    const warn = text => warnings.push({ level: 'warn', text });
    const note = text => warnings.push({ level: 'info', text });
    const q = parseQuery(input.query);

    const columns = (input.columns || []).map((col, index) => {
      const name = cleanParamName(col && col.name);
      const type = TYPES.includes(col && col.type) ? col.type : 'AUTO';
      const values = [];
      let hasData = false;
      rows.forEach((_, r) => {
        const v = cellText(r, index);
        if (isBlank(v)) return;
        hasData = true;
        if (!isNullWord(v)) values.push(opts.trim ? v.trim() : v);
      });
      const resolved = type === 'AUTO' ? inferType(values.map(v => v.trim())) : type;
      return { index, name, type, resolved, values, hasData };
    });

    const byName = new Map();
    columns.forEach(c => {
      if (!c.name) {
        if (c.hasData) warn(`Column ${letter(c.index)} has data but no name, so it's skipped.`);
        return;
      }
      const k = c.name.toLowerCase();
      if (byName.has(k)) {
        warn(`Columns ${letter(byName.get(k).index)} and ${letter(c.index)} are both named ${c.name}; only ${letter(byName.get(k).index)} is used.`);
        return;
      }
      byName.set(k, c);
      if (!isValidName(c.name)) warn(`"${c.name}" (column ${letter(c.index)}) isn't a valid parameter name.`);
    });

    // A single EXEC also takes every named sheet column it doesn't mention yet.
    let fromSheet = [];
    if (q.kind === 'exec') {
      const mentioned = new Set([...q.params.map(p => p.name), ...q.argNames].map(n => n.toLowerCase()));
      fromSheet = [...byName.values()].filter(c => !mentioned.has(c.name.toLowerCase())).map(c => c.name);
      const seen = new Set();
      q.argNames.forEach(n => {
        if (seen.has(n.toLowerCase())) warn(`@${n} is passed more than once.`);
        seen.add(n.toLowerCase());
      });
    }
    const segments = statementSegments(q, fromSheet, kw);

    const params = [...q.params.map(p => p.name), ...fromSheet].map(name => {
      const col = byName.get(name.toLowerCase()) || null;
      return { name, column: col ? col.index : null, type: col ? col.resolved : null, fromSheet: fromSheet.includes(name) };
    });
    params.filter(p => p.column === null).forEach(p => warn(`@${p.name} has no column in the sheet.`));
    if (q.kind === 'template') {
      [...byName.values()]
        .filter(c => !params.some(p => p.column === c.index))
        .forEach(c => note(`Column ${letter(c.index)} (${c.name}) isn't used by the query.`));
    }

    const bound = params.filter(p => p.column !== null);
    const dataRows = [];
    rows.forEach((_, r) => {
      if (bound.some(p => !isBlank(cellText(r, p.column)))) dataRows.push(r);
    });

    const invalid = [];
    const rowValues = dataRows.map(r => {
      const vals = new Map();
      bound.forEach(p => {
        const res = formatValue(cellText(r, p.column), p.type, ctx);
        if (!res.valid) invalid.push({ row: r, col: p.column, type: p.type });
        vals.set(p.name.toLowerCase(), res.sql);
      });
      return vals;
    });
    if (invalid.length) {
      warn(`${plural(invalid.length, 'cell')} ${invalid.length === 1 ? "doesn't" : "don't"} match the column type (marked red in the sheet).`);
    }

    const flag = opts.tran ? '@' + pickName('iscommit', new Set([...params.map(p => p.name.toLowerCase()), ...q.declared])) : '';
    const tran = opts.tran ? tranWrap(flag, kw) : { head: [], tail: [] };
    const wrap = body => [...tran.head, body, ...tran.tail].join('\n');

    let sql;
    if (q.kind === 'empty') {
      sql = '-- Type a query or a procedure name in the Queryboard.';
    } else if (q.kind === 'exec' && !q.statements.find(s => s.kind === 'exec').proc) {
      sql = '-- Type the procedure name after EXEC.';
    } else if (!params.length) {
      sql = wrap(finishStatement(renderSegments(segments, name => '@' + name)));
    } else if (!dataRows.length) {
      sql = `-- Fill the sheet to generate: ${params.map(p => '@' + p.name).join(', ')}`;
    } else if (input.mode === 'loop') {
      sql = buildLoop({ segments, bound, rowValues, columns, reserved: [...q.declared, flag.slice(1)], kw, tran });
    } else {
      sql = wrap(buildDirect(segments, rowValues));
    }
    if (opts.tran && sql.split('\n').some(line => RE.goLine.test(line))) {
      warn(`GO ends the batch, so ${flag} no longer exists after it. Remove GO or turn off BEGIN TRAN.`);
    }

    return {
      sql,
      kind: q.kind,
      verb: q.verb,
      rowCount: params.length ? dataRows.length : 0,
      params,
      warnings,
      invalid,
      columns: columns.map(c => ({
        index: c.index,
        name: c.name,
        type: c.type,
        resolved: c.resolved,
        valueCount: c.values.length,
        used: params.some(p => p.column === c.index),
      })),
    };
  }

  return {
    TYPES,
    tokenize,
    parseTSV,
    parseQuery,
    queryUsesParam,
    renameParam,
    syncColumns,
    inferType,
    formatValue,
    cleanParamName,
    isValidName,
    build,
  };
});
