/*
 * Unit tests for the hand-off path extractor (scripts/check-handoffs.js). Pure: no git calls.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { extractRefs, run } = require('../scripts/check-handoffs')

const doc = (body, head = 'Hand-off for the next agent, tag `ep3-cron-state-files`.') => `# Hand-off\n${head}\n\n${body}\n`

const table = rows => `## Files\n\n| Path | Ref | What it is | Do |\n|---|---|---|---|\n${rows}\n`

test('the header and separator rows are not taken as paths', () => {
  const { tag, refs } = extractRefs(doc(table('| `a/b.js` | | code | read |')))
  expect(tag).toBe('ep3-cron-state-files')
  expect(refs).toEqual([{ ref: 'ep3-cron-state-files', path: 'a/b.js' }])
})

test('a per-row ref wins, and an empty ref falls back to the file tag', () => {
  const { refs } = extractRefs(doc(table('| `a.js` | `main` | x | y |\n| `b.js` |  | x | y |\n| `c.js` | no backticks | x | y |')))
  expect(refs).toEqual([
    { ref: 'main', path: 'a.js' },
    { ref: 'ep3-cron-state-files', path: 'b.js' },
    { ref: 'ep3-cron-state-files', path: 'c.js' }
  ])
})

test('show <tag>:<path> and show REF:PATH placeholders are ignored', () => {
  const { refs } = extractRefs(doc('Run `git show <tag>:<path>` or git show REF:PATH to read it.'))
  expect(refs).toEqual([])
})

test('a show line with its own ref is included, with trailing punctuation stripped', () => {
  const { refs } = extractRefs(doc('Run `git -C /tmp/abl show ep4-database-storage:actions/stuck-orders/index.js`.'))
  expect(refs).toEqual([{ ref: 'ep4-database-storage', path: 'actions/stuck-orders/index.js' }])
})

test('tag: none gives noTag true and no refs', () => {
  const md = doc(table('| `a.js` | `main` | x | y |') + '\ngit show main:b.js', 'Nothing to pin. tag: none')
  expect(extractRefs(md)).toMatchObject({ tag: null, noTag: true, refs: [] })
})

test('a tag past line 10 is not the file tag', () => {
  const md = '\n'.repeat(12) + 'tag `late`\n' + table('| `a.js` | | x | y |')
  expect(extractRefs(md)).toMatchObject({ tag: null, noTag: false, refs: [] })
})

test('duplicate (ref, path) pairs are removed, across table and show lines', () => {
  const md = doc(table('| `a.js` | | x | y |\n| `a.js` | `ep3-cron-state-files` | x | y |') + '\ngit show ep3-cron-state-files:a.js\ngit show main:a.js')
  expect(extractRefs(md).refs).toEqual([
    { ref: 'ep3-cron-state-files', path: 'a.js' },
    { ref: 'main', path: 'a.js' }
  ])
})

test('table rows outside the Files section are ignored', () => {
  const md = doc('## Other\n\n| `x.js` | `main` | a | b |\n\n' + table('| `y.js` | | a | b |'))
  expect(extractRefs(md).refs).toEqual([{ ref: 'ep3-cron-state-files', path: 'y.js' }])
})

test('shell variables in show lines are placeholders', () => {
  const md = doc('git show $TAG:a.js\ngit show "${TAG}:b.js"\ngit show "$REF:$PATH"\ngit show main:ok.js')
  expect(extractRefs(md).refs).toEqual([{ ref: 'main', path: 'ok.js' }])
})

test('a typo in the tag line (tag: `ep1`) gives no tag and no noTag, and the CLI reports it', () => {
  const md = doc(table('| `a.js` | | x | y |'), 'Hand-off, tag: `ep1`')
  expect(extractRefs(md)).toMatchObject({ tag: null, noTag: false })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-'))
  fs.writeFileSync(path.join(dir, 'x.md'), md)
  const log = jest.spyOn(console, 'log').mockImplementation(() => {})
  try {
    expect(run(dir)).toBe(1)
    expect(log).toHaveBeenCalledWith(`MISSING ${path.join('handoff', 'x.md')} no tag line`)
  } finally {
    log.mockRestore()
    fs.rmSync(dir, { recursive: true })
  }
})

test('a "# " line inside a code fence does not end the Files section', () => {
  const md = doc('## Files\n\n```bash\n# a comment\n```\n\n| Path | Ref | What it is | Do |\n|---|---|---|---|\n| `a.js` | | x | y |\n\n~~~\n# more\n~~~\n| `b.js` | | x | y |')
  expect(extractRefs(md).refs).toEqual([
    { ref: 'ep3-cron-state-files', path: 'a.js' },
    { ref: 'ep3-cron-state-files', path: 'b.js' }
  ])
})

test('show only counts after git (with -C dir), and URLs are skipped', () => {
  const md = doc('The logs show https://example.com/x here.\nSee show main:prose.js.\ngit show https://example.com/y\ngit -C /tmp/abl show main:a.js')
  expect(extractRefs(md).refs).toEqual([{ ref: 'main', path: 'a.js' }])
})

test('rows without a backticked path, and a Ref cell without backticks, give warnings', () => {
  const { refs, warnings } = extractRefs(doc(table('| a.js | | x | y |\n| `b.js` | main | x | y |')))
  expect(refs).toEqual([{ ref: 'ep3-cron-state-files', path: 'b.js' }])
  expect(warnings).toHaveLength(2)
  expect(warnings[0]).toMatch(/no backticked path/)
  expect(warnings[1]).toMatch(/Ref cell has no backticks/)
})
