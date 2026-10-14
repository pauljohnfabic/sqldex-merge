# SQLDex Merge

Write a T-SQL query once, paste or import your rows (Excel, CSV or JSON), and get a ready-to-run script.

![SQLDex Merge](docs/screenshot.png)

## Features

- **Queryboard.** Type any T-SQL: `EXEC`, `SELECT`, `INSERT`, `UPDATE`, `DELETE`, or a multi-statement script. Every `@param` becomes a column in the sheet.
- **Two-way sync.** Typing a `@param` names a column, and renaming a column renames the `@param` in the query.
- **Spreadsheet-style sheet.** Starts with 10 columns and grows to 100, with up to 100,000 rows. Paste a block of cells straight from Excel or Google Sheets, with or without headers.
- **Import files.** Open or drop a `.xlsx`, `.xls`, `.csv` or `.json` file. You pick the sheet, check the preview, and choose which column feeds each `@param`.
- **Column types.** *Auto* detects the type from the data, or you can pick INT, BIGINT, DECIMAL, BIT, VARCHAR, NVARCHAR, DATE, DATETIME or GUID. Cells that don't match their type turn red.
- **Safe values.** Quotes are escaped, Unicode text gets `N'...'`, and blank cells become `NULL`.
- **Two output modes.**
  - **Direct** writes one statement per row.
  - **Loop** loads the rows into a table variable and runs the query in a `WHILE` loop.
- **BEGIN TRAN with `@iscommit`.** Wraps the script so the first run rolls back and you can check the result before committing.
- **Live preview and one-click copy.**
- **Nothing to install.** It runs in the browser, works offline, and keeps your last session in the browser's local storage.

## Getting started

Use it online at **https://pauljohnfabic.github.io/sqldex-merge/**.

To run it on your own machine:

```sh
git clone https://github.com/pauljohnfabic/sqldex-merge.git
```

Then open `index.html` in any modern browser (Chrome, Edge or Firefox). There's no build step and no server.

## How to use

1. **Type your query in the Queryboard.** For example:

   ```sql
   delete from re.customerledger where transactionno = @docno
   ```

   Column A of the sheet is named `docno`.

2. **Add your data**, one row per execution: paste it into the sheet, or click **Import** (or drop a file on the page).
3. **Check the type** above each column. *Auto* is usually right. Pick a type to override it.
4. **Choose Direct or Loop**, then click **Copy**.
5. **Run the script in SSMS.** With BEGIN TRAN on, the first run rolls back. When the result looks right, change `@iscommit` to `1` and run it again to commit.

### What the Queryboard understands

| You type | The sheet |
|---|---|
| `delete from re.customerledger where transactionno = @docno` | Column A is named `docno`. |
| `exec re.nsp_customerledger @qtype = 1` | Column A is named `qtype`, and row 1 gets `1`. |
| `re.nsp_customerledger` (procedure name only) | Every named column is passed as `@column = value`. |
| `exec re.nsp_x @transno = @docno` | The `docno` column fills `@transno`. |

The procedure-name-only form also works the other way around: name the columns (or paste rows with a header line into a column name), then type the procedure name.

Variables you `DECLARE` in the query, and system variables like `@@ROWCOUNT`, are not treated as columns.

### Direct vs Loop

The output for the `delete` example above, with three document numbers in the sheet.

**Direct** writes one statement per row. It's easy to read and best for a handful of rows.

```sql
BEGIN TRAN;
DECLARE @iscommit INT = 0;

delete from re.customerledger where transactionno = 'DOC-0001';
delete from re.customerledger where transactionno = 'DOC-0002';
delete from re.customerledger where transactionno = 'DOC-0003';

IF @iscommit = 1
    COMMIT TRAN;
ELSE
    ROLLBACK TRAN;
```

**Loop** puts the rows in `@tbl` and runs the query once per row, using variables named after the columns. It keeps the script short when there are many rows.

<details>
<summary>Show the Loop output</summary>

```sql
SET NOCOUNT ON;

BEGIN TRAN;
DECLARE @iscommit INT = 0;

DECLARE @tbl TABLE (
    row_no INT IDENTITY(1, 1) PRIMARY KEY,
    docno VARCHAR(50)
);

INSERT INTO @tbl (docno)
VALUES
    ('DOC-0001'),
    ('DOC-0002'),
    ('DOC-0003');

DECLARE @min INT,
        @max INT,
        @docno VARCHAR(50);

SELECT @min = MIN(row_no), @max = MAX(row_no) FROM @tbl;

WHILE @min <= @max
BEGIN
    SELECT @docno = docno
    FROM @tbl
    WHERE row_no = @min;

    delete from re.customerledger where transactionno = @docno;

    SET @min = @min + 1;
END

IF @iscommit = 1
    COMMIT TRAN;
ELSE
    ROLLBACK TRAN;
```

</details>

`INSERT` statements are split every 1,000 rows, which is SQL Server's limit for one `VALUES` list.

### BEGIN TRAN and @iscommit

The **BEGIN TRAN @iscommit** checkbox next to Direct / Loop is on by default. It wraps the script in a transaction that rolls back unless `@iscommit = 1`.

Turn it off for:

- statements that can't run inside a transaction, such as `RESTORE DATABASE`;
- scripts that contain `GO`, because `GO` ends the batch and `@iscommit` stops existing after it.

## Importing a file

Click **Import** in the Sheet panel, or drop a file anywhere on the page.

| File | What comes in |
|---|---|
| `.xlsx`, `.xlsm`, `.xls`, `.xlsb`, `.ods` | Any sheet of the workbook. The sheet whose columns match your `@params` is picked first. |
| `.csv`, `.tsv`, `.txt` | Comma, semicolon, tab or pipe separated. UTF-8, UTF-16 and Excel's plain "CSV" (Windows-1252) all work. |
| `.json`, `.jsonl` | An array of objects (the keys become the column names) or of arrays. Each array inside an object, such as `{ "data": [...] }`, shows up as its own sheet. JSON Lines works too. |

The import window shows a preview and lets you:

- choose the sheet;
- say whether the first row has column names (it guesses);
- choose which column fills each Queryboard `@param`. Headers are matched ignoring case, spaces and underscores, so `Transaction No.` fills `@transactionno`.

Headers become valid parameter names (`Customer Name` becomes `Customer_Name`), and you can rename them in the sheet afterwards. Importing replaces the sheet, and you can undo it.

How values come in:

- **Numbers** keep every digit, even when Excel shows `1.23457E+11` or `₱1,250.00`. Zero-padded codes like `0007` keep their zeros.
- **Dates** become `yyyy-mm-dd` (or `yyyy-mm-dd hh:mm:ss`), which SQL Server reads the same way under any language setting.
- **TRUE/FALSE** stay as words, so *Auto* makes the column a BIT.
- **JSON `null`** becomes `NULL`. Nested objects and arrays become JSON text, for procedures that take JSON.

Empty rows, and columns that are empty all the way down, are left out.

## Value rules

| Type | How a cell is written |
|---|---|
| INT, BIGINT, DECIMAL | As a number. Thousands separators are removed (`1,250.50` becomes `1250.50`). |
| BIT | `1`, `true`, `yes`, `y` become `1`. `0`, `false`, `no`, `n` become `0`. |
| VARCHAR, DATE, DATETIME, GUID | Quoted, with `'` escaped as `''`. |
| NVARCHAR | Quoted as `N'...'`. |
| Any type | A blank cell or the word `NULL` becomes `NULL`. |

*Auto* keeps values with leading zeros, like `007`, as text.

## Sheet tips

- `Enter` / `Shift+Enter` move down and up. The arrow keys move between cells.
- Paste into a **column name** cell to bring the header line along with the data.
- Pasting something wider than the sheet adds columns. The **+** after the last column adds one too.
- Hover over a column header for **Fill blanks down**, **Clear column data** and **Remove column**. A column that the Queryboard names itself can't be removed; take the `@param` out of the query first.
- Big sheets stay fast: only the rows on screen are drawn, and the Output panel shows the first 300 lines. **Copy** always copies the whole script.
- If a sheet is too big for the browser to remember, a note says so. The Queryboard and the column names are still kept.
- Paste, Import, Clear, Sample, Fill blanks down, Clear column data and Remove column can each be undone from the message that pops up afterwards.

## Options

These are at the bottom of the Output panel.

| Option | What it does |
|---|---|
| Blank → NULL | Blank cells become `NULL`. Turn it off to write blank text cells as `''`. |
| Trim spaces | Removes leading and trailing spaces from every value. |
| lowercase | Writes the keywords that SQLDex generates in lowercase. |

## Development

The engine and the importer have unit tests (Node 18 or newer):

```sh
npm test
```

| Path | Contents |
|---|---|
| `index.html` | The page |
| `css/styles.css` | The theme |
| `js/engine.js` | Query parsing, sheet ⇄ query sync and SQL generation. It has no DOM code, so it runs in Node too. |
| `js/importer.js` | Reads uploaded files into sheet rows. No DOM code either. |
| `js/app.js` | The UI |
| `vendor/xlsx.full.min.js` | [SheetJS](https://sheetjs.com) Community Edition 0.20.3, which reads Excel files. It loads only when you import one. |
| `tests/` | Engine and importer tests |

Plain HTML, CSS and JavaScript, with no framework and no build step. The only third-party code is SheetJS, kept in `vendor/` so the tool also works offline.

## License

[MIT](LICENSE). SheetJS is under the Apache License 2.0 ([vendor/xlsx.LICENSE](vendor/xlsx.LICENSE)).
