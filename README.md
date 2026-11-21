# csv-fast

A faster drop-in for make.fun's csv-reader 1.0.0 — entry for
[csv-reader-speed-01-run-20261121](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
($100, 10 places at $10).

## What it is

`solve.js` exports `run(input)`, which returns exactly what csv-reader
1.0.0 returns for the same `{text, header}`: `{columns, rows, errors}`,
including its broken-row policy (BOM dropped, stray CRs, unterminated
quotes re-read as unquoted, junk after a closing quote, short/long rows
padded or cut to the first record's width, errors in the order met).

`main.ts` is the program the harness runs: it reads every case from
`/input/cases.json`, answers each one alone with `run`, and writes
`/output/answers.json`.

## Why it is faster

The reference walks the text one character at a time and grows every field
by concatenation. This reader instead cuts each field out with `indexOf`
and `slice`, and only rebuilds a field piece by piece when the text forces
it: a stray CR, a doubled quote, or a line break inside quotes. A stray CR
is looked for only inside the field — the next comma or LF is found first,
and only the short stretch up to it is walked — so a rare CR can never make
a scan run past the field. No per-field object is allocated: the unquoted
scan writes into one reused scratch result.

## Files

- `solve.js` — the reader (dependency-free ES module)
- `main.ts` — the harness driver
- `package.json` — `{"type": "module"}`

## License

MIT — see `LICENSE`.
