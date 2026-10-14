const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('../vendor/xlsx.full.min.js');
const I = require('../js/importer.js');

// A workbook the way people actually format one in Excel.
function ledgerWorkbook({ date1904 = false } = {}) {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Transaction No.', 'Customer Name', 'Amount', 'Txn Date', 'Posted At', 'Active', 'Branch', 'Account'],
    ['DOC-0001', 'Ñiño', 1250.5, new Date(Date.UTC(2026, 9, 13)), new Date(Date.UTC(2026, 9, 13, 8, 30)), true, 7, 123456789012],
    ['007', "O'Neil", 0.1 + 0.2, new Date(Date.UTC(2026, 0, 2)), new Date(Date.UTC(2026, 0, 2, 17, 5, 9)), false, 12, 9],
  ], { cellDates: true, UTC: true, date1904 });
  const formats = { C2: '"₱"#,##0.00', D2: 'm/d/yy', D3: 'm/d/yy', E2: 'm/d/yy h:mm', E3: 'm/d/yy h:mm:ss', G2: '0000', G3: '0000' };
  Object.entries(formats).forEach(([addr, z]) => { ws[addr].z = z; });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Ledger');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[], ['', 'docno'], ['', 'D-1']]), 'Offset');
  if (date1904) wb.Workbook = { WBProps: { date1904: true } };
  return wb;
}

const expectedLedger = [
  ['Transaction No.', 'Customer Name', 'Amount', 'Txn Date', 'Posted At', 'Active', 'Branch', 'Account'],
  ['DOC-0001', 'Ñiño', '1250.5', '2026-10-13', '2026-10-13 08:30', 'TRUE', '0007', '123456789012'],
  ['007', "O'Neil", '0.3', '2026-01-02', '2026-01-02 17:05:09', 'FALSE', '0012', '9'],
];

for (const bookType of ['xlsx', 'xls']) {
  test(`${bookType}: cells come in as the values, not the display text`, () => {
    const bytes = new Uint8Array(XLSX.write(ledgerWorkbook(), { type: 'array', bookType }));
    const sheets = I.workbookSheets(XLSX, bytes);
    assert.deepEqual(sheets.map(s => s.name), ['Ledger', 'Offset']);
    assert.deepEqual(sheets[0].grid, expectedLedger);
    assert.deepEqual(sheets[1].grid, [['docno'], ['D-1']], 'empty leading rows and columns are dropped');
  });
}

test('1904-based workbooks (old Mac Excel) give the same dates', () => {
  const bytes = new Uint8Array(XLSX.write(ledgerWorkbook({ date1904: true }), { type: 'array', bookType: 'xlsx' }));
  assert.deepEqual(I.workbookSheets(XLSX, bytes)[0].grid[1].slice(3, 5), ['2026-10-13', '2026-10-13 08:30']);
});

test('a row limit cuts the sheet and says so', () => {
  const ws = XLSX.utils.aoa_to_sheet([['id'], ...Array.from({ length: 50 }, (_, i) => [i + 1])]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Ids');
  const [sheet] = I.workbookSheets(XLSX, new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })), { maxRows: 11 });
  assert.equal(sheet.grid.length, 11);
  assert.equal(sheet.truncated, true);
});

test('CSV: delimiter, quotes, encodings', () => {
  const [comma] = I.textSheets('name,amount\r\n"Doe, John","1,250.50"\r\n\r\n', 'a.csv');
  assert.deepEqual(comma.grid, [['name', 'amount'], ['Doe, John', '1,250.50']]);
  assert.deepEqual(I.textSheets('a;b\n1;2', 'eu.csv')[0].grid, [['a', 'b'], ['1', '2']]);
  assert.deepEqual(I.textSheets('a,b\tc', 'x.tsv')[0].grid, [['a,b', 'c']]);

  assert.equal(I.decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0xc3, 0x91])), 'Ñ', 'UTF-8 with BOM');
  assert.equal(I.decodeText(new Uint8Array([0xd1, 0x69, 0xf1, 0x6f])), 'Ñiño', 'Windows-1252 from a plain Excel CSV');
  assert.equal(I.decodeText(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0xd1, 0x00])), 'AÑ', 'UTF-16 from Excel "Unicode Text"');
});

test('JSON: array of objects, with nulls, missing keys and nested values', () => {
  const json = JSON.stringify([
    { docno: 'D-1', amount: 1250.5, active: true, note: null, tags: ['a', 'b'] },
    { docno: 'D-2', amount: 0.1 + 0.2, extra: { x: 1 } },
  ]);
  const [sheet] = I.jsonSheets(json, 'rows.json');
  assert.equal(sheet.hasHeader, true);
  assert.deepEqual(sheet.grid, [
    ['docno', 'amount', 'active', 'note', 'tags', 'extra'],
    ['D-1', '1250.5', 'TRUE', 'NULL', '["a","b"]', ''],
    ['D-2', '0.3', '', '', '', '{"x":1}'],
  ]);
});

test('JSON: every array inside an object is a sheet; arrays of arrays and JSON Lines work too', () => {
  const sheets = I.jsonSheets(JSON.stringify({ total: 2, data: [{ id: 1 }], result: { items: [{ id: 2 }] } }), 'api.json');
  assert.deepEqual(sheets.map(s => s.name), ['data', 'result.items']);
  assert.deepEqual(sheets[1].grid, [['id'], ['2']]);

  const [rows] = I.jsonSheets('[["docno","amount"],["D-1",5]]', 'grid.json');
  assert.deepEqual(rows.grid, [['docno', 'amount'], ['D-1', '5']]);
  assert.equal(rows.hasHeader, null, 'arrays of arrays fall back to header detection');

  assert.deepEqual(I.jsonSheets('{"id":1}\n{"id":2}\n', 'log.jsonl')[0].grid, [['id'], ['1'], ['2']]);
  assert.deepEqual(I.jsonSheets('{"id":7,"name":"x"}', 'one.json')[0].grid, [['id', 'name'], ['7', 'x']]);
  assert.throws(() => I.jsonSheets('{oops', 'bad.json'), /isn't valid JSON/);
});

test('header detection', () => {
  assert.equal(I.looksLikeHeader([['docno', 'amount'], ['D-1', '5']]), true);
  assert.equal(I.looksLikeHeader([['D-1', '5'], ['D-2', '6']]), false, 'a number in row 1 means data');
  assert.equal(I.looksLikeHeader([['2026-10-13', 'x']]), false);
  assert.equal(I.looksLikeHeader([['a', 'A']]), false, 'repeated names');
});

test('mapping: same name first, then the same letters ignoring case and spacing', () => {
  const names = ['Transaction_No', 'Customer_Name', 'docno'];
  assert.deepEqual(I.suggestMapping(names, ['docno', 'transactionno', 'customer', 'customername']), [2, 0, -1, 1]);
});

test('buildSheet: names from the header, mapped @params win, rows squared off', () => {
  const grid = [['Transaction No.', 'docno', 'Amount'], ['D-1', 'x', '5'], ['D-2']];
  const sheet = I.buildSheet(grid, { hasHeader: true, rename: { 0: 'docno' }, minColumns: 4 });
  assert.deepEqual(sheet.columns.map(c => c.name), ['docno', 'docno_2', 'Amount', '']);
  assert.deepEqual(sheet.rows, [['D-1', 'x', '5', ''], ['D-2', '', '', '']]);

  const capped = I.buildSheet([['a', 'b', 'c'], ['1', '2', '3']], { hasHeader: false, maxColumns: 2, maxRows: 1 });
  assert.deepEqual(capped.columns.map(c => c.name), ['', '']);
  assert.deepEqual(capped.rows, [['a', 'b']]);
  assert.equal(capped.truncatedColumns, 1);
});
