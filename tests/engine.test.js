const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../js/engine.js');

const COLS = 10;
const blankRow = () => Array(COLS).fill('');

function sheet(columnDefs = [], data = [], rowCount = 20) {
  const columns = Array.from({ length: COLS }, (_, i) => {
    const [name = '', type = 'AUTO'] = columnDefs[i] || [];
    return { name, type, auto: false, seed: null };
  });
  const rows = Array.from({ length: Math.max(rowCount, data.length) }, (_, r) => {
    const row = blankRow();
    (data[r] || []).forEach((v, c) => { row[c] = v; });
    return row;
  });
  return { columns, rows };
}

// Feeds the Queryboard text one character at a time, like a user typing it.
function typeQuery(text, state) {
  let prev = [];
  for (let i = 1; i <= text.length; i++) {
    const next = E.parseQuery(text.slice(0, i)).params;
    E.syncColumns(state.columns, state.rows, prev, next);
    prev = next;
  }
  return prev;
}

test('reference example: one EXEC per row', () => {
  const { columns, rows } = sheet([['querytype', 'INT'], ['customername', 'VARCHAR']], [['1', 'rene'], ['1', 'norman']]);
  const { sql } = E.build({ query: 're.nsp_customerledger_details', columns, rows, mode: 'direct' });
  assert.equal(sql, [
    "EXEC re.nsp_customerledger_details @querytype = 1, @customername = 'rene';",
    "EXEC re.nsp_customerledger_details @querytype = 1, @customername = 'norman';",
  ].join('\n'));
});

test('typing a DELETE names the first column after its @param', () => {
  const state = sheet();
  typeQuery('delete from re.customerledger where transactionno = @docno', state);
  assert.equal(state.columns[0].name, 'docno');
  assert.equal(state.columns[0].auto, true);
  assert.ok(state.columns.slice(1).every(c => c.name === ''), 'no leftover columns from half-typed names');

  state.rows[0][0] = 'DOC-001';
  state.rows[1][0] = 'DOC-002';
  const { sql } = E.build({ query: 'delete from re.customerledger where transactionno = @docno', ...state, mode: 'direct' });
  assert.equal(sql, [
    "delete from re.customerledger where transactionno = 'DOC-001';",
    "delete from re.customerledger where transactionno = 'DOC-002';",
  ].join('\n'));
});

test('typing an EXEC with a literal names the column and puts the value in row 1', () => {
  const state = sheet();
  const query = "exec re.nsp_customerledger @qtype = 12, @customername = 'rene'";
  typeQuery(query, state);
  assert.deepEqual(state.columns.slice(0, 2).map(c => c.name), ['qtype', 'customername']);
  assert.deepEqual(state.rows[0].slice(0, 2), ['12', 'rene']);
  assert.equal(state.columns[2].name, '');

  state.rows[1][0] = '12';
  state.rows[1][1] = "o'neil";
  const { sql } = E.build({ query, ...state, mode: 'direct' });
  assert.equal(sql, [
    "exec re.nsp_customerledger @qtype = 12, @customername = 'rene';",
    "exec re.nsp_customerledger @qtype = 12, @customername = 'o''neil';",
  ].join('\n'));
});

test("row-1 seeds never overwrite the user's own value", () => {
  const state = sheet();
  typeQuery('exec sp_x @qtype = 1', state);
  state.rows[0][0] = '5';
  const prev = E.parseQuery('exec sp_x @qtype = 1').params;
  E.syncColumns(state.columns, state.rows, prev, E.parseQuery('exec sp_x @qtype = 2').params);
  assert.equal(state.rows[0][0], '5');
});

test('erasing a @param frees its auto column, but keeps one that holds data', () => {
  const state = sheet();
  typeQuery('exec sp_x @a = 1, @b = 2', state);
  state.rows[1][1] = 'real data';
  E.syncColumns(state.columns, state.rows, E.parseQuery('exec sp_x @a = 1, @b = 2').params, []);
  assert.equal(state.columns[0].name, '');
  assert.equal(state.rows[0][0], '');
  assert.equal(state.columns[1].name, 'b');
});

test('sheet columns are added to a bare EXEC (paste-first flow)', () => {
  const { columns, rows } = sheet([['qtype'], ['amount'], ['code']], [['1', '1,250.50', '007']]);
  const result = E.build({ query: 'exec re.nsp_x @qtype = 1', columns, rows, mode: 'direct' });
  assert.equal(result.sql, "exec re.nsp_x @qtype = 1, @amount = 1250.50, @code = '007';");
  assert.deepEqual(result.params.map(p => [p.name, p.fromSheet]), [['qtype', false], ['amount', true], ['code', true]]);
});

test('loop mode: @tbl, WHILE @min <= @max, and the query inside', () => {
  const { columns, rows } = sheet([['querytype', 'INT'], ['customername', 'VARCHAR']], [['1', 'rene'], ['1', 'norman']]);
  const { sql } = E.build({ query: 'exec re.nsp_customerledger_details @querytype = 1, @customername', columns, rows, mode: 'loop' });
  assert.equal(sql, [
    'SET NOCOUNT ON;',
    '',
    'DECLARE @tbl TABLE (',
    '    row_no INT IDENTITY(1, 1) PRIMARY KEY,',
    '    querytype INT,',
    '    customername VARCHAR(50)',
    ');',
    '',
    'INSERT INTO @tbl (querytype, customername)',
    'VALUES',
    "    (1, 'rene'),",
    "    (1, 'norman');",
    '',
    'DECLARE @min INT,',
    '        @max INT,',
    '        @querytype INT,',
    '        @customername VARCHAR(50);',
    '',
    'SELECT @min = MIN(row_no), @max = MAX(row_no) FROM @tbl;',
    '',
    'WHILE @min <= @max',
    'BEGIN',
    '    SELECT @querytype = querytype,',
    '           @customername = customername',
    '    FROM @tbl',
    '    WHERE row_no = @min;',
    '',
    '    exec re.nsp_customerledger_details @querytype = @querytype, @customername;',
    '',
    '    SET @min = @min + 1;',
    'END',
  ].join('\n'));
});

test('loop helper names step aside for params called min / tbl / row_no', () => {
  const { columns, rows } = sheet([['min'], ['tbl'], ['row_no']], [['1', '2', '3']]);
  const { sql } = E.build({ query: 'select @min, @tbl, @row_no', columns, rows, mode: 'loop' });
  assert.match(sql, /DECLARE @tbl_1 TABLE/);
  assert.match(sql, /row_no_1 INT IDENTITY/);
  assert.match(sql, /WHILE @min_1 <= @max/);
});

test('loop splits INSERT every 1000 rows', () => {
  const data = Array.from({ length: 2500 }, (_, i) => [String(i + 1)]);
  const { columns, rows } = sheet([['id']], data);
  const { sql } = E.build({ query: 'delete from t where id = @id', columns, rows, mode: 'loop' });
  assert.equal(sql.match(/INSERT INTO @tbl/g).length, 3);
});

test('BEGIN TRAN wraps direct output: rollback unless @iscommit = 1', () => {
  const { columns, rows } = sheet([['docno']], [['D1'], ['D2']]);
  const { sql } = E.build({ query: 'delete from re.customerledger where transactionno = @docno', columns, rows, mode: 'direct', options: { tran: true } });
  assert.equal(sql, [
    'BEGIN TRAN;',
    'DECLARE @iscommit INT = 0;',
    '',
    "delete from re.customerledger where transactionno = 'D1';",
    "delete from re.customerledger where transactionno = 'D2';",
    '',
    'IF @iscommit = 1',
    '    COMMIT TRAN;',
    'ELSE',
    '    ROLLBACK TRAN;',
  ].join('\n'));
});

test('BEGIN TRAN in loop mode sits right after SET NOCOUNT ON and closes after END', () => {
  const { columns, rows } = sheet([['docno']], [['D1']]);
  const { sql } = E.build({ query: 'delete from t where id = @docno', columns, rows, mode: 'loop', options: { tran: true, lowercase: true } });
  assert.ok(sql.startsWith('set nocount on;\n\nbegin tran;\ndeclare @iscommit int = 0;\n\ndeclare @tbl table ('), sql);
  assert.ok(sql.endsWith('end\n\nif @iscommit = 1\n    commit tran;\nelse\n    rollback tran;'), sql);
});

test('BEGIN TRAN: the flag steps aside for an @iscommit param, hints stay unwrapped, GO is flagged', () => {
  const { columns, rows } = sheet([['iscommit']], [['1']]);
  assert.match(E.build({ query: 'exec sp_x @iscommit', columns, rows, options: { tran: true } }).sql, /DECLARE @iscommit_1 INT = 0;[\s\S]*IF @iscommit_1 = 1/);

  const empty = sheet();
  assert.equal(E.build({ query: 'delete from t where id = @id', ...empty, options: { tran: true } }).sql, '-- Fill the sheet to generate: @id');
  const once = E.build({ query: 'exec re.sp_x\nGO', ...empty, options: { tran: true } });
  assert.ok(once.sql.startsWith('BEGIN TRAN;'));
  assert.match(once.warnings.map(w => w.text).join(), /GO ends the batch/);
});

test('blank → NULL, the NULL word, N-strings, bits and bad values', () => {
  const { columns, rows } = sheet(
    [['a', 'VARCHAR'], ['b', 'NVARCHAR'], ['c', 'BIT'], ['d', 'INT']],
    [['', 'Ñiño', 'yes', 'abc'], ['null', 'x', '0', '']],
  );
  const result = E.build({ query: 'exec sp_x', columns, rows, mode: 'direct' });
  assert.equal(result.sql, [
    "exec sp_x @a = NULL, @b = N'Ñiño', @c = 1, @d = 'abc';",
    "exec sp_x @a = NULL, @b = N'x', @c = 0, @d = NULL;",
  ].join('\n'));
  assert.deepEqual(result.invalid, [{ row: 0, col: 3, type: 'INT' }]);

  const kept = E.build({ query: 'exec sp_x', columns, rows, mode: 'direct', options: { blankAsNull: false } });
  assert.match(kept.sql, /@a = '', @b = N'Ñiño'/);
});

test('auto type inference', () => {
  assert.equal(E.inferType(['1', '-20', '3,000']), 'INT');
  assert.equal(E.inferType(['3000000000']), 'BIGINT');
  assert.equal(E.inferType(['1.5', '2']), 'DECIMAL');
  assert.equal(E.inferType(['007', '010']), 'VARCHAR');
  assert.equal(E.inferType(['2026-10-13', '10/13/2026']), 'DATE');
  assert.equal(E.inferType(['2026-10-13 08:30']), 'DATETIME');
  assert.equal(E.inferType(['true', 'No']), 'BIT');
  assert.equal(E.inferType(['6f9619ff-8b86-d011-b42d-00c04fc964ff']), 'UNIQUEIDENTIFIER');
  assert.equal(E.inferType(['Ñiño']), 'NVARCHAR');
  assert.equal(E.inferType(['1,2,3']), 'VARCHAR');
});

test('parseQuery: kinds, verbs, declared locals and system variables', () => {
  assert.equal(E.parseQuery('').kind, 'empty');
  assert.equal(E.parseQuery('re.nsp_customerledger').verb, 'EXEC');
  assert.equal(E.parseQuery('nsp_customerledger').kind, 'exec');
  assert.equal(E.parseQuery('customer').kind, 'template');
  assert.equal(E.parseQuery('exec re.sp_restoreDB').kind, 'exec');
  assert.equal(E.parseQuery('UPDATE t SET a = @a WHERE id = @id').verb, 'UPDATE');
  assert.equal(E.parseQuery('exec a @x = 1; exec b @y = 2').verb, 'SCRIPT');

  const q = E.parseQuery("DECLARE @local INT = 1; SELECT * FROM t WHERE a = @a AND b = @local AND c = '@notparam' -- @nope\nAND d = @@ROWCOUNT");
  assert.deepEqual(q.params.map(p => p.name), ['a']);
});

test('EXEC named args: @p = @col binds the column, constants stay as written', () => {
  const { columns, rows } = sheet([['docno']], [['D1']]);
  const result = E.build({ query: 'exec sp_x @transactionno = @docno, @date = GETDATE()', columns, rows, mode: 'direct' });
  assert.equal(result.sql, "exec sp_x @transactionno = 'D1', @date = GETDATE();");
});

test('a statement without @params is generated once', () => {
  const { columns, rows } = sheet();
  assert.equal(E.build({ query: 'exec re.sp_restoreDB', columns, rows }).sql, 'exec re.sp_restoreDB;');
});

test('renameParam renames variables only', () => {
  const q = "exec sp_x @qtype = @qtype, @note = '@qtype' -- @qtype";
  assert.equal(E.renameParam(q, 'qtype', 'querytype'), "exec sp_x @querytype = @querytype, @note = '@qtype' -- @qtype");
});

test('parseTSV: quoted cells, CRLF and the trailing newline', () => {
  assert.deepEqual(E.parseTSV('a\tb\r\n1\t"multi\nline"\r\n'), [['a', 'b'], ['1', 'multi\nline']]);
  assert.deepEqual(E.parseTSV('"say ""hi"""\tx'), [['say "hi"', 'x']]);
  assert.deepEqual(E.parseTSV('"quoted" not\tx'), [['"quoted" not', 'x']]);
});

test('tokenize round-trips the input exactly', () => {
  const src = "exec re.x @a = N'it''s', @b = [col]] x] /* c */ -- end\n@@ROWCOUNT 1.5";
  assert.equal(E.tokenize(src).map(t => t.text).join(''), src);
});
