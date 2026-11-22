#!/usr/bin/env node
/*
 * Hand-off check: every repo path an agent hand-off file names must exist at the git ref the file names.
 *
 *   node scripts/check-handoffs.js        (npm run check:handoffs)
 *
 * Reads handoff/*.md. Per file it collects (ref, path) pairs from two places:
 *   - the `## Files` table (`| Path | Ref | What it is | Do |`): path and ref are the first backticked token of
 *     columns 1 and 2; an empty ref means the file's tag (the first "tag `X`" in the first 10 lines);
 *   - any `show REF:PATH` text (for example `git -C /tmp/abl show ep3-cron-state-files:actions/stuck-orders/index.js`),
 *     checked with its own ref.
 * A file with `tag: none` in its first 10 lines has no tag and is skipped. Refs or paths containing < or >, and the
 * literal placeholders REF and PATH, are ignored. Each pair is checked with `git cat-file -e <ref>:<path>` (no shell).
 * Also ignored: refs or paths with shell variables ($, { or }), and `show` text not written as `git [-C dir] show`
 * (prose, URLs). `show` paths are read up to the first space, so a path with a space is not supported. A file with
 * neither a tag line nor `tag: none` prints `MISSING <file> no tag line`. Rows with no backticked path, or a Ref
 * cell without backticks, are warned about on stderr (not a failure).
 * Prints `ok <file> <n> paths` or one `MISSING <file> <ref>:<path>` line per miss; exits 1 if anything is missing.
 *
 * Not wired into CI: the CI checkout has no tags, so the episode refs would all look missing. Run it locally.
 * CommonJS, no dependencies, so jest can load extractRefs (test/check-handoffs.test.js).
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const root = path.resolve(__dirname, '..')

const isPlaceholder = v => !v || /[<>${}]/.test(v) || v === 'REF' || v === 'PATH'
const firstTick = cell => { const m = /`([^`]*)`/.exec(cell || ''); return m ? m[1].trim() : '' }

// Markdown text -> { tag, noTag, refs: [{ ref, path }] }; pure, no git.
function extractRefs (markdown) {
  const lines = String(markdown).split(/\r?\n/)
  const head = lines.slice(0, 10).join('\n')
  const noTag = /\btag:\s*none\b/i.test(head)
  const tagMatch = /\btag\s+`([^`]+)`/i.exec(head)
  const tag = noTag || !tagMatch ? null : tagMatch[1].trim()
  if (noTag) return { tag: null, noTag: true, refs: [], warnings: [] }

  const refs = []
  const warnings = []
  const seen = new Set()
  const add = (ref, p) => {
    if (isPlaceholder(ref) || isPlaceholder(p)) return
    const key = `${ref}\0${p}`
    if (seen.has(key)) return
    seen.add(key)
    refs.push({ ref, path: p })
  }

  let inFiles = false
  let fence = false
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (!fence && /^#{1,6}\s/.test(line)) inFiles = /^##\s+Files\s*$/i.test(line)
    if (inFiles && line.trim().startsWith('|')) {
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
      const isSeparator = cells.every(c => /^\s*:?-+:?\s*$/.test(c))
      const isHeader = /^\s*path\s*$/i.test(cells[0])
      if (!isSeparator && !isHeader) {
        const p = firstTick(cells[0])
        const ref = firstTick(cells[1])
        if (!p) warnings.push(`row has no backticked path: ${line.trim()}`)
        if (!ref && (cells[1] || '').trim()) warnings.push(`Ref cell has no backticks: ${line.trim()}`)
        add(ref || tag, p)
      }
    }
  }

  const show = /\bgit(?:\s+-C\s+\S+)?(?:\s+--no-pager)?\s+show\s+(\S+?):(\S+)/g
  for (const text of lines) {
    let m
    show.lastIndex = 0
    while ((m = show.exec(text)) !== null) {
      const ref = m[1].replace(/^[`'"(]+/, '')
      const p = m[2].replace(/[`'")\].,;]+$/, '')
      if (!p.startsWith('//')) add(ref, p)
    }
  }
  return { tag, noTag, refs, warnings }
}

function exists (ref, p) {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:${p.replace(/\/+$/, '')}`], { cwd: root, stdio: 'ignore' })
    return true
  } catch (e) {
    return false
  }
}

function run (dir = path.join(root, 'handoff')) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort() : []
  if (!files.length) {
    console.log('no hand-off files')
    return 0
  }
  let missing = 0
  for (const f of files) {
    const name = path.join('handoff', f)
    const { tag, noTag, refs, warnings } = extractRefs(fs.readFileSync(path.join(dir, f), 'utf8'))
    for (const w of warnings) console.error(`warning ${name} ${w}`)
    if (noTag) {
      console.log(`ok ${name} 0 paths (no tag)`)
      continue
    }
    if (!tag) {
      console.log(`MISSING ${name} no tag line`)
      missing++
      continue
    }
    const misses = refs.filter(r => !exists(r.ref, r.path))
    for (const r of misses) console.log(`MISSING ${name} ${r.ref}:${r.path}`)
    if (!misses.length) console.log(`ok ${name} ${refs.length} paths`)
    missing += misses.length
  }
  return missing ? 1 : 0
}

if (require.main === module) process.exit(run())

module.exports = { extractRefs, exists, run }
