/**
 * A small, real RFC4180-shaped CSV parser/writer — no external dependency,
 * consistent with this codebase's existing self-reliance for well-
 * understood, boundedly-complex code (e.g. carrier-client.ts's mock,
 * money-calculation.ts's own arithmetic). Pure functions, zero imports —
 * same discipline as `orders/state-machine.ts`, testable at the unit
 * level without a database.
 *
 * Handles what a seller's real spreadsheet export will actually contain:
 * quoted fields, commas and newlines inside a quoted field, and escaped
 * quotes (`""` inside a quoted field is a literal `"`) — the cases a naive
 * `line.split(",")` silently gets wrong.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // Normalize line endings up front so the state machine below only ever
  // has to reason about \n, never \r\n vs \n inconsistently mid-file.
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];

    if (inQuotes) {
      if (char === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i++; // consume the escaped quote's second character too
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  // The final field/row has no trailing delimiter to close it.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** Rows as header-keyed objects — what every real caller actually wants,
 * `parseCsv` stays the low-level primitive underneath for testability. */
export function parseCsvWithHeader(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const [header, ...dataRows] = rows;
  return dataRows.map((row) => {
    const record: Record<string, string> = {};
    header!.forEach((key, i) => {
      record[key.trim()] = row[i] ?? "";
    });
    return record;
  });
}

/** Quotes a field only when it actually needs it — matches how a real
 * spreadsheet app (Excel, Google Sheets, Numbers) writes CSV, so a
 * generated export round-trips cleanly through any of them. */
function csvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function writeCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [header, ...rows].map((row) => row.map(csvField).join(","));
  return lines.join("\n");
}
