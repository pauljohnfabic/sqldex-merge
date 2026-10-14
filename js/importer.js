/**
 * SQLDex Merge importer — turns an uploaded .xlsx / .xls / .csv / .json file into sheet columns and rows.
 * Excel files are read with SheetJS (vendor/xlsx.full.min.js), which the page loads only when needed.
 * No DOM in here, so it runs in the browser (window.SqlDexImport) and in the Node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.SqlDexImport = factory(root.SqlDexEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const EXCEL_FILE = /\.(xlsx|xlsm|xlsb|xls|ods)$/i;
  const TEXT_FILE = /\.(csv|tsv|txt)$/i;
  const JSON_FILE = /\.(json|jsonl|ndjson)$/i;

  const isExcelFile = name => EXCEL_FILE.test(name);
  const isTextFile = name => TEXT_FILE.test(name);
  const isJsonFile = name => JSON_FILE.test(name);
  const isBlank = v => String(v ?? '').trim() === '';

  /** Decodes a text file: UTF-8 or UTF-16 (with or without a BOM), else Windows-1252 (Excel's plain "CSV"). */
  function decodeText(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      return new TextDecoder('windows-1252').decode(body);
    }
  }

  /* ---------- Excel cells → text ---------- */

  // Plain digits, without the float noise: 0.1 + 0.2 → "0.3", 1e-7 → "0.0000001".
  function numberText(v) {
    if (!Number.isFinite(v)) return String(v);
    const n = Number(v.toPrecision(15));
    const s = String(n);
    return /e/i.test(s) ? n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 }) : s;
  }

  // Dates become ISO text so SQL Server reads them the same way under any language setting.
  function dateText(SSF, serial, date1904) {
    const seconds = Math.round((serial - Math.floor(serial)) * 86400) % 86400;
    const opts = { date1904: !!date1904 };
    if (serial < 1 && seconds) return SSF.format('hh:mm:ss', serial, opts);
    if (!seconds) return SSF.format('yyyy-mm-dd', serial, opts);
    return SSF.format(seconds % 60 ? 'yyyy-mm-dd hh:mm:ss' : 'yyyy-mm-dd hh:mm', serial, opts);
  }

  /**
   * The text a cell should carry into the sheet. Numbers keep all their digits (Excel may *show*
   * 1.23457E+11 or ₱1,250.00), except zero-padded codes like 0007, which keep their padding.
   */
  function cellText(XLSX, cell, date1904) {
    if (!cell || cell.v === undefined || cell.v === null) return '';
    switch (cell.t) {
      case 's': return String(cell.v);
      case 'b': return cell.v ? 'TRUE' : 'FALSE';
      case 'e': return cell.w || '#ERROR';
      case 'd': return cell.v instanceof Date ? cell.v.toISOString().slice(0, 10) : String(cell.v);
      case 'n': {
        const fmt = typeof cell.z === 'string' ? cell.z : 'General';
        if (XLSX.SSF.is_date(fmt)) return dateText(XLSX.SSF, cell.v, date1904);
        if ((fmt === '@' || /^0+$/.test(fmt)) && cell.w) return cell.w;
        return numberText(cell.v);
      }
      default: return cell.w ?? String(cell.v);
    }
  }

  /* ---------- files → grids ---------- */

  // Drops empty rows and columns that are empty all the way down, and squares off the rest.
  function cleanGrid(grid) {
    const rows = grid.filter(row => row.some(v => !isBlank(v)));
    const width = rows.reduce((w, row) => Math.max(w, row.length), 0);
    const keep = [];
    for (let c = 0; c < width; c++) if (rows.some(row => !isBlank(row[c]))) keep.push(c);
    return rows.map(row => keep.map(c => String(row[c] ?? '')));
  }

  /** A CSV / TSV / TXT file as one sheet. */
  function textSheets(text, fileName, { maxRows = Infinity } = {}) {
    const delimiter = /\.tsv$/i.test(fileName) ? '\t' : E.detectDelimiter(text);
    const all = cleanGrid(E.parseDelimited(text, delimiter));
    return [{ name: fileName, grid: all.slice(0, maxRows), truncated: all.length > maxRows }];
  }

  /* ---------- JSON → grids ---------- */

  // null is an explicit NULL; nested objects and arrays stay JSON (for an SP that takes JSON text).
  function jsonText(v) {
    if (v === null) return 'NULL';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return numberText(v);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return JSON.stringify(v);
  }

  // An array of objects (their keys become the header row) or of arrays (rows already).
  function jsonGrid(list) {
    if (list.every(Array.isArray)) return { grid: list.map(row => row.map(jsonText)), hasHeader: null };
    const objects = list.map(item => (item && typeof item === 'object' && !Array.isArray(item) ? item : { value: item }));
    const keys = [...new Set(objects.flatMap(Object.keys))];
    return { grid: [keys, ...objects.map(o => keys.map(k => (k in o ? jsonText(o[k]) : '')))], hasHeader: true };
  }

  // Every array in the document, a few levels deep, named by its path ("data", "result.items").
  function findArrays(value, path, depth, out) {
    if (Array.isArray(value)) {
      if (value.length) out.push({ name: path, list: value });
      return out;
    }
    if (value && typeof value === 'object' && depth < 3) {
      Object.entries(value).forEach(([key, v]) => findArrays(v, path ? `${path}.${key}` : key, depth + 1, out));
    }
    return out;
  }

  /** A .json file (or JSON Lines) as sheets: the array itself, or each array inside an object. */
  function jsonSheets(text, fileName, { maxRows = Infinity } = {}) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      try {
        data = text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); // JSON Lines
      } catch {
        throw new Error(`it isn't valid JSON (${err.message})`);
      }
    }
    const found = Array.isArray(data) ? [{ name: fileName, list: data }] : findArrays(data, '', 0, []);
    if (!found.length) found.push({ name: fileName, list: [data] }); // a single record
    return found.map(({ name, list }) => {
      const { grid, hasHeader } = jsonGrid(list);
      const all = cleanGrid(grid);
      return { name, grid: all.slice(0, maxRows), truncated: all.length > maxRows, hasHeader };
    });
  }

  /** Every sheet of an Excel workbook. Each sheet's grid is built the first time it's asked for. */
  function workbookSheets(XLSX, bytes, { maxRows = 0 } = {}) {
    const wb = XLSX.read(bytes, { type: 'array', dense: true, cellNF: true, sheetRows: maxRows });
    const date1904 = !!(wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904);
    return wb.SheetNames.map(name => {
      const ws = wb.Sheets[name];
      let grid = null;
      return {
        name,
        truncated: !!ws['!fullref'] && ws['!fullref'] !== ws['!ref'],
        get grid() {
          if (!grid) {
            const data = ws['!data'] || [];
            grid = cleanGrid(Array.from(data, row => Array.from(row || [], cell => cellText(XLSX, cell, date1904))));
          }
          return grid;
        },
      };
    });
  }

  /* ---------- grids → sheet ---------- */

  /** Does the first row look like column names? (All text, no numbers or dates, no repeats.) */
  function looksLikeHeader(grid) {
    const filled = (grid[0] || []).map(v => v.trim()).filter(v => v !== '');
    if (!filled.length) return false;
    const textOnly = filled.every(v => v.length <= 128 && ['VARCHAR', 'NVARCHAR'].includes(E.inferType([v])));
    return textOnly && new Set(filled.map(v => v.toLowerCase())).size === filled.length;
  }

  /** Column names for a grid: from its first row, or blank when there's no header row. */
  function headerNames(grid, hasHeader) {
    const width = grid.reduce((w, row) => Math.max(w, row.length), 0);
    return hasHeader ? E.uniqueNames(Array.from({ length: width }, (_, c) => E.toParamName(grid[0][c]))) : Array(width).fill('');
  }

  const squash = s => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

  /**
   * Which file column should feed each Queryboard @param: the same name, or the same letters once
   * case, spaces and underscores are ignored ("Transaction No" → @transactionno). -1 when nothing fits.
   */
  function suggestMapping(names, paramNames) {
    const used = new Set();
    const pick = test => {
      const i = names.findIndex((n, j) => n && !used.has(j) && test(n));
      if (i !== -1) used.add(i);
      return i;
    };
    const exact = paramNames.map(p => pick(n => n.toLowerCase() === p.toLowerCase()));
    return exact.map((i, k) => (i !== -1 ? i : pick(n => squash(n) === squash(paramNames[k]))));
  }

  /**
   * Builds the sheet: { columns, rows, truncatedColumns }.
   * `rename` maps a column index to the @param name it should take (from the import mapping).
   */
  function buildSheet(grid, { hasHeader, rename = {}, minColumns = 0, maxColumns = Infinity, maxRows = Infinity }) {
    const names = headerNames(grid, hasHeader);
    const renamed = new Set(Object.values(rename).map(n => n.toLowerCase()));
    const taken = new Set(renamed);
    const finalNames = names.map((name, c) => {
      if (c in rename) return rename[c];
      if (!name) return name;
      let unique = name;
      for (let n = 2; taken.has(unique.toLowerCase()); n++) unique = `${name}_${n}`;
      taken.add(unique.toLowerCase());
      return unique;
    });

    const width = Math.max(minColumns, Math.min(finalNames.length, maxColumns));
    const columns = Array.from({ length: width }, (_, c) => ({ name: finalNames[c] || '', type: 'AUTO', auto: false, seed: null }));
    const data = (hasHeader ? grid.slice(1) : grid).slice(0, maxRows);
    const rows = data.map(row => Array.from({ length: width }, (_, c) => String(row[c] ?? '')));
    return { columns, rows, truncatedColumns: Math.max(0, finalNames.length - maxColumns) };
  }

  return {
    isExcelFile,
    isTextFile,
    isJsonFile,
    decodeText,
    cellText,
    cleanGrid,
    textSheets,
    jsonSheets,
    workbookSheets,
    looksLikeHeader,
    headerNames,
    suggestMapping,
    buildSheet,
  };
});
