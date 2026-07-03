#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises"
import { createReadStream, existsSync } from "node:fs"
import { createInterface } from "node:readline"
import { homedir } from "node:os"
import { join, basename } from "node:path"
import { execFileSync } from "node:child_process"
import fg from "fast-glob"
import { Chart } from "chart.js/auto"
import "chartjs-adapter-date-fns"
import { createCanvas, GlobalFonts } from "@napi-rs/canvas"

let Database = null
try {
  Database = (await import('better-sqlite3')).default
} catch {}

const home = homedir()
const toDate = (ms) => new Date(ms).toISOString().slice(0, 10)
const isoToDate = (iso) => iso.slice(0, 10)

function add(map, date, n) {
  map.set(date, (map.get(date) || 0) + n)
}

// Anthropic price table (USD per MTok, [input, output]), snapshot 2026-07-02
// from https://platform.claude.com/docs/en/build-with-claude/prompt-caching
// Derived rates: cache read = 0.1x input, 5m cache write = 1.25x, 1h write = 2x.
const ANTHROPIC_RATES = {
  "claude-fable-5": [10, 50],
  "claude-mythos-5": [10, 50],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-opus-4-5": [5, 25],
  "claude-opus-4-1": [15, 75],
  "claude-opus-4": [15, 75],
  "claude-sonnet-5": [2, 10], // 3/15 from 2026-09-01, handled below
  "claude-sonnet-4-6": [3, 15],
  "claude-sonnet-4-5": [3, 15],
  "claude-sonnet-4": [3, 15],
  "claude-haiku-4-5": [1, 5],
  "claude-haiku-3-5": [0.8, 4],
  "claude-3-7-sonnet": [3, 15],
  "claude-3-5-sonnet": [3, 15],
  "claude-3-5-haiku": [0.8, 4],
  "claude-3-opus": [15, 75],
  "claude-3-haiku": [0.25, 1.25],
}

function anthropicRates(model, ts) {
  if (!model) return null
  let m = model.toLowerCase()
  m = m.slice(m.lastIndexOf("/") + 1)                     // strip provider prefix
  m = m.replace(/^(?:[a-z]{2}\.)?anthropic\./, "")        // bedrock region/vendor prefix
  m = m.replace(/-v\d+(?::\d+)?$/, "")                    // bedrock -v1:0
  m = m.replace(/[-@]\d{8}$/, "")                         // date suffix
  if (m.startsWith("claude-sonnet-5") && ts && new Date(ts) >= new Date("2026-09-01")) return [3, 15]
  if (ANTHROPIC_RATES[m]) return ANTHROPIC_RATES[m]
  for (const k in ANTHROPIC_RATES) if (m.startsWith(k)) return ANTHROPIC_RATES[k]
  return null
}

// TTL-aware cache-write pricing, mirrors Claude Code's own cost function:
// ephemeral_1h tokens bill at 2x input, the rest at 1.25x.
function anthropicCost([inp, out], u) {
  const wTotal = u.cache_creation_input_tokens || 0
  const w1h = Math.min(u.cache_creation?.ephemeral_1h_input_tokens || 0, wTotal)
  return ((u.input_tokens || 0) * inp
    + (u.output_tokens || 0) * out
    + (u.cache_read_input_tokens || 0) * inp * 0.1
    + (wTotal - w1h) * inp * 1.25
    + w1h * inp * 2) / 1e6
}

// OpenAI price table (USD per MTok, [input, output, cacheRead]), models.dev snapshot 2026-07-02.
// -fast variants = priority processing tier, 2x base rate (no published table; assumption).
const OPENAI_RATES = {
  "gpt-5.5-fast": [10, 60, 1],
  "gpt-5.5": [5, 30, 0.5],
  "gpt-5.4-mini-fast": [1.5, 9, 0.15],
  "gpt-5.4-mini": [0.75, 4.5, 0.075],
  "gpt-5.4-fast": [5, 30, 0.5],
  "gpt-5.4-nano": [0.2, 1.25, 0.02],
  "gpt-5.4": [2.5, 15, 0.25],
  "gpt-5.3-codex": [1.75, 14, 0.175],
  "gpt-5.2": [1.75, 14, 0.175],
  "gpt-5.1-codex-mini": [0.25, 2, 0.025],
  "gpt-5.1": [1.25, 10, 0.125],
  "gpt-5": [1.25, 10, 0.125],
}

// Google price table (USD per MTok, [input, output, cacheRead]), vertex list rates.
const GOOGLE_RATES = {
  "gemini-3-pro": [2, 12, 0.2],
  "gemini-3-flash": [0.5, 3, 0.05],
  "gemini-2.5-pro": [1.25, 10, 0.125],
  "gemini-2.5-flash": [0.3, 2.5, 0.075],
}

function prefixRates(table, model) {
  if (!model) return null
  let m = model.toLowerCase()
  m = m.slice(m.lastIndexOf("/") + 1)
  if (table[m]) return table[m]
  for (const k in table) if (m.startsWith(k)) return table[k]
  return null
}
const openaiRates = (model) => prefixRates(OPENAI_RATES, model)

// --cost --estimate: price uncosted (subscription-billed) usage at API list rates.
let estimateMode = false

// One usage aggregate -> USD. OpenCode-shaped splits: input excludes cache
// reads, reasoning separate from output. OpenAI-shaped callers pre-subtract
// cached from input and fold reasoning into output before calling.
function estimateUsd(provider, model, ts, t) {
  if (provider === "anthropic") {
    const r = anthropicRates(model, ts)
    if (!r) return 0
    return (t.in * r[0] + (t.out + t.reason) * r[1] + t.cr * r[0] * 0.1 + t.cw * r[0] * 1.25) / 1e6
  }
  if (provider === "openai") {
    const r = openaiRates(model)
    if (!r) return 0
    return (t.in * r[0] + (t.out + t.reason) * r[1] + t.cr * r[2]) / 1e6
  }
  if (provider === "google") {
    const r = prefixRates(GOOGLE_RATES, model)
    if (!r) return 0
    return (t.in * r[0] + (t.out + t.reason) * r[1] + t.cr * r[2]) / 1e6
  }
  return 0
}

async function collectClaude() {
  const counts = new Map()
  const dir = join(home, ".claude", "projects")
  for (const path of await fg("*/*.jsonl", { cwd: dir })) {
    if (path.includes("/subagents/")) continue
    const text = await readFile(join(dir, path), "utf-8")
    for (const line of text.split("\n")) {
      if (!line.includes('"assistant"') || !line.includes('"usage"')) continue
      try {
        const obj = JSON.parse(line)
        if (obj.type !== "assistant" || obj.isSidechain) continue
        const u = obj.message?.usage
        if (!u || !obj.timestamp) continue
        if (obj.message.model === "<synthetic>") continue
        const tokens = (u.input_tokens || 0) + (u.output_tokens || 0) +
          (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
        if (tokens > 0) add(counts, isoToDate(obj.timestamp), tokens)
      } catch {}
    }
  }
  return counts
}

// Claude Code writes no cost to disk; compute it ccusage-style from tokens.
async function collectCostClaude() {
  const counts = new Map()
  const dir = join(home, ".claude", "projects")
  const seen = new Set()
  for (const path of await fg("*/*.jsonl", { cwd: dir })) {
    if (path.includes("/subagents/")) continue
    const text = await readFile(join(dir, path), "utf-8")
    for (const line of text.split("\n")) {
      if (!line.includes('"assistant"') || !line.includes('"usage"')) continue
      try {
        const obj = JSON.parse(line)
        if (obj.type !== "assistant" || obj.isSidechain) continue
        const u = obj.message?.usage
        if (!u || !obj.timestamp) continue
        if (obj.message.model === "<synthetic>") continue
        const rates = anthropicRates(obj.message.model, obj.timestamp)
        if (!rates) continue
        if (obj.message.id) {
          const key = `${obj.message.id}:${obj.requestId || ""}`
          if (seen.has(key)) continue
          seen.add(key)
        }
        const cost = anthropicCost(rates, u)
        if (cost > 0) add(counts, isoToDate(obj.timestamp), cost)
      } catch {}
    }
  }
  return counts
}

async function collectCodex() {
  const counts = new Map()
  const dir = join(home, ".codex", "sessions")
  for (const path of await fg("**/*.jsonl", { cwd: dir })) {
    try {
      const rl = createInterface({ input: createReadStream(join(dir, path)), crlfDelay: Infinity })
      let prevCumulative = null
      for await (const line of rl) {
        if (!line.includes('"token_count"')) continue
        try {
          const obj = JSON.parse(line)
          if (obj.payload?.type !== "token_count") continue
          const cumTotal = obj.payload.info?.total_token_usage?.total_tokens
          if (cumTotal != null && cumTotal === prevCumulative) continue
          let tokens = obj.payload.info?.last_token_usage?.total_tokens
          if (!tokens && cumTotal != null && prevCumulative != null) tokens = cumTotal - prevCumulative
          if (cumTotal != null) prevCumulative = cumTotal
          if (tokens > 0 && obj.timestamp) add(counts, isoToDate(obj.timestamp), tokens)
        } catch {}
      }
    } catch {}
  }
  return counts
}

// Codex records no cost; estimate from per-event usage at OpenAI list rates.
// input_tokens includes cached; reasoning is a subset of output (Responses API).
async function collectCostCodex() {
  const counts = new Map()
  if (!estimateMode) return counts
  const dir = join(home, ".codex", "sessions")
  for (const path of await fg("**/*.jsonl", { cwd: dir })) {
    try {
      const rl = createInterface({ input: createReadStream(join(dir, path)), crlfDelay: Infinity })
      let model = null, prevCumulative = null
      for await (const line of rl) {
        if (line.includes('"model"') && (line.includes('"session_meta"') || line.includes('"turn_context"'))) {
          try {
            const obj = JSON.parse(line)
            model = obj.payload?.model || obj.payload?.turn_context?.model || model
          } catch {}
          continue
        }
        if (!line.includes('"token_count"')) continue
        try {
          const obj = JSON.parse(line)
          if (obj.payload?.type !== "token_count") continue
          const cumTotal = obj.payload.info?.total_token_usage?.total_tokens
          if (cumTotal != null && cumTotal === prevCumulative) continue
          const u = obj.payload.info?.last_token_usage
          if (cumTotal != null) prevCumulative = cumTotal
          if (!u || !obj.timestamp) continue
          const rates = openaiRates(model)
          if (!rates) continue
          const cached = u.cached_input_tokens || 0
          const usd = ((Math.max((u.input_tokens || 0) - cached, 0)) * rates[0]
            + cached * rates[2]
            + (u.output_tokens || 0) * rates[1]) / 1e6
          if (usd > 0) add(counts, isoToDate(obj.timestamp), usd)
        } catch {}
      }
    } catch {}
  }
  return counts
}

const openCodeRoots = () => [
  join(home, ".local", "share", "opencode"),
  ...(process.platform === "darwin" ? [join(home, "Library", "Application Support", "opencode")] : []),
]

function findOpenCodeDb() {
  for (const root of openCodeRoots()) {
    const p = join(root, "opencode.db")
    if (existsSync(p)) return p
  }
  return null
}

// OpenCode keeps messages in up to three stores: opencode.db, the legacy
// storage/message/ tree, and project-scoped project/*/storage/session/message/
// (incl. project/global). The db does not contain all of them, so scan the
// JSON trees too, skipping message ids already counted elsewhere.
async function scanOpenCodeJson(skipIds, onMessage) {
  const seen = new Set()
  const patterns = [
    "storage/message/ses_*/msg_*.json",
    "project/*/storage/session/message/ses_*/msg_*.json",
  ]
  for (const root of openCodeRoots())
  for (const path of await fg(patterns, { cwd: root, suppressErrors: true })) {
    const id = basename(path, ".json")
    if (skipIds.has(id) || seen.has(id)) continue
    seen.add(id)
    try {
      const obj = JSON.parse(await readFile(join(root, path), "utf-8"))
      if (obj.role !== "assistant") continue
      onMessage(obj)
    } catch {}
  }
}

function collectOpenCodeDb(counts, valueExpr) {
  const dbIds = new Set()
  const dbPath = Database ? findOpenCodeDb() : null
  if (!dbPath) return dbIds
  let db
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const rows = db.prepare(`
      SELECT
        date(time_created / 1000, 'unixepoch') as day,
        SUM(${valueExpr}) as total
      FROM message
      WHERE json_extract(data, '$.role') = 'assistant'
      GROUP BY day
      HAVING total > 0
    `).all()
    for (const row of rows) {
      if (row.day && row.total > 0) add(counts, row.day, row.total)
    }
    for (const id of db.prepare("SELECT id FROM message").pluck().all()) dbIds.add(id)
  } catch {} finally {
    db?.close()
  }
  return dbIds
}

async function collectOpenCode() {
  const counts = new Map()
  const dbIds = collectOpenCodeDb(counts, `
    COALESCE(json_extract(data, '$.tokens.input'), 0) +
    COALESCE(json_extract(data, '$.tokens.output'), 0) +
    COALESCE(json_extract(data, '$.tokens.reasoning'), 0) +
    COALESCE(json_extract(data, '$.tokens.cache.read'), 0) +
    COALESCE(json_extract(data, '$.tokens.cache.write'), 0)
  `)
  await scanOpenCodeJson(dbIds, (obj) => {
    const t = obj.tokens
    if (!t) return
    const tokens = (t.input || 0) + (t.output || 0) + (t.reasoning || 0) +
      (t.cache?.read || 0) + (t.cache?.write || 0)
    if (tokens > 0 && obj.time?.created) add(counts, toDate(obj.time.created), tokens)
  })
  return counts
}

// Estimate one OpenCode message's cost from its token splits.
const openCodeEstimate = (obj) => estimateUsd(obj.providerID, obj.modelID, obj.time?.created, {
  in: obj.tokens?.input || 0,
  out: obj.tokens?.output || 0,
  reason: obj.tokens?.reasoning || 0,
  cr: obj.tokens?.cache?.read || 0,
  cw: obj.tokens?.cache?.write || 0,
})

async function collectCostOpenCode() {
  const counts = new Map()
  const dbIds = collectOpenCodeDb(counts, `COALESCE(json_extract(data, '$.cost'), 0)`)
  if (estimateMode) {
    // subscription-billed rows record cost=0; price them at API list rates
    const dbPath = Database ? findOpenCodeDb() : null
    if (dbPath) {
      let db
      try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true })
        const rows = db.prepare(`
          SELECT
            date(time_created / 1000, 'unixepoch') as day,
            time_created as ts,
            json_extract(data, '$.providerID') as prov,
            json_extract(data, '$.modelID') as model,
            SUM(COALESCE(json_extract(data, '$.tokens.input'), 0)) as tin,
            SUM(COALESCE(json_extract(data, '$.tokens.output'), 0)) as tout,
            SUM(COALESCE(json_extract(data, '$.tokens.reasoning'), 0)) as treason,
            SUM(COALESCE(json_extract(data, '$.tokens.cache.read'), 0)) as tcr,
            SUM(COALESCE(json_extract(data, '$.tokens.cache.write'), 0)) as tcw
          FROM message
          WHERE json_extract(data, '$.role') = 'assistant'
            AND COALESCE(json_extract(data, '$.cost'), 0) = 0
          GROUP BY day, prov, model
        `).all()
        for (const r of rows) {
          const usd = estimateUsd(r.prov, r.model, r.ts, { in: r.tin, out: r.tout, reason: r.treason, cr: r.tcr, cw: r.tcw })
          if (usd > 0 && r.day) add(counts, r.day, usd)
        }
      } catch {} finally {
        db?.close()
      }
    }
  }
  await scanOpenCodeJson(dbIds, (obj) => {
    if (!obj.time?.created) return
    if (obj.cost > 0) add(counts, toDate(obj.time.created), obj.cost)
    else if (estimateMode) {
      const usd = openCodeEstimate(obj)
      if (usd > 0) add(counts, toDate(obj.time.created), usd)
    }
  })
  return counts
}

async function collectGemini() {
  const counts = new Map()
  const dir = join(home, ".gemini", "tmp")
  for (const path of await fg("*/chats/*.json", { cwd: dir })) {
    try {
      const obj = JSON.parse(await readFile(join(dir, path), "utf-8"))
      if (!obj.messages) continue
      for (const msg of obj.messages) {
        if (msg.type !== "gemini") continue
        const t = msg.tokens
        const tk = t?.total || ((t?.input || 0) + (t?.tool || 0) + (t?.output || 0) + (t?.thoughts || 0) + (t?.cached || 0))
        if (tk > 0 && msg.timestamp) add(counts, isoToDate(msg.timestamp), tk)
      }
    } catch {}
  }
  return counts
}

async function collectAmp() {
  const counts = new Map()
  const dir = join(home, ".local", "share", "amp", "threads")
  for (const path of await fg("T-*.json", { cwd: dir })) {
    try {
      const obj = JSON.parse(await readFile(join(dir, path), "utf-8"))
      if (!obj.messages) continue
      const date = obj.created ? toDate(obj.created) : null
      if (!date) continue
      for (const msg of obj.messages) {
        const u = msg.usage
        if (!u) continue
        const tokens = (u.totalInputTokens || 0) + (u.outputTokens || 0)
        if (tokens > 0) add(counts, date, tokens)
      }
    } catch {}
  }
  return counts
}

// Gemini CLI records no cost; estimate from token splits at vertex list rates.
// (Personal OAuth usage is free-tier; the estimate shows list-rate value anyway.)
async function collectCostGemini() {
  const counts = new Map()
  if (!estimateMode) return counts
  const dir = join(home, ".gemini", "tmp")
  for (const path of await fg("*/chats/*.json", { cwd: dir })) {
    try {
      const obj = JSON.parse(await readFile(join(dir, path), "utf-8"))
      for (const msg of obj.messages || []) {
        if (msg.type !== "gemini" || !msg.tokens || !msg.timestamp) continue
        const t = msg.tokens
        const usd = estimateUsd("google", msg.model, msg.timestamp, {
          in: (t.input || 0) + (t.tool || 0), out: t.output || 0,
          reason: t.thoughts || 0, cr: t.cached || 0, cw: 0,
        })
        if (usd > 0) add(counts, isoToDate(msg.timestamp), usd)
      }
    } catch {}
  }
  return counts
}

// Amp records no cost; estimate from per-message usage at Anthropic list rates.
async function collectCostAmp() {
  const counts = new Map()
  if (!estimateMode) return counts
  const dir = join(home, ".local", "share", "amp", "threads")
  for (const path of await fg("T-*.json", { cwd: dir })) {
    try {
      const obj = JSON.parse(await readFile(join(dir, path), "utf-8"))
      const threadDate = obj.created ? toDate(obj.created) : null
      for (const msg of obj.messages || []) {
        const u = msg.usage
        if (!u) continue
        const date = u.timestamp ? isoToDate(u.timestamp) : threadDate
        if (!date) continue
        const usd = estimateUsd("anthropic", u.model, u.timestamp, {
          in: u.inputTokens || 0, out: u.outputTokens || 0, reason: 0,
          cr: u.cacheReadInputTokens || 0, cw: u.cacheCreationInputTokens || 0,
        })
        if (usd > 0) add(counts, date, usd)
      }
    } catch {}
  }
  return counts
}

async function collectPiFormat(dir) {
  const counts = new Map()
  for (const path of await fg("**/*.jsonl", { cwd: dir })) {
    const text = await readFile(join(dir, path), "utf-8")
    for (const line of text.split("\n")) {
      if (!line.includes('"usage"')) continue
      try {
        const obj = JSON.parse(line)
        if (obj.type !== "message") continue
        const u = obj.message?.usage || obj.usage
        const tokens = u?.totalTokens || ((u?.input || 0) + (u?.output || 0) + (u?.reasoning || 0) + (u?.cacheRead || 0) + (u?.cacheWrite || 0))
        if (tokens > 0 && obj.timestamp) add(counts, isoToDate(obj.timestamp), tokens)
      } catch {}
    }
  }
  return counts
}

const collectPi = () => collectPiFormat(join(home, ".pi", "agent", "sessions"))
const collectOmp = () => collectPiFormat(join(home, ".omp", "agent", "sessions"))

async function collectCostPiFormat(dir) {
  const counts = new Map()
  for (const path of await fg("**/*.jsonl", { cwd: dir })) {
    const text = await readFile(join(dir, path), "utf-8")
    for (const line of text.split("\n")) {
      if (!line.includes('"cost"')) continue
      try {
        const obj = JSON.parse(line)
        if (obj.type !== "message") continue
        const u = obj.message?.usage || obj.usage
        let c = u?.cost?.total
        if (!(c > 0) || !obj.timestamp) continue
        // Pi/OMP price all cache writes at the 5m rate; rebill 1h-TTL writes at 2x input.
        // No-op when the recorded cacheWrite cost already matches the TTL-aware price.
        const t1h = u.cttl?.ephemeral1h || 0
        if (t1h > 0) {
          const rates = anthropicRates(obj.message?.model, obj.timestamp)
          if (rates) {
            const w = u.cacheWrite || 0
            const correct = (Math.min(t1h, w) * 2 + Math.max(w - t1h, 0) * 1.25) * rates[0] / 1e6
            c += correct - (u.cost.cacheWrite || 0)
          }
        }
        add(counts, isoToDate(obj.timestamp), c)
      } catch {}
    }
  }
  return counts
}

const collectCostPi = () => collectCostPiFormat(join(home, ".pi", "agent", "sessions"))
const collectCostOmp = () => collectCostPiFormat(join(home, ".omp", "agent", "sessions"))

// --hours: collect hours per day from user→last assistant message time diffs
function addTurnHours(map, turnStart, turnEnd) {
  if (!turnStart || !turnEnd || turnEnd <= turnStart) return
  const hours = (turnEnd - turnStart) / 3_600_000
  add(map, new Date(turnStart).toISOString().slice(0, 10), hours)
}

async function collectTimeClaude() {
  const counts = new Map()
  const dir = join(home, ".claude", "projects")
  for (const path of await fg("*/*.jsonl", { cwd: dir })) {
    if (path.includes("/subagents/")) continue
    const text = await readFile(join(dir, path), "utf-8")
    let turnStart = null, turnEnd = null
    for (const line of text.split("\n")) {
      if (!line.includes('"timestamp"')) continue
      try {
        const obj = JSON.parse(line)
        if (obj.isSidechain) continue
        const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : null
        if (!ts) continue
        if (obj.type === "user") {
          addTurnHours(counts, turnStart, turnEnd)
          turnStart = ts
          turnEnd = null
        } else if (obj.type === "assistant" && turnStart) {
          turnEnd = ts
        }
      } catch {}
    }
    addTurnHours(counts, turnStart, turnEnd)
  }
  return counts
}

async function collectTimeCodex() {
  const counts = new Map()
  const dir = join(home, ".codex", "sessions")
  for (const path of await fg("**/*.jsonl", { cwd: dir })) {
    try {
      const rl = createInterface({ input: createReadStream(join(dir, path)), crlfDelay: Infinity })
      let turnStart = null, turnEnd = null
      for await (const line of rl) {
        if (!line.includes('"timestamp"')) continue
        try {
          const obj = JSON.parse(line)
          const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : null
          if (!ts) continue
          const pt = obj.payload?.type
          if (pt === "user_message") {
            addTurnHours(counts, turnStart, turnEnd)
            turnStart = ts
            turnEnd = null
          } else if (obj.type === "response_item" && turnStart) {
            turnEnd = ts
          }
        } catch {}
      }
      addTurnHours(counts, turnStart, turnEnd)
    } catch {}
  }
  return counts
}

async function collectVibe() {
  const counts = new Map()
  const dir = join(home, ".vibe", "logs", "session")
  for (const path of await fg("*/meta.json", { cwd: dir })) {
    try {
      const meta = JSON.parse(await readFile(join(dir, path), "utf-8"))
      const stats = meta.stats
      if (!stats) continue
      const tokens = stats.session_total_llm_tokens || 
        ((stats.session_prompt_tokens || 0) + (stats.session_completion_tokens || 0))
      if (tokens > 0 && meta.start_time) {
        const date = meta.start_time.slice(0, 10)
        add(counts, date, tokens)
      }
    } catch {}
  }
  return counts
}

async function collectTimeVibe() {
  const counts = new Map()
  const dir = join(home, ".vibe", "logs", "session")
  
  // Use session start_time and end_time from meta.json files
  for (const path of await fg("*/meta.json", { cwd: dir })) {
    try {
      const meta = JSON.parse(await readFile(join(dir, path), "utf-8"))
      if (!meta.start_time || !meta.end_time) continue
      
      const startTime = new Date(meta.start_time).getTime()
      const endTime = new Date(meta.end_time).getTime()
      
      if (startTime && endTime && endTime > startTime) {
        const hours = (endTime - startTime) / 3_600_000
        const date = meta.start_time.slice(0, 10)
        add(counts, date, hours)
      }
    } catch {}
  }
  
  return counts
}

async function collectTimeOpenCode() {
  const counts = new Map()
  const dbPath = Database ? findOpenCodeDb() : null
  if (dbPath) {
    let db
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true })
      const rows = db.prepare(`
        SELECT
          session_id as sid,
          json_extract(data, '$.role') as role,
          time_created as ts
        FROM message
        WHERE session_id IS NOT NULL
          AND time_created IS NOT NULL
        ORDER BY time_created
      `).all()
      const sessions = new Map()
      for (const row of rows) {
        if (!sessions.has(row.sid)) sessions.set(row.sid, [])
        sessions.get(row.sid).push({ role: row.role, ts: row.ts })
      }
      for (const msgs of sessions.values()) {
        let turnStart = null, turnEnd = null
        for (const m of msgs) {
          if (m.role === "user") {
            addTurnHours(counts, turnStart, turnEnd)
            turnStart = m.ts
            turnEnd = null
          } else if (m.role === "assistant" && turnStart) {
            turnEnd = m.ts
          }
        }
        addTurnHours(counts, turnStart, turnEnd)
      }
    } catch {} finally {
      db?.close()
    }
    return counts
  }
  // JSON fallback — existing logic below
  const dirs = [
    join(home, ".local", "share", "opencode", "storage", "message"),
    ...(process.platform === "darwin" ? [join(home, "Library", "Application Support", "opencode", "storage", "message")] : []),
  ]
  for (const dir of dirs) {
    const sessions = new Map()
    for (const path of await fg("ses_*/msg_*.json", { cwd: dir, suppressErrors: true })) {
      try {
        const obj = JSON.parse(await readFile(join(dir, path), "utf-8"))
        const sid = obj.sessionID
        if (!sid || !obj.time?.created) continue
        if (!sessions.has(sid)) sessions.set(sid, [])
        sessions.get(sid).push({ role: obj.role, ts: obj.time.created })
      } catch {}
    }
    for (const msgs of sessions.values()) {
      msgs.sort((a, b) => a.ts - b.ts)
      let turnStart = null, turnEnd = null
      for (const m of msgs) {
        if (m.role === "user") {
          addTurnHours(counts, turnStart, turnEnd)
          turnStart = m.ts
          turnEnd = null
        } else if (m.role === "assistant" && turnStart) {
          turnEnd = m.ts
        }
      }
      addTurnHours(counts, turnStart, turnEnd)
    }
  }
  return counts
}

async function collectTimeGemini() {
  const counts = new Map()
  const dir = join(home, ".gemini", "tmp")
  for (const path of await fg("*/chats/*.json", { cwd: dir })) {
    try {
      const obj = JSON.parse(await readFile(join(dir, path), "utf-8"))
      if (!obj.messages) continue
      let turnStart = null, turnEnd = null
      for (const msg of obj.messages) {
        if (!msg.timestamp) continue
        const ts = new Date(msg.timestamp).getTime()
        if (msg.type === "user") {
          addTurnHours(counts, turnStart, turnEnd)
          turnStart = ts
          turnEnd = null
        } else if (msg.type === "gemini" && turnStart) {
          turnEnd = ts
        }
      }
      addTurnHours(counts, turnStart, turnEnd)
    } catch {}
  }
  return counts
}

async function collectTimeAmp() {
  return new Map() // no per-message timestamps on assistant messages
}

async function collectTimePiFormat(dir) {
  const counts = new Map()
  // */*.jsonl only: subagent transcripts live deeper and their wall-clock
  // overlaps the parent turn — counting both would double-book hours
  for (const path of await fg("*/*.jsonl", { cwd: dir })) {
    const text = await readFile(join(dir, path), "utf-8")
    let turnStart = null, turnEnd = null
    for (const line of text.split("\n")) {
      if (!line.includes('"message"')) continue
      try {
        const obj = JSON.parse(line)
        if (obj.type !== "message") continue
        const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : null
        if (!ts) continue
        if (obj.message?.role === "user") {
          addTurnHours(counts, turnStart, turnEnd)
          turnStart = ts
          turnEnd = null
        } else if (obj.message?.role === "assistant" && turnStart) {
          turnEnd = ts
        }
      } catch {}
    }
    addTurnHours(counts, turnStart, turnEnd)
  }
  return counts
}

const collectTimePi = () => collectTimePiFormat(join(home, ".pi", "agent", "sessions"))
const collectTimeOmp = () => collectTimePiFormat(join(home, ".omp", "agent", "sessions"))

const tools = [
  { name: "Claude Code", collect: collectClaude, collectTime: collectTimeClaude, collectCost: collectCostClaude, color: "#f97316" },
  { name: "Codex", collect: collectCodex, collectTime: collectTimeCodex, collectCost: collectCostCodex, estOnly: true, color: "#22c55e" },
  { name: "OpenCode", collect: collectOpenCode, collectTime: collectTimeOpenCode, collectCost: collectCostOpenCode, color: "#3b82f6" },
  { name: "Gemini CLI", collect: collectGemini, collectTime: collectTimeGemini, collectCost: collectCostGemini, estOnly: true, color: "#eab308" },
  { name: "Amp", collect: collectAmp, collectTime: collectTimeAmp, collectCost: collectCostAmp, estOnly: true, color: "#a855f7" },
  { name: "Pi", collect: collectPi, collectTime: collectTimePi, collectCost: collectCostPi, color: "#ec4899" },
  { name: "Oh My Pi", collect: collectOmp, collectTime: collectTimeOmp, collectCost: collectCostOmp, color: "#14b8a6" },
  { name: "Mistral Vibe", collect: collectVibe, collectTime: collectTimeVibe, color: "#6366f1" },
]


function formatTotal(n) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "B"
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k"
  return String(n)
}

function formatHours(h) {
  if (h >= 100) return Math.round(h) + "h"
  if (h >= 10) return h.toFixed(1).replace(/\.0$/, "") + "h"
  if (h >= 1) return h.toFixed(1) + "h"
  return Math.round(h * 60) + "m"
}

function formatMoney(n) {
  if (n >= 999.5) return "$" + (n / 1000).toFixed(1).replace(/\.0$/, "") + "k"
  if (n >= 100) return "$" + Math.round(n)
  return "$" + n.toFixed(2).replace(/\.00$/, "")
}

function pickFont(candidates) {
  const have = new Set(GlobalFonts.families.map(f => f.family.toLowerCase()))
  for (const f of candidates) if (have.has(f.toLowerCase())) return f
  return "sans-serif"
}

function renderChart(allDays, results, total, { unit = "TOKENS", cmd = "npx fair-clanker-stats --share", formatVal = formatTotal } = {}) {
  const W = 1500, H = 640
  const font = pickFont(["Berkeley Mono", "SF Mono", "Menlo", "Consolas", "DejaVu Sans Mono"])
  Chart.defaults.font.family = font
  Chart.defaults.color = "#8b949e"

  const visible = results.filter(r => [...r.counts.values()].reduce((a, b) => a + b, 0) > 0)

  const datasets = visible.map(r => {
    const totalStr = formatVal([...r.counts.values()].reduce((a, b) => a + b, 0))
    return {
      label: `${r.name}  ${totalStr}`,
      data: allDays.map(d => ({ x: d, y: r.counts.get(d) || 0 })),
      backgroundColor: r.color,
      borderWidth: 0,
      barPercentage: 1,
      categoryPercentage: 1,
    }
  })

  const canvas = createCanvas(W, H)
  const bg = {
    id: "bg",
    beforeDraw: (c) => {
      const { ctx } = c
      ctx.save()
      ctx.fillStyle = "#0d1117"
      ctx.fillRect(0, 0, W, H)
      ctx.restore()
    },
  }
  const header = {
    id: "header",
    afterDraw: (c) => {
      const { ctx } = c
      ctx.save()
      // big total, right-aligned
      ctx.textAlign = "right"
      ctx.fillStyle = "#f0f6fc"
      ctx.font = `800 44px ${font}`
      ctx.fillText(formatVal(total), W - 44, 56)
      ctx.fillStyle = "#484f58"
      ctx.font = `600 15px ${font}`
      ctx.fillText(unit, W - 44, 80)
      // cmd pill, top center (header row, clear of axis labels)
      const pillW = Math.round(cmd.length * 11.5) + 44
      const pillX = (W - pillW) / 2
      ctx.fillStyle = "#161b22"
      ctx.beginPath()
      ctx.roundRect(pillX, 20, pillW, 34, 8)
      ctx.fill()
      ctx.fillStyle = "#8b949e"
      ctx.textAlign = "center"
      ctx.font = `19px ${font}`
      ctx.fillText(cmd, W / 2, 43)
      ctx.restore()
    },
  }

  const chart = new Chart(canvas, {
    type: "bar",
    data: { datasets },
    plugins: [bg, header],
    options: {
      animation: false,
      responsive: false,
      devicePixelRatio: 2,
      layout: { padding: { top: 64, bottom: 8, left: 24, right: 30 } },
      scales: {
        x: {
          type: "time",
          stacked: true,
          time: { unit: "week", isoWeekday: true, displayFormats: { week: "d MMM" } },
          grid: { color: "#161b22", tickLength: 0, offset: false },
          border: { display: false },
          ticks: {
            color: "#484f58", font: { size: 12 }, maxRotation: 0, autoSkip: false, padding: 10,
            callback: (v, i) => {
              const d = new Date(v)
              const label = `${d.getDate()} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()]}`
              return i % 2 === 0 ? label : "" // every gridline weekly, label biweekly
            },
          },
        },
        y: {
          stacked: true,
          position: "right",
          beginAtZero: true,
          grid: { color: "#21262d", tickLength: 0 },
          border: { display: false },
          ticks: { color: "#3b434b", font: { size: 12 }, maxTicksLimit: 6, padding: 8, callback: (v) => v === 0 ? "" : formatVal(v) },
        },
      },
      plugins: {
        legend: {
          position: "top",
          align: "start",
          labels: {
            color: "#8b949e",
            boxWidth: 14, boxHeight: 14, borderRadius: 3, useBorderRadius: true,
            font: { size: 15 },
            padding: 16,
          },
        },
        tooltip: { enabled: false },
      },
    },
  })

  const png = canvas.toBuffer("image/png")
  chart.destroy()
  return png
}

function openPath(target) {
  try {
    if (process.platform === "darwin") execFileSync("open", [target])
    else if (process.platform === "win32") execFileSync("cmd", ["/c", "start", "", target])
    else execFileSync("xdg-open", [target])
  } catch {}
}

async function main() {
  const args = process.argv.slice(2)
  const known = new Set(["--share", "--hours", "--cost", "--no-estimate"])
  const unknown = args.filter(a => !known.has(a))
  if (unknown.length) {
    console.error(`Unknown option${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`)
    console.error("Usage: npx fair-clanker-stats [--hours | --cost [--no-estimate]] [--share]")
    process.exit(1)
  }
  const share = args.includes("--share")
  const hours = args.includes("--hours")
  const cost = args.includes("--cost")
  const estimate = cost && !args.includes("--no-estimate")
  if (cost && hours) {
    console.error("--cost and --hours are mutually exclusive")
    process.exit(1)
  }
  estimateMode = estimate
  const fmt = cost ? formatMoney : hours ? formatHours : (n) => formatTotal(n) + " tokens"
  const results = []

  for (const tool of tools) {
    try {
      const counts = cost
        ? (tool.collectCost ? await tool.collectCost() : new Map())
        : hours ? await tool.collectTime() : await tool.collect()
      results.push({ name: tool.name, color: tool.color, counts })
      const t = [...counts.values()].reduce((a, b) => a + b, 0)
      const noData = cost && (!tool.collectCost || (tool.estOnly && !estimate))
      console.log(`${tool.name}: ${noData ? "no cost data" : fmt(t)}`)
    } catch (e) {
      console.warn(`${tool.name}: skipped (${e?.message || e})`)
      results.push({ name: tool.name, color: tool.color, counts: new Map() })
    }
  }

  const allDates = new Set()
  for (const r of results) for (const d of r.counts.keys()) allDates.add(d)
  const dates = [...allDates].sort()

  if (dates.length === 0) {
    console.error("No data found.")
    process.exit(1)
  }

  const start = new Date(dates[0])
  const end = new Date(dates[dates.length - 1])
  const allDays = []
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    allDays.push(d.toISOString().slice(0, 10))
  }

  const total = results.reduce((sum, r) => sum + [...r.counts.values()].reduce((a, b) => a + b, 0), 0)
  const chartOpts = cost
    ? { unit: estimate ? "USD (EST)" : "USD", cmd: `npx fair-clanker-stats --cost${estimate ? "" : " --no-estimate"}${share ? " --share" : ""}`, formatVal: formatMoney }
    : hours
    ? { unit: "HOURS", cmd: `npx fair-clanker-stats --hours${share ? " --share" : ""}`, formatVal: formatHours }
    : share ? {} : { cmd: "npx fair-clanker-stats" }
  console.log(`\n${allDays.length} days, ${cost || hours ? fmt(total) : formatTotal(total) + " total tokens"}`)

  const png = renderChart(allDays, results, total, chartOpts)

  const outPath = join(process.cwd(), "chart.png")
  await writeFile(outPath, png)
  console.log(`Wrote ${outPath}`)

  if (share) {
    if (process.platform === "darwin") {
      const escaped = outPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
      execFileSync("osascript", ["-e", `set the clipboard to (read (POSIX file "${escaped}") as \u00ABclass PNGf\u00BB)`])
      console.log("Image copied to clipboard")
    } else {
      console.log("Copy the image manually: " + outPath)
    }
    const visible = results.filter(r => [...r.counts.values()].reduce((a, b) => a + b, 0) > 0)
    const label = cost ? `${formatMoney(total)} spent` : hours ? `${Math.round(total)} hours` : `${formatTotal(total)} tokens`
    const flag = cost ? " --cost" : hours ? " --hours" : ""
    const text = `${label} across ${visible.length} AI coding tools\n\nnpx fair-clanker-stats${flag}`
    openPath(`https://x.com/intent/post?text=${encodeURIComponent(text)}`)
    console.log("Paste the image from your clipboard into the post")
  } else {
    openPath(outPath)
  }
}

main()
