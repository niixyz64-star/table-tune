# TableTune

Tune your Obsidian tables: drag column/row borders to resize them, and the sizes are remembered **per table** — switching between Reading and Edit (Live Preview) always shows the same layout, and reopening a note keeps your custom widths.

## Features

- **Drag to resize** column widths and row heights (Edit / Live Preview mode).
- **Remembered per table** — works with several tables in one note, even tables with identical headers (each gets its own size).
- **Reading view parity** — the same column widths are applied in Reading mode, with a single clean horizontal scrollbar (no double-scrollbar / clipped-table glitches across vaults and themes).
- **Content-aware defaults** — tables without saved sizes get columns fitted to their content automatically (capped), so big text-heavy tables are readable right away.
- No source rewriting: sizes are stored in the plugin's `data.json`, keyed by note and table.

## Installation

### Community plugin list (pending review)

Once approved, install from **Settings → Community plugins → Browse** and search "TableTune".

### Manual / BRAT

- **BRAT**: add `niixyz64-star/table-tune` via the BRAT plugin.
- **Manual**: copy the `table-tune` folder into `<vault>/.obsidian/plugins/`, then enable it in Settings → Community plugins.

## Usage

1. Open a note in **Edit / Live Preview**.
2. Hover a column border in the header — drag to resize the column (drag the bottom edge of the leftmost cell to resize a row).
3. Switch to **Reading** view: the same widths are applied. If a table is wider than the pane, it gets its own horizontal scrollbar.

## How it works

- A `colgroup` with one `<col>` per header column is added to each table, and the table width is set to the sum of its columns (resizing one column grows the table instead of stealing space from neighbours).
- Widths/heights are stored in `data.json` as `{ widths: { [note]: { [tableId]: [px, ...] } }, rowHeights: { ... } }`, where `tableId` is derived from the header text (with `#2`, `#3`, … suffixes for duplicate headers).
- Legacy single-array data from older versions is migrated automatically.

## License

MIT
