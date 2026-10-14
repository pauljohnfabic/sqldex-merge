# SP-Dex

Write a query with `@params`, paste the rows from Excel or Google Sheets, and copy the generated T-SQL.

## Run it

Open `index.html` in a browser. There's no install and no build step. Your work is saved in the browser's localStorage.

Tests for the SQL engine (requires Node 18+):

```sh
npm test
```

## How it works

**Queryboard (top).** Type any SQL here. Each `@param` becomes a sheet column.

| You type | The sheet |
|---|---|
| `delete from re.customerledger where transactionno = @docno` | column A is named `docno` |
| `exec re.nsp_customerledger @qtype = 1` | column A is named `qtype` and row 1 gets `1` |
| `re.nsp_customerledger` (procedure name only) | every named sheet column is passed as `@column = value` |
| `exec re.nsp_x @transno = @docno` | the `docno` column fills `@transno` |

It works in both directions. Renaming a column header also renames that `@param` in the Queryboard.

**Sheet (left).** Up to 10 columns. Each header has a type dropdown and the parameter name. The dropdown starts on *Auto*, which guesses the type from the data. Pick a type to override it. Cells that don't match their type turn red. Hover over a header to find **Fill blanks down** and **Clear column data**.

**Output (right).** Updates live as you type.

- **Direct**: one statement per row. Best for a few rows, or a single row.
- **Loop**: the rows go into `@tbl`, and the query runs inside `WHILE @min <= @max` using variables that have the same names as the columns.

**BEGIN TRAN `@iscommit`** checkbox (next to Direct / Loop, on by default): wraps the script in `BEGIN TRAN; DECLARE @iscommit INT = 0;` … `IF @iscommit = 1 COMMIT TRAN ELSE ROLLBACK TRAN`. The first run rolls back. Set `@iscommit = 1` to keep the changes. Turn it off for things that can't run inside a transaction, such as a restore.

Options at the bottom of the Output panel:

- *Blank → NULL*: otherwise blank text cells become `''`.
- *Trim spaces*.
- *lowercase*: for the keywords SP-Dex generates.

## Value rules

| Type | `abc` / `1,250.50` / blank / `NULL` |
|---|---|
| INT, BIGINT, DECIMAL | as a number (thousands commas are removed); anything that isn't a number gets quoted and flagged |
| BIT | `1/true/yes/y` → `1`, `0/false/no/n` → `0` |
| VARCHAR, DATE, DATETIME, GUID | `'quoted'`, with `'` escaped as `''` |
| NVARCHAR | `N'quoted'` |
| any | a blank cell or the word `NULL` → `NULL` |

## Stack

Plain HTML, CSS and JavaScript, with no framework and no backend. Everything runs in the browser, so you can open the file directly or host it on any static host (GitHub Pages, Netlify).

- `index.html`: the page
- `css/styles.css`: the theme (Pokémon type colors are the `[data-poke]` tokens)
- `js/engine.js`: query parsing, sheet ⇄ query sync and SQL generation (no DOM, so it can be tested in Node)
- `js/app.js`: the UI
- `tests/engine.test.js`: `node --test`
