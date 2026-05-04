// show-relay/game/game.js
// Server-authoritative game logic (ESM)

export const SYMBOLS = ["🍎","🍋","🍇","🍓","🔥","⭐","🎯","🍀","💎","🌙"]

// TASK 1 — PUPPETEER and POSITION_SWAP removed
export const SPECIALS = [
  { type: 'REVERSE',         emoji: '🔄', name: 'Reverse'         },
  { type: 'FREEZE',          emoji: '🧊', name: 'Freeze'           },
  { type: 'BLIND_SNATCH',    emoji: '🎲', name: 'Blind Snatch'     },
  { type: 'REVEALED_SNATCH', emoji: '👁',  name: 'Revealed Snatch'  },
  { type: 'STUN_GRENADE',    emoji: '💥', name: 'Stun Grenade'     },
  { type: 'VITALS',          emoji: '📊', name: 'Vitals'           },
  { type: 'SUPER_VITALS',    emoji: '⚡', name: 'Super Vitals'     },
  { type: 'NUKE',            emoji: '💣', name: 'Nuke'             },
]

export const SPECIAL_CONFIG = {
  REVERSE:        { timing: 'TURN_ONLY', consume: true, kind: 'INSTANT' },
  FREEZE:         { timing: 'ANYTIME',   consume: true, kind: 'EFFECT',             trigger: 'BEFORE_TARGET_TURN_OR_RECEIVE', expires: 'ONCE' },
  NUKE:           { timing: 'ANYTIME',   consume: true, kind: 'TARGET_SPECIAL_DESTROY' },
  BLIND_SNATCH:   { timing: 'TURN_ONLY', consume: true, kind: 'SWAP',               targetCards: 'NORMAL_HIDDEN',       ownCards: 'REVEALED' },
  REVEALED_SNATCH:{ timing: 'TURN_ONLY', consume: true, kind: 'SWAP',               targetCards: 'NORMAL_TWO_REVEALED', ownCards: 'REVEALED' },
  STUN_GRENADE:   { timing: 'ANYTIME',   consume: true, kind: 'EFFECT',             trigger: 'UNTIL_TARGET_PASS',       expires: 'AFTER_TARGET_PASS' },
  VITALS:         { timing: 'ANYTIME',   consume: true, kind: 'SNAPSHOT' },
  SUPER_VITALS:   { timing: 'ANYTIME',   consume: true, kind: 'ROUND_EFFECT',       trigger: 'AFTER_CARD_CHANGE',       expires: 'ROUND_END' },
}

// Types that are no longer valid (kept for backward compat / sanitize)
const REMOVED_SPECIAL_TYPES = new Set(['PUPPETEER', 'POSITION_SWAP'])

// ── TASK 1 — sanitizeRoom ─────────────────────────────────────────
// Remove old Puppeteer/Position Swap artefacts from rooms loaded from Redis.
export function sanitizeRoom(room) {
  if (!room) return room

  // Remove removed special cards from all player hands
  if (Array.isArray(room.players)) {
    room.players.forEach(p => {
      if (Array.isArray(p.chits)) {
        p.chits = p.chits.filter(c => {
          if (c && typeof c === 'object' && c.special === true) {
            return !REMOVED_SPECIAL_TYPES.has(c.type)
          }
          return true
        })
      }
      // Backfill stable chit ids for cards from old rooms that pre-date the id field
      if (Array.isArray(p.chits)) {
        p.chits.forEach((c, i) => {
          if (c && !c.id) c.id = chitId()
        })
      }
      // Ensure bot/online fields always exist (Task 8/9)
      if (p.online        === undefined) p.online        = true
      if (p.botActive     === undefined) p.botActive     = false
      if (p.disconnectedAt=== undefined) p.disconnectedAt= null
      if (p.isBot         === undefined) p.isBot         = false
    })
  }

  // Clear puppeteer state
  room.puppeteerInfo = null

  // Clear position swap state
  room.pendingPositionSwap = null
  room.positionSwaps       = []

  // Clear pendingAction if it relates to removed specials
  if (room.pendingAction) {
    const paType = room.pendingAction.type
    if (REMOVED_SPECIAL_TYPES.has(paType)) {
      room.pendingAction = null
      // If room was stuck in pendingSpecial because of one of these, revert
      if (room.phase === 'pendingSpecial') room.phase = 'playing'
    }
  }

  // Remove removed special effects
  if (Array.isArray(room.effects)) {
    room.effects = room.effects.filter(e => !REMOVED_SPECIAL_TYPES.has(e.type))
  }

  // Ensure mustPassNormalPlayerIdx exists (Task 2)
  if (room.mustPassNormalPlayerIdx === undefined) {
    room.mustPassNormalPlayerIdx = -1
  }

  // Ensure enabledSpecials in settings doesn't contain removed types
  if (room.settings?.enabledSpecials) {
    room.settings.enabledSpecials = room.settings.enabledSpecials.filter(
      t => !REMOVED_SPECIAL_TYPES.has(t)
    )
    if (room.settings.enabledSpecials.length === 0) {
      room.settings.enabledSpecials = SPECIALS.map(s => s.type)
    }
  }

  return room
}

// ── Helpers ──────────────────────────────────────────────────────
export function isSpecial(chit) {
  return chit && typeof chit === 'object' && chit.special === true
}
let _chitSeq = 0
function chitId() { return `c${Date.now()}_${++_chitSeq}` }

export function makeNormalChit(symbol) {
  return { id: chitId(), symbol, special: false }
}
export function makeSpecialChit(type) {
  const def = SPECIALS.find(s => s.type === type) ?? SPECIALS[0]
  return { id: chitId(), type, emoji: def.emoji, name: def.name, special: true }
}
export function isShowHand(chits = [], requiredSets = 1) {
  const normals = chits.filter(c => !isSpecial(c))
  if (normals.length < 4) return false
  const counts = {}
  normals.forEach(c => { counts[c.symbol] = (counts[c.symbol] || 0) + 1 })
  const sets = Object.values(counts).reduce((acc, v) => acc + Math.floor(v / 4), 0)
  return sets >= requiredSets
}

// ── Deck ─────────────────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export function buildNormalDeck(playerCount, normalCount = 4) {
  const totalNeeded = playerCount * normalCount
  const deck = []
  let symbolIdx = 0
  while (deck.length < totalNeeded) {
    const symbol = SYMBOLS[symbolIdx % SYMBOLS.length]
    for (let i = 0; i < 4 && deck.length < totalNeeded; i++) {
      deck.push(makeNormalChit(symbol))
    }
    symbolIdx++
  }
  return shuffle(deck)
}

// TASK 1 — buildSpecialPool never generates PUPPETEER or POSITION_SWAP
export function buildSpecialPool(playerCount, specialCount = 2, enabledSpecialTypes = SPECIALS.map(s => s.type)) {
  // Filter out removed types regardless of what caller passes
  const safeTypes = (enabledSpecialTypes.length ? enabledSpecialTypes : SPECIALS.map(s => s.type))
    .filter(t => !REMOVED_SPECIAL_TYPES.has(t))
    .filter(t => SPECIALS.some(s => s.type === t)) // must be valid/known
  const allowed = safeTypes.length ? safeTypes : SPECIALS.map(s => s.type)
  const pool = []
  for (let i = 0; i < playerCount * specialCount; i++) {
    const type = allowed[Math.floor(Math.random() * allowed.length)]
    pool.push(makeSpecialChit(type))
  }
  return shuffle(pool)
}

export function dealHands(playerCount, mode = 'special', settings = {}) {
  const normalCount  = settings.normalCount  ?? 4
  const specialCount = mode === 'normal' ? 0 : (settings.specialCount ?? 2)
  const normalDeck   = buildNormalDeck(playerCount, normalCount)
  const specialPool  = buildSpecialPool(playerCount, specialCount, settings.enabledSpecials)
  return Array.from({ length: playerCount }, () => {
    const hand = []
    for (let i = 0; i < normalCount;  i++) hand.push(normalDeck.pop())
    for (let i = 0; i < specialCount; i++) hand.push(specialPool.pop())
    return hand
  })
}

// ── Factories ─────────────────────────────────────────────────────
// TASK 8/9 — makePlayer includes online/bot fields
export function makePlayer(id, name, colorIdx, { isBot = false } = {}) {
  return {
    id, name, color: colorIdx, score: 0,
    chits: [], isShow: false, frozen: false, stunned: false,
    originalIdx: colorIdx,
    // Bot/connection tracking
    online:         !isBot ? true : true,  // bots start online
    botActive:      isBot,
    disconnectedAt: null,
    isBot,
  }
}

export function makeRoom(code, host) {
  return {
    code, phase: 'lobby', round: 1,
    currentTurn: 0, direction: 1,
    showCaller: -1, hostId: host.id,
    players: [host], showClicks: [],
    frozenPlayer: -1,
    stunnedPlayer: -1,
    // TASK 1 — removed puppeteerInfo, positionSwaps, pendingPositionSwap
    pendingAction: null,
    mode: 'special',
    superVitalsUsed: false,
    effects: [],
    superVitalsAlert: null,
    // TASK 2 — mustPassNormalPlayerIdx
    mustPassNormalPlayerIdx: -1,
    settings: {
      normalCount: 4,
      specialCount: 2,
      enabledSpecials: SPECIALS.map(s => s.type),
    },
  }
}

// ── Internal helpers ──────────────────────────────────────────────
function nextPlayer(room, fromIdx, skipFrozen = false) {
  const n    = room.players.length
  let next   = (fromIdx + room.direction + n) % n
  if (skipFrozen && next === room.frozenPlayer) {
    next = (next + room.direction + n) % n
  }
  return next
}

function removeSpecial(player, type, chitIdx) {
  if (chitIdx != null && player.chits[chitIdx] && isSpecial(player.chits[chitIdx]) && player.chits[chitIdx].type === type) {
    player.chits.splice(chitIdx, 1)
    return
  }
  const idx = player.chits.findIndex(c => isSpecial(c) && c.type === type)
  if (idx !== -1) player.chits.splice(idx, 1)
}

function makeEffect(type, ownerIdx, targetIdx, trigger, expires, data = {}) {
  return { id: Date.now() + Math.random(), type, ownerIdx, targetIdx, trigger, expires, data }
}

function resolveActorHandOwner(room, action) {
  // TASK 1 — Puppeteer control removed; always use direct actor resolution
  const idx = action.actorIdx ?? action.playerIdx ?? 0
  return { actorIdx: idx, handOwnerIdx: action.handOwnerIdx ?? idx, isPuppeteerControl: false }
}

function hasSpecial(player, type, chitIdx) {
  if (chitIdx != null && player.chits[chitIdx] && isSpecial(player.chits[chitIdx]) && player.chits[chitIdx].type === type) return true
  return player.chits.some(c => isSpecial(c) && c.type === type)
}

function consumeSpecial(room, handOwnerIdx, type, chitIdx) {
  removeSpecial(room.players[handOwnerIdx], type, chitIdx)
}

function validateSpecialUse(room, action, specialType, actorIdx, handOwnerIdx) {
  const cfg = SPECIAL_CONFIG[specialType]
  if (!cfg) return false
  if (!room.players[handOwnerIdx]) return false
  if (!hasSpecial(room.players[handOwnerIdx], specialType, action.chitIdx)) return false
  if (cfg.timing === 'TURN_ONLY' && handOwnerIdx !== room.currentTurn) return false
  return true
}

function checkSuperVitals(room) {
  const svEffect = (room.effects ?? []).find(e => e.type === 'SUPER_VITALS')
  if (!svEffect) return
  const requiredSets = room.settings?.normalCount === 8 ? 2 : 1
  room.players.forEach((p, i) => {
    if (!isShowHand(p.chits, requiredSets)) return
    const sig = `${i}:show`
    if (svEffect.data.alerted[sig]) return
    svEffect.data.alerted[sig] = true
    room.superVitalsAlert = {
      id: Date.now() + Math.random(),
      ownerIdx: svEffect.ownerIdx,
      matchingPlayerIdx: i,
      message: `${p.name} can call SHOW!`,
      timestamp: Date.now(),
    }
  })
}

function runEffects(room, trigger, context, log) {
  if (!room.effects) room.effects = []
  const toRemove = []

  // TASK 1 — POSITION_SWAP and PUPPETEER effect handling removed

  if (trigger === 'AFTER_TARGET_PASS') {
    const { passedPlayerIdx } = context
    room.effects.forEach(e => {
      if (e.type === 'STUN_GRENADE' && e.targetIdx === passedPlayerIdx) {
        room.stunnedPlayer = -1
        if (room.players[passedPlayerIdx]) room.players[passedPlayerIdx].stunned = false
        toRemove.push(e.id)
      }
    })
  }

  if (trigger === 'AFTER_CARD_CHANGE') {
    checkSuperVitals(room)
  }

  room.effects = room.effects.filter(e => !toRemove.includes(e.id))
}

// ── TASK 10 — remap player indexes after removal ──────────────────
export function remapPlayerIndexes(room, removedIndexes) {
  if (!removedIndexes || removedIndexes.length === 0) return

  // Build index mapping: old → new
  const indexMap = {}
  let newIdx = 0
  for (let i = 0; i < room.players.length + removedIndexes.length; i++) {
    if (!removedIndexes.includes(i)) {
      indexMap[i] = newIdx++
    }
  }

  const remap = idx => (idx === -1 ? -1 : (indexMap[idx] ?? -1))

  room.currentTurn   = remap(room.currentTurn)
  room.frozenPlayer  = remap(room.frozenPlayer)
  room.stunnedPlayer = remap(room.stunnedPlayer)
  room.showCaller    = remap(room.showCaller)

  if (Array.isArray(room.showClicks)) {
    room.showClicks = room.showClicks
      .filter(c => !removedIndexes.includes(c.playerIdx))
      .map(c => ({ ...c, playerIdx: remap(c.playerIdx) }))
  }

  if (room.pendingAction) {
    if (typeof room.pendingAction.userIdx      === 'number') room.pendingAction.userIdx      = remap(room.pendingAction.userIdx)
    if (typeof room.pendingAction.handOwnerIdx === 'number') room.pendingAction.handOwnerIdx = remap(room.pendingAction.handOwnerIdx)
    if (typeof room.pendingAction.targetIdx    === 'number') room.pendingAction.targetIdx    = remap(room.pendingAction.targetIdx)
  }

  if (Array.isArray(room.effects)) {
    room.effects = room.effects.map(e => ({
      ...e,
      ownerIdx:  remap(e.ownerIdx),
      targetIdx: remap(e.targetIdx),
    }))
  }

  if (typeof room.mustPassNormalPlayerIdx === 'number') {
    room.mustPassNormalPlayerIdx = remap(room.mustPassNormalPlayerIdx)
  }
}

// ── TASK 10 — removeDisconnectedBots ─────────────────────────────
// Called at ROUND_END to remove bot-takeover players who never returned.
export function removeDisconnectedBots(room) {
  // Find players who are offline, have bot active, and are NOT a permanent bot
  const toRemove = []
  room.players.forEach((p, i) => {
    if (!p.online && p.botActive && !p.isBot) {
      toRemove.push(i)
    }
  })

  if (toRemove.length === 0) return room

  remapPlayerIndexes(room, toRemove)
  room.players = room.players.filter((_, i) => !toRemove.includes(i))

  return room
}

// ── Pure reducer ──────────────────────────────────────────────────
export function applyAction(room, logs, action) {
  const r  = JSON.parse(JSON.stringify(room))
  if (!r.effects) r.effects = []
  // Ensure mustPassNormalPlayerIdx exists
  if (r.mustPassNormalPlayerIdx === undefined) r.mustPassNormalPlayerIdx = -1
  const lg = [...logs]
  const log = m => lg.unshift(m)

  switch (action.type) {

    case 'SET_MODE': { r.mode = action.mode; break }

    case 'SET_HAND_SETUP': {
      if (r.phase !== 'lobby') break
      const { normalCount, specialCount } = action
      const valid = (normalCount === 4 && specialCount === 2) || (normalCount === 8 && specialCount === 4)
      if (!valid) break
      if (!r.settings) r.settings = {}
      r.settings.normalCount  = normalCount
      r.settings.specialCount = specialCount
      break
    }

    case 'SET_ENABLED_SPECIALS': {
      if (r.phase !== 'lobby') break
      const { enabledSpecials } = action
      if (!Array.isArray(enabledSpecials) || enabledSpecials.length === 0) break
      const validTypes = SPECIALS.map(s => s.type)
      const filtered   = enabledSpecials.filter(t => validTypes.includes(t) && !REMOVED_SPECIAL_TYPES.has(t))
      if (filtered.length === 0) break
      if (!r.settings) r.settings = {}
      r.settings.enabledSpecials = filtered
      break
    }

    case 'START': {
      const hands = dealHands(r.players.length, r.mode, r.settings)
      r.players = r.players.map((p, i) => ({
        ...p, chits: hands[i], isShow: false,
        frozen: false, stunned: false, originalIdx: i,
        online: p.online ?? true, botActive: p.isBot ? true : (p.botActive ?? false),
        disconnectedAt: null,
      }))
      r.phase = 'playing'; r.round = 1; r.currentTurn = 0
      r.direction = 1; r.showCaller = -1; r.showClicks = []
      r.frozenPlayer = -1; r.stunnedPlayer = -1
      // TASK 1 — removed puppeteerInfo, positionSwaps, pendingPositionSwap
      r.pendingAction = null
      r.superVitalsUsed = false
      r.effects = []; r.superVitalsAlert = null; r.roundResults = null
      // TASK 2 — reset mustPassNormalPlayerIdx
      r.mustPassNormalPlayerIdx = -1
      log(`Round 1 started! ${r.players[0].name}'s turn.`)
      break
    }

    case 'PASS': {
      const { handOwnerIdx } = resolveActorHandOwner(r, action)
      const pi = handOwnerIdx
      if (pi !== r.currentTurn) break

      // TASK 2 — enforce mustPassNormal on server
      if (r.mustPassNormalPlayerIdx === pi) {
        const chit = r.players[pi].chits[action.chitIdx]
        if (!chit || isSpecial(chit)) break // must pass a normal card
      }

      const ni = nextPlayer(r, pi, r.frozenPlayer !== -1)
      const [chit] = r.players[pi].chits.splice(action.chitIdx, 1)
      r.players[ni].chits.push(chit)

      r.currentTurn = ni
      r.frozenPlayer = -1
      r.players.forEach(p => { p.frozen = false })
      r.effects = r.effects.filter(e => e.type !== 'FREEZE')

      // TASK 2 — clear mustPassNormal after successful pass
      if (r.mustPassNormalPlayerIdx === pi) {
        r.mustPassNormalPlayerIdx = -1
      }

      log(`${r.players[pi].name} passed a chit to ${r.players[ni].name}.`)

      runEffects(r, 'AFTER_TARGET_PASS', { passedPlayerIdx: pi }, log)
      runEffects(r, 'AFTER_CARD_CHANGE', {},                      log)
      break
    }

    case 'USE_REVERSE': {
      const { actorIdx, handOwnerIdx } = resolveActorHandOwner(r, action)
      if (!validateSpecialUse(r, action, 'REVERSE', actorIdx, handOwnerIdx)) break
      consumeSpecial(r, handOwnerIdx, 'REVERSE', action.chitIdx)
      r.direction *= -1
      log(`🔄 ${r.players[actorIdx].name} played Reverse! Direction flipped.`)
      break
    }

    case 'USE_FREEZE': {
      const { actorIdx, handOwnerIdx } = resolveActorHandOwner(r, action)
      if (!validateSpecialUse(r, action, 'FREEZE', actorIdx, handOwnerIdx)) break
      consumeSpecial(r, handOwnerIdx, 'FREEZE', action.chitIdx)
      r.pendingAction = { type: 'FREEZE', userIdx: actorIdx, handOwnerIdx }
      r.phase = 'pendingSpecial'
      log(`🧊 ${r.players[actorIdx].name} plays Freeze!`)
      break
    }

    case 'FREEZE_PICK': {
      const { userIdx } = r.pendingAction
      const targetIdx   = action.targetIdx
      r.frozenPlayer    = targetIdx
      r.players[targetIdx].frozen = true
      r.effects.push(makeEffect('FREEZE', userIdx, targetIdx, 'BEFORE_TARGET_TURN_OR_RECEIVE', 'ONCE'))
      r.pendingAction = null
      r.phase = 'playing'
      log(`🧊 ${r.players[userIdx].name} froze ${r.players[targetIdx].name}!`)
      break
    }

    case 'USE_BLIND_SNATCH': {
      const { actorIdx, handOwnerIdx } = resolveActorHandOwner(r, action)
      if (!validateSpecialUse(r, action, 'BLIND_SNATCH', actorIdx, handOwnerIdx)) break
      consumeSpecial(r, handOwnerIdx, 'BLIND_SNATCH', action.chitIdx)
      r.pendingAction = { type: 'BLIND_SNATCH', userIdx: actorIdx, handOwnerIdx }
      r.phase = 'pendingSpecial'
      log(`🎲 ${r.players[actorIdx].name} plays Blind Snatch!`)
      // TASK 2 — after snatch the player must pass a normal
      r.mustPassNormalPlayerIdx = actorIdx
      break
    }

    case 'BLIND_SNATCH_PICK': {
      const { userIdx } = r.pendingAction
      const targetIdx   = action.targetIdx
      r.pendingAction = { ...r.pendingAction, targetIdx }
      r.phase = 'blindSnatchPicking'
      log(`🎲 ${r.players[userIdx].name} picks from ${r.players[targetIdx].name}…`)
      break
    }

    case 'BLIND_SNATCH_PICK_CARD': {
      const { userIdx, handOwnerIdx: hoIdx, targetIdx } = r.pendingAction
      const ho  = hoIdx ?? userIdx
      const tci = action.targetCardIdx
      const oci = action.ownCardIdx
      const targetCard = r.players[targetIdx]?.chits[tci]
      const ownCard    = r.players[ho]?.chits[oci]
      if (!targetCard || isSpecial(targetCard) || !ownCard) break
      r.players[targetIdx].chits[tci] = ownCard
      r.players[ho].chits[oci]        = targetCard
      log(`🎲 ${r.players[userIdx].name} blind-snatched from ${r.players[targetIdx].name}!`)
      runEffects(r, 'AFTER_CARD_CHANGE', {}, log)
      r.pendingAction = null; r.phase = 'playing'
      break
    }

    case 'USE_REVEALED_SNATCH': {
      const { actorIdx, handOwnerIdx } = resolveActorHandOwner(r, action)
      if (!validateSpecialUse(r, action, 'REVEALED_SNATCH', actorIdx, handOwnerIdx)) break
      consumeSpecial(r, handOwnerIdx, 'REVEALED_SNATCH', action.chitIdx)
      r.pendingAction = { type: 'REVEALED_SNATCH', userIdx: actorIdx, handOwnerIdx }
      r.phase = 'pendingSpecial'
      log(`👁 ${r.players[actorIdx].name} plays Revealed Snatch!`)
      // TASK 2 — after snatch the player must pass a normal
      r.mustPassNormalPlayerIdx = actorIdx
      break
    }

    case 'REVEALED_SNATCH_PICK_TARGET': {
      const { userIdx } = r.pendingAction
      const targetIdx   = action.targetIdx
      const normals     = r.players[targetIdx].chits
        .map((c, i) => ({ c, i })).filter(({ c }) => !isSpecial(c))
      const revealed2   = shuffle([...normals]).slice(0, 2)
      r.pendingAction   = { ...r.pendingAction, targetIdx, revealedOptions: revealed2, step: 'picking' }
      r.phase = 'revealedSnatchPicking'
      log(`👁 ${r.players[userIdx].name} sees 2 of ${r.players[targetIdx].name}'s chits!`)
      break
    }

    case 'REVEALED_SNATCH_PICK_CHIT': {
      const { userIdx, handOwnerIdx: hoIdx, targetIdx } = r.pendingAction
      const ho  = hoIdx ?? userIdx
      const tci = action.targetCardIdx ?? action.chitIdx
      const oci = action.ownCardIdx
      const targetCard = r.players[targetIdx]?.chits[tci]
      const ownCard    = r.players[ho]?.chits[oci]
      if (!targetCard || isSpecial(targetCard) || !ownCard) break
      r.players[targetIdx].chits[tci] = ownCard
      r.players[ho].chits[oci]        = targetCard
      log(`👁 ${r.players[userIdx].name} snatched a revealed chit from ${r.players[targetIdx].name}!`)
      runEffects(r, 'AFTER_CARD_CHANGE', {}, log)
      r.pendingAction = null; r.phase = 'playing'
      break
    }

    case 'USE_STUN_GRENADE': {
      const { actorIdx, handOwnerIdx } = resolveActorHandOwner(r, action)
      if (!validateSpecialUse(r, action, 'STUN_GRENADE', actorIdx, handOwnerIdx)) break
      consumeSpecial(r, handOwnerIdx, 'STUN_GRENADE', action.chitIdx)
      r.pendingAction = { type: 'STUN_GRENADE', userIdx: actorIdx, handOwnerIdx }
      r.phase = 'pendingSpecial'
      log(`💥 ${r.players[actorIdx].name} throws a Stun Grenade!`)
      break
    }

    case 'STUN_GRENADE_PICK': {
      const { userIdx } = r.pendingAction
      const targetIdx   = action.targetIdx
      r.stunnedPlayer   = targetIdx
      r.players[targetIdx].stunned = true
      r.effects.push(makeEffect('STUN_GRENADE', userIdx, targetIdx, 'UNTIL_TARGET_PASS', 'AFTER_TARGET_PASS'))
      r.pendingAction = null; r.phase = 'playing'
      log(`💥 ${r.players[targetIdx].name} is stunned! Chits hidden!`)
      break
    }

    case 'USE_NUKE': {
      const { actorIdx, handOwnerIdx } = resolveActorHandOwner(r, action)
      if (!validateSpecialUse(r, action, 'NUKE', actorIdx, handOwnerIdx)) break
      consumeSpecial(r, handOwnerIdx, 'NUKE', action.chitIdx)
      r.pendingAction = { type: 'NUKE', userIdx: actorIdx, handOwnerIdx }
      r.phase = 'pendingSpecial'
      log(`💣 ${r.players[actorIdx].name} launches a Nuke!`)
      break
    }

    case 'NUKE_PICK_TARGET': {
      const targetIdx   = action.targetIdx
      r.pendingAction   = { ...r.pendingAction, targetIdx, step: 'pickingCard' }
      r.phase = 'nukePicking'
      break
    }

    case 'NUKE_PICK_CARD': {
      const { userIdx, targetIdx } = r.pendingAction
      const card = r.players[targetIdx]?.chits[action.chitIdx]
      if (!card || !isSpecial(card)) break
      r.players[targetIdx].chits.splice(action.chitIdx, 1)
      log(`💣 ${r.players[userIdx].name} nuked ${card.name} from ${r.players[targetIdx].name}!`)
      r.pendingAction = null; r.phase = 'playing'
      break
    }

    // TASK 1 — USE_PUPPETEER, PUPPETEER_PICK, USE_POSITION_SWAP, POSITION_SWAP_PICK
    // are intentionally removed. If old clients send these, we silently ignore.
    case 'USE_PUPPETEER':
    case 'PUPPETEER_PICK':
    case 'USE_POSITION_SWAP':
    case 'POSITION_SWAP_PICK': {
      // Do nothing — these cards are removed
      break
    }

    case 'SHOW': {
      const ci = action.playerIdx
      r.showCaller  = ci; r.phase = 'showWindow'
      r.showClicks  = [{ playerIdx: ci, timestamp: action.timestamp }]
      r.showWindowEnd = action.timestamp + 5000
      log(`🎉 ${r.players[ci].name} called SHOW!`)
      break
    }

    case 'SHOW_JOIN': {
      if (r.phase !== 'showWindow') break
      if (r.showClicks.find(c => c.playerIdx === action.playerIdx)) break
      r.showClicks.push({ playerIdx: action.playerIdx, timestamp: action.timestamp })
      log(`${r.players[action.playerIdx].name} joined the show!`)
      break
    }

    case 'SHOW_RESOLVE': {
      const n    = r.players.length
      const base = (n + 2) * 10
      const sorted      = [...r.showClicks].sort((a, b) => a.timestamp - b.timestamp)
      const clickedIdxs = sorted.map(c => c.playerIdx)
      const requiredShowSets = r.settings?.normalCount === 8 ? 2 : 1
      const roundPts    = {}
      r.players = r.players.map((p, i) => {
        const pos = clickedIdxs.indexOf(i)
        const pts = pos >= 0 ? Math.max(0, base - pos * 10) : 0
        roundPts[i] = pts
        log(`${p.name}: ${pts > 0 ? '+' : ''}${pts} pts`)
        return { ...p, score: p.score + pts, isShow: isShowHand(p.chits, requiredShowSets) }
      })
      r.roundResults = r.players.map((p, i) => ({
        playerIdx:   i,
        name:        p.name,
        chits:       p.chits,
        isShow:      p.isShow,
        score:       p.score,
        roundPoints: roundPts[i] ?? 0,
      }))
      r.phase = 'afterShow'; break
    }

    case 'USE_VITALS': {
      const { actorIdx, handOwnerIdx } = resolveActorHandOwner(r, action)
      if (!validateSpecialUse(r, action, 'VITALS', actorIdx, handOwnerIdx)) break
      consumeSpecial(r, handOwnerIdx, 'VITALS', action.chitIdx)
      log('📊 ' + r.players[actorIdx].name + ' used Vitals!')
      break
    }

    case 'USE_SUPER_VITALS': {
      const { actorIdx, handOwnerIdx } = resolveActorHandOwner(r, action)
      if (!validateSpecialUse(r, action, 'SUPER_VITALS', actorIdx, handOwnerIdx)) break
      if (r.effects.some(e => e.type === 'SUPER_VITALS')) break
      consumeSpecial(r, handOwnerIdx, 'SUPER_VITALS', action.chitIdx)
      r.effects.push(makeEffect('SUPER_VITALS', actorIdx, -1, 'AFTER_CARD_CHANGE', 'ROUND_END', { alerted: {} }))
      r.superVitalsUsed = true
      log('⚡ ' + r.players[actorIdx].name + ' activated Super Vitals!')
      runEffects(r, 'AFTER_CARD_CHANGE', {}, log)
      break
    }

    case 'ROUND_END': {
      // TASK 1 — positionSwaps unwind removed
      // TASK 10 — remove disconnected bot-takeover players
      removeDisconnectedBots(r)
      r.effects = r.effects.filter(e => e.expires !== 'ROUND_END')
      r.superVitalsAlert = null
      // TASK 2 — reset mustPassNormal
      r.mustPassNormalPlayerIdx = -1
      r.phase = 'roundEnd'; break
    }

    case 'NEXT_ROUND': {
      const hands = dealHands(r.players.length, r.mode, r.settings)
      r.players = r.players.map((p, i) => ({
        ...p, chits: hands[i], isShow: false, frozen: false, stunned: false,
        botActive: p.isBot ? true : false,
        disconnectedAt: null,
      }))
      r.phase = 'playing'; r.round += 1; r.currentTurn = 0
      r.direction = 1; r.showCaller = -1; r.showClicks = []
      r.frozenPlayer = -1; r.stunnedPlayer = -1
      // TASK 1 — removed puppeteerInfo, positionSwaps, pendingPositionSwap
      r.pendingAction = null
      r.superVitalsUsed = false
      r.effects = []; r.superVitalsAlert = null; r.roundResults = null
      // TASK 2 — reset mustPassNormal
      r.mustPassNormalPlayerIdx = -1
      log('─── Round ' + r.round + ' started! ' + r.players[0].name + "'s turn. ───")
      break
    }

    case 'END_GAME': {
      r.phase = 'ended'
      r.mustPassNormalPlayerIdx = -1
      const w = [...r.players].sort((a, b) => b.score - a.score)[0]
      log('🏆 Game over! ' + w.name + ' wins with ' + w.score + ' pts!')
      break
    }

    case 'PLAY_AGAIN': {
      r.players = r.players.map(p => ({
        ...p, score: 0, chits: [], isShow: false, frozen: false, stunned: false,
        botActive: p.isBot ? true : false, disconnectedAt: null,
      }))
      r.phase = 'lobby'; r.round = 1; r.currentTurn = 0
      r.direction = 1; r.showCaller = -1; r.showClicks = []
      r.frozenPlayer = -1; r.stunnedPlayer = -1
      // TASK 1 — removed puppeteerInfo, positionSwaps, pendingPositionSwap
      r.pendingAction = null
      r.superVitalsUsed = false
      r.effects = []; r.superVitalsAlert = null; r.roundResults = null
      // TASK 2 — reset mustPassNormal
      r.mustPassNormalPlayerIdx = -1
      break
    }
  }

  return { room: r, logs: lg.slice(0, 80) }
}

// ── Server wrapper — resolves playerIdx from authenticated playerId ──
// TASK 3 — returns { room, logs, error } always
export function applyServerAction(room, logs, action, playerId) {
  // Special system actions that don't require a player match
  const systemActions = new Set(['SHOW_RESOLVE', 'ROUND_END'])
  if (!systemActions.has(action.type)) {
    const playerIdx = room.players.findIndex(p => p.id === playerId)
    if (playerIdx === -1) {
      return { room, logs, error: 'Player not in room' }
    }

    const safeAction = {
      ...action,
      actorIdx:     playerIdx,
      playerIdx:    action.playerIdx    ?? playerIdx,
      handOwnerIdx: action.handOwnerIdx ?? action.playerIdx ?? playerIdx,
    }

    return applyAction(room, logs, safeAction)
  }

  // System actions (timers etc.) — apply directly
  return applyAction(room, logs, action)
}