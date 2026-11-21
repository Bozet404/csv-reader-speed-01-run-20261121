// csv-fast: a faster drop-in for make.fun's csv-reader 1.0.0.
//
// It returns exactly csv-reader 1.0.0's answer for every input, and it is
// faster because it never walks the text one character at a time and never
// grows a field by concatenation. Each field is cut out with indexOf and
// slice, and a field is only rebuilt piece by piece when the text forces it:
// a stray CR, a doubled quote, or a line break inside quotes. No
// dependencies, no WebAssembly, and nothing is kept from one call to the
// next: every run(input) starts cold.
//
// The reading policy, restated from the bounty brief:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no
//     record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled; "" inside it is one quote, and each CRLF or lone CR inside it
//     reads as LF; what follows its closing quote, up to the next comma or
//     line break, is appended as it stands (quote_junk, when the field ends);
//     a quote that never closes is a literal character, and the text after
//     it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character;
//   - fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded with "" (short_row, with fields: its
//     count) or cut (long_row, with extra: the cut fields) to the first
//     record's width;
//   - each error is {code, line, row}, in the order met; line is the 1-based
//     line its record starts on, counting every LF, CRLF and lone CR inside
//     quotes, and row is its record's index in rows, null for the header.

const COMMA = 0;
const BREAK = 1;
const END = 2;

const CODE_COMMA = 44; // ,
const CODE_QUOTE = 34; // "
const CODE_LF = 10; // \n
const CODE_CR = 13; // \r
const CODE_BOM = 0xfeff;

/** Scratch result reused by scanPlain, so no object is allocated per field. */
const plain = { value: '', end: END, pos: 0, kept: 0, line: 1 };

/**
 * Reads an unquoted field of `text` starting at `start`, onto `head`
 * (the value built so far, '' for a fresh field). The result is written
 * into `plain` and returned: value, how the field ended (COMMA, BREAK or
 * END), the position after it, how many characters this scan kept, and the
 * line that position is on. A CR not followed by LF is dropped and recorded
 * as stray_cr; a CR followed by LF ends the field, and the CR is not part
 * of the value. Stray CRs are looked for only inside the field: the next
 * comma or LF is found first with indexOf, and only the short stretch up to
 * it is walked, so a rare CR can never make the scan run past the field.
 */
function scanPlain(text, start, head, errors, recLine, recRow, line) {
  const n = text.length;
  let kept = 0;
  let acc = null; // pieces kept so far, once a stray CR splits the field
  let cur = start;
  for (;;) {
    const ci = text.indexOf(',', cur);
    const ni = text.indexOf('\n', cur);
    let m = -1;
    let comma = false;
    if (ci !== -1 && (ni === -1 || ci < ni)) {
      m = ci;
      comma = true;
    } else if (ni !== -1) {
      m = ni;
    }
    if (m === -1) {
      // No comma or LF is left: the field runs to the end of the text,
      // and any CR in it is stray.
      let k = cur;
      while (k < n) {
        if (text.charCodeAt(k) === CODE_CR) {
          errors.push({ code: 'stray_cr', line: recLine, row: recRow });
          acc = acc === null ? head + text.slice(cur, k) : acc + text.slice(cur, k);
          kept += k - cur;
          cur = k + 1;
        }
        k += 1;
      }
      plain.value = acc === null ? head + text.slice(cur) : acc + text.slice(cur);
      plain.kept = kept + (n - cur);
      plain.end = END;
      plain.pos = n;
      plain.line = line;
      return plain;
    }
    // The first CR inside [cur, m), if there is one.
    let cr = -1;
    for (let k = cur; k < m; k++) {
      if (text.charCodeAt(k) === CODE_CR) {
        cr = k;
        break;
      }
    }
    if (cr === -1) {
      // The field ends at m. When it ends at a LF whose previous character
      // is a CR, that CR belongs to the CRLF, not to the field.
      const end = !comma && m > cur && text.charCodeAt(m - 1) === CODE_CR ? m - 1 : m;
      plain.value = acc === null ? head + text.slice(cur, end) : acc + text.slice(cur, end);
      plain.kept = kept + (end - cur);
      if (comma) {
        plain.end = COMMA;
        plain.pos = m + 1;
      } else {
        plain.end = BREAK;
        plain.pos = m + 1;
        line += 1;
      }
      plain.line = line;
      return plain;
    }
    if (!comma && cr + 1 === m) {
      // The CR is the CRLF's: the field ends here, at the CR.
      plain.value = acc === null ? head + text.slice(cur, cr) : acc + text.slice(cur, cr);
      plain.kept = kept + (cr - cur);
      plain.end = BREAK;
      plain.pos = m + 1;
      plain.line = line + 1;
      return plain;
    }
    // A stray CR: dropped, recorded, and the scan goes on after it.
    errors.push({ code: 'stray_cr', line: recLine, row: recRow });
    acc = acc === null ? head + text.slice(cur, cr) : acc + text.slice(cur, cr);
    kept += cr - cur;
    cur = cr + 1;
  }
}

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = n > 0 && text.charCodeAt(0) === CODE_BOM ? 1 : 0;
  let line = 1;

  for (;;) {
    // A line left with no characters is no record.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === CODE_LF) {
        pos += 1;
        line += 1;
      } else if (c === CODE_CR && pos + 1 < n && text.charCodeAt(pos + 1) === CODE_LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    const recLine = line;
    const recRow = header && columns === null ? null : rows.length;
    const fields = [];
    let end;
    let quoted = false;

    do {
      if (text.charCodeAt(pos) === CODE_QUOTE) {
        // A field that opens with a quote.
        quoted = true;
        const open = pos;
        const openLine = line;
        let scanLine = line;
        let acc = null; // pieces of the value finished so far
        let cur = pos + 1;
        let value;
        let closed = false;
        while (cur <= n) {
          const qi = text.indexOf('"', cur);
          if (qi === -1) break; // the quote never closes
          // A line break inside this stretch counts, and a CRLF or a lone
          // CR inside it reads as one LF in the value.
          let broken = false;
          for (let k = cur; k < qi; k++) {
            const cc = text.charCodeAt(k);
            if (cc === CODE_LF || cc === CODE_CR) {
              broken = true;
              break;
            }
          }
          const doubled = qi + 1 < n && text.charCodeAt(qi + 1) === CODE_QUOTE;
          if (!broken) {
            if (doubled) {
              acc = acc === null ? text.slice(cur, qi) + '"' : acc + text.slice(cur, qi) + '"';
              cur = qi + 2;
              continue;
            }
            value = acc === null ? text.slice(cur, qi) : acc + text.slice(cur, qi);
            closed = true;
            pos = qi + 1;
            break;
          }
          const raw = text.slice(cur, qi);
          const breaks = raw.match(/\r\n?|\n/g);
          if (breaks !== null) scanLine += breaks.length;
          const norm = raw.replace(/\r\n?/g, '\n');
          if (doubled) {
            acc = acc === null ? norm + '"' : acc + norm + '"';
            cur = qi + 2;
            continue;
          }
          value = acc === null ? norm : acc + norm;
          closed = true;
          pos = qi + 1;
          break;
        }
        if (!closed) {
          // The quote never closes: it is a literal character, and the
          // text after it is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recLine, row: recRow });
          const p = scanPlain(text, open + 1, '"', errors, recLine, recRow, openLine);
          fields.push(p.value);
          pos = p.pos;
          line = p.line;
          end = p.end;
        } else {
          line = scanLine;
          if (pos >= n) {
            fields.push(value);
            end = END;
          } else {
            const c = text.charCodeAt(pos);
            if (c === CODE_COMMA) {
              fields.push(value);
              pos += 1;
              end = COMMA;
            } else if (c === CODE_LF) {
              fields.push(value);
              pos += 1;
              line += 1;
              end = BREAK;
            } else if (c === CODE_CR && pos + 1 < n && text.charCodeAt(pos + 1) === CODE_LF) {
              fields.push(value);
              pos += 2;
              line += 1;
              end = BREAK;
            } else {
              // What follows the closing quote is appended as it stands,
              // up to the next comma or line break.
              const p = scanPlain(text, pos, value, errors, recLine, recRow, line);
              if (p.kept > 0) errors.push({ code: 'quote_junk', line: recLine, row: recRow });
              fields.push(p.value);
              pos = p.pos;
              line = p.line;
              end = p.end;
            }
          }
        }
      } else {
        // An unquoted field: a quote inside it is a literal character.
        quoted = false;
        const p = scanPlain(text, pos, '', errors, recLine, recRow, line);
        fields.push(p.value);
        pos = p.pos;
        line = p.line;
        end = p.end;
      }
    } while (end === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: recRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
