/* =========================================================
   FREE BLATRO  —  FreeCell Roguelike
   Combines standard FreeCell solitaire with Balatro-style
   scoring, jokers, ante progression, and economy.
   ========================================================= */

(function(){
'use strict';

/* ---------------------------------------------------------
   1. CONSTANTS
   --------------------------------------------------------- */
const SUITS     = ['S','H','D','C'];
const SUIT_SYM  = { S:'♠', H:'♥', D:'♦', C:'♣' };
const SUIT_NAME = { S:'Spades', H:'Hearts', D:'Diamonds', C:'Clubs' };
const RANK_LABEL = { 1:'A', 2:'2', 3:'3', 4:'4', 5:'5', 6:'6', 7:'7',
                     8:'8', 9:'9',10:'10',11:'J',12:'Q',13:'K' };
const TOTAL_CARDS = 52;
const TABLEAU_COLS = 8;
const FREE_CELL_COLS = 4;
const FOUNDATION_COLS = 4;
const MAX_JOKERS = 5;

/* Ante targets: [small, big, boss] per ante (1-indexed) */
const ANTE_TARGETS = [
  null,
  [300, 450, 700],    // Ante 1
  [500, 700, 1100],   // Ante 2
  [800, 1100, 1700],  // Ante 3
  [1200, 1700, 2600], // Ante 4
  [1800, 2500, 3800], // Ante 5
  [2600, 3600, 5500], // Ante 6
  [3800, 5200, 8000], // Ante 7
  [5500, 7500, 12000] // Ante 8
];
const BLIND_NAMES = ['Small Blind', 'Big Blind', 'Boss Blind'];
const BOSS_NAMES  = [null, null, 'The Goad', 'The Wall', 'The Needle',
                     'The Flint', 'The Water', 'The Wheel', 'The Eye'];
const BOSS_EFFECTS = [ // functions returning effect description
  null, null,
  ()=>'Red cards give max(1, chips−2)',
  ()=>'Black cards give max(1, chips−2)',
  ()=>'−1 Free Cell',
  ()=>'Score target ×1.5',
  ()=>'Mult bonuses halved (round down)',
  ()=>'Only 4 joker slots',
  ()=>'Card chip values halved (round up)'
];
const BLIND_REWARDS = [null, [3,5,8], [4,6,10], [5,7,12], [6,9,14],
                       [7,10,16], [8,12,18], [9,13,20], [10,15,22]];

/* ---------------------------------------------------------
   2. SEEDED RNG  (Mulberry32)
   --------------------------------------------------------- */
function mulberry32(a) {
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------------------------------
   3. DECK UTILITIES
   --------------------------------------------------------- */
function createCard(suit, rank) {
  return { suit, rank, id: suit + rank };
}
function createDeck() {
  const deck = [];
  for (const s of SUITS)
    for (let r = 1; r <= 13; r++)
      deck.push(createCard(s, r));
  return deck;
}
function shuffleDeck(deck, seed) {
  const rng = mulberry32(seed);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
function dealColumns(deck) {
  const cols = Array.from({length: TABLEAU_COLS}, () => []);
  let ptr = 0;
  // 7 cards in cols 0-3, 6 in cols 4-7
  for (let r = 0; r < 7; r++)
    for (let c = 0; c < TABLEAU_COLS; c++)
      if (r < 6 || c < 4)
        cols[c].push(deck[ptr++]);
  return cols;
}

/* ---------------------------------------------------------
   4. GAME STATE
   --------------------------------------------------------- */
let G = null;  // current game state; setGame() to replace

function makeState() {
  return {
    // meta
    phase: 'playing',       // 'playing' | 'blind-done' | 'shop' | 'won' | 'lost'
    // run
    ante: 1,
    blindIdx: 0,            // 0=small, 1=big, 2=boss
    money: 4,
    redeals: 3,
    seed: Date.now(),       // base seed; per-blind seed derived
    // board
    tableau: [],
    freecells: Array(FREE_CELL_COLS).fill(null),
    foundations: Array.from({length: FOUNDATION_COLS}, () => []),
    // interaction
    selected: null,         // { src:'tableau'|'freecell', col, idx } or null
    undoStack: [],
    // scoring
    score: 0,
    blindTarget: 450,
    totalScore: 0,          // across all blinds
    // jokers
    jokers: [],
    // consumables (future)
    // history
    cardsScored: 0,
  };
}

function getBlindTarget(ante, blindIdx) {
  const row = ANTE_TARGETS[ante] || ANTE_TARGETS[8];
  return row ? row[blindIdx] || 700 : 700;
}
function getBlindReward(ante, blindIdx) {
  const row = BLIND_REWARDS[ante] || BLIND_REWARDS[8];
  return row ? row[blindIdx] || 8 : 8;
}
function getBossEffect(ante) {
  return ante > 1 && ante <= 8 ? BOSS_EFFECTS[ante] : null;
}
function getBossName(ante) {
  return ante > 1 && ante <= 8 ? BOSS_NAMES[ante] : null;
}
function isBossBlind(blindIdx) { return blindIdx === 2; }

/* ---------------------------------------------------------
   5. FREECELL RULES
   ---------------------------------------------------------- */
// --- legality checks ---
function canPlaceOnFoundation(card, foundation) {
  if (foundation.length === 0) return card.rank === 1; // Ace
  const top = foundation[foundation.length - 1];
  return card.suit === top.suit && card.rank === top.rank + 1;
}
function canPlaceOnTableau(card, col) {
  if (col.length === 0) return true;
  const top = col[col.length - 1];
  // alternating colour  (S/C are black, H/D are red)
  const cardColour = (card.suit === 'S' || card.suit === 'C') ? 'black' : 'red';
  const topColour  = (top.suit === 'S' || top.suit === 'C') ? 'black' : 'red';
  return cardColour !== topColour && card.rank === top.rank - 1;
}
function canPlaceOnFreeCell(freecells, idx, card) {
  return freecells[idx] === null;
}

// --- sequence helpers ---
function getSequenceLength(col) {
  // longest descending alternating-colour run from bottom
  if (col.length === 0) return 0;
  let len = 1;
  for (let i = col.length - 1; i > 0; i--) {
    const cur = col[i], prev = col[i-1];
    const curColour = (cur.suit === 'S' || cur.suit === 'C') ? 'black' : 'red';
    const prevColour = (prev.suit === 'S' || prev.suit === 'C') ? 'black' : 'red';
    if (curColour === prevColour) break;
    if (prev.rank !== cur.rank + 1) break;
    len++;
  }
  return len;
}

function maxMoveCapacity(state) {
  const emptyFree = state.freecells.filter(c => c === null).length;
  const emptyCols = state.tableau.filter(col => col.length === 0).length;
  return (1 + emptyFree) * Math.pow(2, emptyCols);
}

// pointer to boss-blind mod
function effectiveFreeCells(state) {
  let max = FREE_CELL_COLS;
  for (const j of state.jokers) {
    if (j.id === 'double_up') max--;
  }
  if (state.ante === 4 && state.blindIdx === 2) max--; // The Needle
  return Math.max(0, max);
}

function effectiveJokerSlots(state) {
  if (state.ante === 7 && state.blindIdx === 2) return 4; // The Wheel
  return MAX_JOKERS;
}

/* ---------------------------------------------------------
   6. JOKER DEFINITIONS
   --------------------------------------------------------- */
const JOKER_IDS = [
  { id:'free_cell',  name:'Free Cell Joker',  desc:'+3 Mult for each empty Free Cell',
    cost:4, rarity:'common', shopWeight:3 },
  { id:'banner',     name:'Banner',           desc:'+30 Chips for each empty tableau column',
    cost:4, rarity:'common', shopWeight:3 },
  { id:'greedy',     name:'Greedy Joker',     desc:'+4 Mult. ♣ score +4 additional Mult',
    cost:5, rarity:'common', shopWeight:3 },
  { id:'lusty',      name:'Lusty Joker',      desc:'♥ cards score +3 Mult',
    cost:4, rarity:'common', shopWeight:3 },
  { id:'wrathful',   name:'Wrathful Joker',   desc:'♠ cards score +3 Mult',
    cost:4, rarity:'common', shopWeight:3 },
  { id:'gluttonous', name:'Gluttonous Joker', desc:'♦ cards score +3 Mult',
    cost:4, rarity:'common', shopWeight:3 },
  { id:'scholar',    name:'Scholar',           desc:'Aces score +20 Chips and +4 Mult',
    cost:5, rarity:'common', shopWeight:2 },
  { id:'ceremonial', name:'Ceremonial Joker', desc:'+1 Mult for each card in foundations',
    cost:6, rarity:'uncommon', shopWeight:2 },
  { id:'double_up',  name:'Double Up',         desc:'×1.5 Mult, −1 Free Cell',
    cost:7, rarity:'uncommon', shopWeight:1 },
  { id:'fortune',    name:'Fortune Joker',    desc:'+1 Mult for each $3 (rounds down)',
    cost:6, rarity:'uncommon', shopWeight:2 },
  { id:'stockpile',  name:'Stockpile Joker',  desc:'+2 Mult for each card in Free Cells',
    cost:5, rarity:'common', shopWeight:2 },
  { id:'blueprint',  name:'Blueprint',         desc:'Copies the joker to its left',
    cost:8, rarity:'rare', shopWeight:1 },
];

const JOKER_MAP = Object.fromEntries(JOKER_IDS.map(j => [j.id, j]));

// --- joker evaluation ---
// Returns { addChips, addMult, multMult } for a given score event.
function evalJoker(jokerId, state, card, idx) {
  const emptyFree = state.freecells.filter(c => c === null).length;
  const emptyCols = state.tableau.filter(col => col.length === 0).length;
  const foundTotal = state.foundations.reduce((s,f) => s + f.length, 0);
  const cellsBusy  = state.freecells.filter(c => c !== null).length;

  switch (jokerId) {
    case 'free_cell':
      return { addMult: 3 * emptyFree };
    case 'banner':
      return { addChips: 30 * emptyCols };
    case 'greedy': {
      let a = 4;
      if (card && card.suit === 'C') a += 4;
      return { addMult: a };
    }
    case 'lusty':
      if (card && card.suit === 'H') return { addMult: 3 };
      return {};
    case 'wrathful':
      if (card && card.suit === 'S') return { addMult: 3 };
      return {};
    case 'gluttonous':
      if (card && card.suit === 'D') return { addMult: 3 };
      return {};
    case 'scholar':
      if (card && card.rank === 1) return { addChips: 20, addMult: 4 };
      return {};
    case 'ceremonial':
      return { addMult: foundTotal };
    case 'double_up':
      return { multMult: 1.5 };
    case 'fortune':
      return { addMult: Math.floor(state.money / 3) };
    case 'stockpile':
      return { addMult: 2 * cellsBusy };
    case 'blueprint': {
      if (idx <= 0) return {};
      const left = state.jokers[idx - 1];
      if (!left || left.id === 'blueprint') return {};
      return evalJoker(left.id, state, card, idx - 1);
    }
    default:
      return {};
  }
}

/* ---------------------------------------------------------
   7. BOSS BLIND EFFECTS
   --------------------------------------------------------- */
function applyBossChips(state, card, chips) {
  const ante = state.ante;
  if (ante < 2 || state.blindIdx !== 2) return chips;
  switch (ante) {
    case 2: // The Goad: red cards -2 chips min 1
      if (card.suit === 'H' || card.suit === 'D')
        return Math.max(1, chips - 2);
      return chips;
    case 3: // The Wall: black cards -2 chips min 1
      if (card.suit === 'S' || card.suit === 'C')
        return Math.max(1, chips - 2);
      return chips;
    case 5: // The Flint: target ×1.5 (handled in completion check)
      return chips;
    case 6: // The Water: mult halved (handled in scoring)
      return chips;
    case 8: // The Eye: card chips halved (round up)
      return Math.ceil(chips / 2);
    default:
      return chips;
  }
}

/* ---------------------------------------------------------
   8. SCORING
   --------------------------------------------------------- */
function computeScore(state, card) {
  // base chips = rank value
  let chips = card.rank;
  // boss chip adjustments
  chips = applyBossChips(state, card, chips);

  // evaluate jokers
  let addChips = 0, addMult = 0, multMult = 1;
  for (let i = 0; i < state.jokers.length; i++) {
    if (i >= effectiveJokerSlots(state)) break; // The Wheel
    const j = state.jokers[i];
    const r = evalJoker(j.id, state, card, i);
    addChips += r.addChips || 0;
    addMult  += r.addMult || 0;
    multMult *= r.multMult || 1;
  }

  const totalChips = Math.max(1, chips + addChips);
  let totalMult = 1 + addMult;
  // The Water: mult halved
  if (state.ante === 6 && state.blindIdx === 2) {
    totalMult = Math.floor(totalMult / 2);
  }
  totalMult = Math.max(1, totalMult) * multMult;

  return {
    chips: totalChips,
    mult: totalMult,
    total: Math.floor(totalChips * totalMult)
  };
}

/* ---------------------------------------------------------
   9. GAME ACTIONS
   --------------------------------------------------------- */
function newRun() {
  G = makeState();
  G.seed = Date.now();
  dealBlind();
  renderAll();
}
function dealBlind() {
  const stack = createDeck();
  shuffleDeck(stack, G.seed + G.ante * 1000 + G.blindIdx * 100);
  G.tableau = dealColumns(stack);
  G.freecells = Array(effectiveFreeCells(G)).fill(null);
  G.foundations = Array.from({length: FOUNDATION_COLS}, () => []);
  G.score = 0;
  G.selected = null;
  G.undoStack = [];
  G.cardsScored = 0;
  G.blindTarget = getBlindTarget(G.ante, G.blindIdx);
  // Boss-blind target multipliers
  if (G.ante === 5 && G.blindIdx === 2) {
    G.blindTarget = Math.floor(G.blindTarget * 1.5);
  }
  G.phase = 'playing';
  updateBlindUI();
  renderAll();
}

function redeal() {
  if (G.redeals <= 0 || !['playing', 'blind-done'].includes(G.phase)) return;
  G.redeals--;
  dealBlind();
  toast(`Redeal! ${G.redeals} left`);
}

// --- selection & move ---
function select(src, col, idx) {
  if (G.phase !== 'playing') return;
  // same-card toggle
  if (G.selected &&
      G.selected.src === src &&
      G.selected.col === col &&
      G.selected.idx === idx) {
    G.selected = null;
    renderAll();
    return;
  }
  G.selected = { src, col, idx };
  renderAll();
}

function getCard(state, sel) {
  if (!sel) return null;
  if (sel.src === 'tableau') {
    const col = state.tableau[sel.col];
    if (!col || sel.idx >= col.length) return null;
    return col[sel.idx];
  }
  if (sel.src === 'freecell') {
    return state.freecells[sel.col] || null;
  }
  return null;
}

function performMove(destType, destIdx) {
  if (!G.selected || G.phase !== 'playing') return;
  const card = getCard(G, G.selected);
  if (!card) return;

  const { src, col: srcCol, idx: srcIdx } = G.selected;

  // --- validate / ---
  if (destType === 'foundation') {
    // Only the exposed card can go to foundation
    if (src === 'tableau') {
      const srcColumn = G.tableau[srcCol];
      if (srcIdx !== srcColumn.length - 1) {
        toast('Must move the top card');
        return;
      }
    }
    const f = G.foundations[destIdx];
    if (!canPlaceOnFoundation(card, f)) {
      toast('Cannot place there');
      return;
    }
    // Execute
    pushUndo();
    removeCard(src, srcCol, srcIdx);
    f.push(card);
    G.cardsScored++;
    // score
    const result = computeScore(G, card);
    G.score += result.total;
    G.selected = null;
    showScorePop(result.total, card);
    renderAll();
    checkBlindState();
    return;
  }

  if (destType === 'freecell') {
    // can only move single card from tableau to free cell
    if (src !== 'tableau') { toast('Already in free cell'); return; }
    if (G.freecells[destIdx] !== null) { toast('Free cell occupied'); return; }
    // can only move bottom card of tableau column
    const col = G.tableau[srcCol];
    if (srcIdx !== col.length - 1) {
      toast('Can only move the top card');
      return;
    }
    pushUndo();
    removeCard(src, srcCol, srcIdx);
    G.freecells[destIdx] = card;
    G.selected = null;
    renderAll();
    return;
  }

  if (destType === 'tableau') {
    const destCol = G.tableau[destIdx];
    if (!destCol) return;

    if (src === 'tableau') {
      const srcColObj = G.tableau[srcCol];
      const seqLen = getSequenceLength(srcColObj);
      const requestLen = srcColObj.length - srcIdx;
      if (requestLen < 1) return;

      if (requestLen > 1) {
        // Validate the cards from srcIdx actually form a valid run
        if (seqLen < requestLen) {
          toast('Cannot move that sequence — invalid run');
          return;
        }
        // Compute capacity, excluding the destination empty column
        // (it's about to be consumed and can't serve as storage)
        const emptyFree = G.freecells.filter(c => c === null).length;
        const emptyCols = G.tableau.filter(col => col.length === 0).length;
        const adjustedEmpty = destCol.length === 0 ? emptyCols - 1 : emptyCols;
        const maxCap = (1 + emptyFree) * Math.pow(2, Math.max(0, adjustedEmpty));
        if (requestLen > maxCap) {
          toast(`Can only move ${maxCap} cards (needs ${requestLen})`);
          return;
        }
      }

      // Validate placement on tableau
      if (destCol.length > 0) {
        if (!canPlaceOnTableau(srcColObj[srcIdx], destCol)) {
          toast('Invalid tableau placement');
          return;
        }
      }

      pushUndo();
      const moved = srcColObj.splice(srcIdx, requestLen);
      for (const c of moved) destCol.push(c);
      G.selected = null;
      renderAll();
      return;
    }

    if (src === 'freecell') {
      // single card from free cell
      if (!canPlaceOnTableau(card, destCol)) {
        toast('Cannot place there');
        return;
      }
      pushUndo();
      G.freecells[srcCol] = null;
      destCol.push(card);
      G.selected = null;
      renderAll();
      return;
    }
  }
}

function removeCard(src, col, idx) {
  if (src === 'tableau') {
    G.tableau[col].splice(idx, 1);
  } else if (src === 'freecell') {
    G.freecells[col] = null;
  }
}

function pushUndo() {
  G.undoStack.push({
    tableau: G.tableau.map(col => [...col]),
    freecells: [...G.freecells],
    foundations: G.foundations.map(f => [...f]),
    score: G.score,
    cardsScored: G.cardsScored,
    selected: G.selected,
  });
  // Cap undo at 50
  if (G.undoStack.length > 50) G.undoStack.shift();
}

function undo() {
  if (G.undoStack.length === 0 || G.phase !== 'playing') return;
  const snap = G.undoStack.pop();
  G.tableau = snap.tableau;
  G.freecells = snap.freecells;
  G.foundations = snap.foundations;
  G.score = snap.score;
  G.cardsScored = snap.cardsScored;
  G.selected = snap.selected;
  renderAll();
}

// --- blind state check ---
function checkBlindState() {
  const total = G.foundations.reduce((s,f) => s + f.length, 0);
  if (total < TOTAL_CARDS) return;

  // Deck cleared — check score vs target
  if (G.score >= G.blindTarget) {
    // WIN the blind
    const rew = getBlindReward(G.ante, G.blindIdx);
    G.money += rew;
    G.totalScore += G.score;
    // interest on money
    G.money += Math.min(5, Math.floor(G.money / 5));

    if (G.blindIdx === 2) {
      // Completed boss blind: advance ante
      if (G.ante >= 8) {
        G.phase = 'won';
        showModal(renderWinScreen);
        renderAll();
        return;
      }
      G.ante++;
      G.blindIdx = 0;
    } else {
      G.blindIdx++;
    }
    G.phase = 'shop';
    renderAll();
    showShop();
  } else {
    // Score below target — can redeal or game over
    if (G.redeals > 0) {
      G.phase = 'blind-done';
      renderAll();
      showModal(renderFailScreen);
    } else {
      G.phase = 'lost';
      renderAll();
      showModal(renderGameOverScreen);
    }
  }
}

/* ---------------------------------------------------------
   10. SHOP
   --------------------------------------------------------- */
let shopState = null; // { jokers: [], rerolls: 0 }

function generateShopItems() {
  // Weighted random selection from JOKER_IDS
  const pool = JOKER_IDS.filter(j => {
    // Don't offer owned jokers (unique)
    return !G.jokers.some(owned => owned.id === j.id);
  });
  if (pool.length === 0) return [];
  const items = [];
  for (let i = 0; i < 2; i++) {
    if (pool.length === 0) break;
    const totalWeight = pool.reduce((sum, joker) => sum + joker.shopWeight, 0);
    let r = Math.random() * totalWeight;
    for (let j = 0; j < pool.length; j++) {
      r -= pool[j].shopWeight;
      if (r <= 0) {
        items.push({ ...pool[j] });
        pool.splice(j, 1);
        break;
      }
    }
  }
  return items;
}

function showShop() {
  shopState = { jokers: generateShopItems(), rerolls: 0 };
  showModal(renderShopModal);
}

function rerollShop() {
  const cost = 1 + shopState.rerolls;
  if (G.money < cost) { toast('Not enough money'); return; }
  G.money -= cost;
  shopState.rerolls++;
  shopState.jokers = generateShopItems();
  $('modal-content').innerHTML = renderShopModal();
}

function buyJoker(shopIdx) {
  const item = shopState.jokers[shopIdx];
  if (!item) return;
  if (G.money < item.cost) { toast('Not enough money'); return; }
  if (G.jokers.length >= effectiveJokerSlots(G)) {
    toast('Joker slots full');
    return;
  }
  G.money -= item.cost;
  G.jokers.push({ id: item.id });
  shopState.jokers.splice(shopIdx, 1);
  $('modal-content').innerHTML = renderShopModal();
  toast(`Bought ${item.name}!`);
}

function skipShop() {
  closeModal();
  dealBlind();
}

function continueToNextBlind() {
  closeModal();
  dealBlind();
}

/* ---------------------------------------------------------
   11. HINT (simple greedy)
   --------------------------------------------------------- */
function showHint() {
  if (G.phase !== 'playing') return;
  // Find a legal foundation move first
  for (let fi = 0; fi < FOUNDATION_COLS; fi++) {
    const f = G.foundations[fi];
    // Check tableau bottoms
    for (let ci = 0; ci < G.tableau.length; ci++) {
      const col = G.tableau[ci];
      if (col.length === 0) continue;
      const card = col[col.length - 1];
      if (canPlaceOnFoundation(card, f)) {
        G.selected = { src: 'tableau', col: ci, idx: col.length - 1 };
        renderAll();
        toast(`Hint: move ${RANK_LABEL[card.rank]}${SUIT_SYM[card.suit]} to foundation ${fi+1}`);
        return;
      }
    }
    // Check free cells
    for (let fc = 0; fc < G.freecells.length; fc++) {
      const card = G.freecells[fc];
      if (!card) continue;
      if (canPlaceOnFoundation(card, f)) {
        G.selected = { src: 'freecell', col: fc, idx: 0 };
        renderAll();
        toast(`Hint: move ${RANK_LABEL[card.rank]}${SUIT_SYM[card.suit]} from free cell`);
        return;
      }
    }
  }
  // Fallback: suggest a free cell move
  for (let ci = 0; ci < G.tableau.length; ci++) {
    const col = G.tableau[ci];
    if (col.length < 2) continue;
    const card = col[col.length - 1];
    for (let fc = 0; fc < G.freecells.length; fc++) {
      if (G.freecells[fc] === null) {
        G.selected = null;
        toast(`Hint: move ${RANK_LABEL[card.rank]}${SUIT_SYM[card.suit]} to free cell`);
        return;
      }
    }
  }
  toast('No obvious moves found');
}

/* ---------------------------------------------------------
   12. RENDERING  —  DOM
   --------------------------------------------------------- */

function $(id) { return document.getElementById(id); }

function renderAll() {
  renderTableau();
  renderFrees();
  renderFoundations();
  renderJokers();
  renderHUD();
  renderSelection();
}

function renderTableau() {
  const el = $('tableau');
  el.innerHTML = '';
  for (let i = 0; i < TABLEAU_COLS; i++) {
    const col = G.tableau[i];
    const div = document.createElement('div');
    div.className = 'tcol';
    div.dataset.col = i;
    div.addEventListener('click', () => onTableauClick(i));

    for (let j = 0; j < col.length; j++) {
      const card = col[j];
      const cd = makeCardEl(card, j, col.length - 1);
      cd.dataset.col = i;
      cd.dataset.idx = j;
      cd.addEventListener('click', (e) => {
        e.stopPropagation();
        onCardClick('tableau', i, j);
      });
      div.appendChild(cd);
    }
    el.appendChild(div);
  }
}

function renderFrees() {
  const el = $('freecells');
  el.innerHTML = '';
  const cap = effectiveFreeCells(G);
  for (let i = 0; i < cap; i++) {
    const slot = document.createElement('div');
    slot.className = 'freecell-slot' + (G.freecells[i] ? '' : ' empty');
    slot.dataset.fc = i;
    if (G.freecells[i]) {
      const cd = makeCardEl(G.freecells[i], 0, 0);
      cd.addEventListener('click', (e) => {
        e.stopPropagation();
        onCardClick('freecell', i, 0);
      });
      slot.appendChild(cd);
    }
    slot.addEventListener('click', () => onFreeClick(i));
    el.appendChild(slot);
  }
}

function renderFoundations() {
  const el = $('foundations');
  el.innerHTML = '';
  const suiteCycle = ['S','H','D','C'];
  for (let i = 0; i < FOUNDATION_COLS; i++) {
    const slot = document.createElement('div');
    slot.className = 'foundation-slot' + (G.foundations[i].length === 0 ? ' empty' : '');
    slot.dataset.fd = i;
    if (G.foundations[i].length === 0) {
      const dim = document.createElement('span');
      dim.className = 'foundation-base-suit';
      dim.textContent = SUIT_SYM[suiteCycle[i]];
      slot.appendChild(dim);
    } else {
      const top = G.foundations[i][G.foundations[i].length - 1];
      const cd = makeCardEl(top, 0, 0);
      slot.appendChild(cd);
    }
    slot.addEventListener('click', () => onFoundationClick(i));
    el.appendChild(slot);
  }
}

function makeCardEl(card, idx, isLast) {
  const div = document.createElement('div');
  div.className = 'card';
  div.dataset.id = card.id;
  div.dataset.rank = card.rank;
  div.dataset.suit = card.suit;
  const red = card.suit === 'H' || card.suit === 'D';
  if (red) div.classList.add('red');

  const rankSpan = document.createElement('span');
  rankSpan.className = 'card-rank';
  rankSpan.textContent = RANK_LABEL[card.rank];

  const suitSpan = document.createElement('span');
  suitSpan.className = 'card-suit';
  suitSpan.textContent = SUIT_SYM[card.suit];

  div.appendChild(rankSpan);
  div.appendChild(suitSpan);
  return div;
}

function renderJokers() {
  const el = $('jokers');
  el.innerHTML = '';
  const slots = effectiveJokerSlots(G);
  for (let i = 0; i < slots; i++) {
    const slot = document.createElement('div');
    slot.className = 'joker-slot';
    if (i < G.jokers.length) {
      const j = G.jokers[i];
      const def = JOKER_MAP[j.id];
      slot.classList.add('filled');
      const nm = document.createElement('strong');
      nm.textContent = def ? def.name : j.id;
      const desc = document.createElement('small');
      desc.textContent = def ? def.desc : '';
      const rarity = document.createElement('span');
      rarity.className = `joker-rarity ${def ? def.rarity : ''}`;
      slot.appendChild(rarity);
      slot.appendChild(nm);
      slot.appendChild(desc);
    } else {
      slot.classList.add('empty');
    }
    el.appendChild(slot);
  }
  $('joker-count').textContent = `${G.jokers.length} / ${slots}`;
}

function renderHUD() {
  $('ante-value').textContent = `${G.ante}/8`;
  $('money-value').textContent = `$${G.money}`;
  $('redeal-value').textContent = G.redeals;
  $('score-value').textContent = G.score;
  $('target-value').textContent = G.blindTarget;

  // Score meter
  const fill = $('score-meter-fill');
  const pct = Math.min(100, (G.score / G.blindTarget) * 100);
  fill.style.width = pct + '%';

  // Capacity
  if (G.phase === 'playing') {
    const cap = maxMoveCapacity(G);
    $('capacity-label').textContent = `Move up to ${cap} cards`;
  } else {
    $('capacity-label').textContent = '—';
  }

  // Redeal button
  const reBtn = $('redeal-button');
  if (G.redeals > 0 && G.phase === 'playing') {
    reBtn.disabled = false;
    reBtn.querySelector('span').textContent = `−${G.redeals}`;
  } else {
    reBtn.disabled = true;
  }
}

function renderSelection() {
  // Clear previous highlights
  document.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
  if (!G.selected) return;
  const sel = G.selected;
  let target;
  if (sel.src === 'tableau') {
    const colEl = document.querySelector(`.tcol[data-col="${sel.col}"]`);
    if (colEl) {
      const children = colEl.querySelectorAll('.card');
      const cardEl = children[sel.idx];
      if (cardEl) cardEl.classList.add('selected');
    }
  } else if (sel.src === 'freecell') {
    target = document.querySelector(`.freecell-slot[data-fc="${sel.col}"] .card`);
    if (target) target.classList.add('selected');
  }
}

function updateBlindUI() {
  const isBoss = isBossBlind(G.blindIdx);
  $('blind-kicker').textContent = BLIND_NAMES[G.blindIdx];
  const bossName = getBossName(G.ante);
  if (isBoss && bossName) {
    $('blind-name').textContent = bossName;
    $('blind-icon').textContent = '◆';
    $('blind-icon').className = 'blind-icon boss';
    const effect = getBossEffect(G.ante);
    $('boss-effect').textContent = effect ? effect() : '';
    $('boss-effect').style.display = 'inline';
  } else {
    $('blind-name').textContent = 'The Opening';
    $('blind-icon').textContent = '●';
    $('blind-icon').className = 'blind-icon';
    $('boss-effect').style.display = 'none';
  }
}

/* ---------------------------------------------------------
   13. EVENTS
   --------------------------------------------------------- */
function onCardClick(src, col, idx) {
  if (G.phase !== 'playing') return;
  if (G.selected) {
    // Same card → deselect
    if (G.selected.src === src && G.selected.col === col && G.selected.idx === idx) {
      G.selected = null; renderAll(); return;
    }
    // Same column, different card → re-select
    if (G.selected.src === src && G.selected.col === col) {
      select(src, col, idx); return;
    }
    // Clicking bottom card in a different tableau column → try to move there
    if (src === 'tableau') {
      const colCards = G.tableau[col];
      if (idx === colCards.length - 1) {
        performMove('tableau', col);
        return;
      }
      // Not the bottom card → re-select
      select(src, col, idx);
      return;
    }
    // Clicking a free cell card → re-select
    select(src, col, idx);
    return;
  }
  select(src, col, idx);
}

function onTableauClick(colIdx) {
  if (!G.selected) return;
  const destType = G.selected.src === 'freecell' ? 'freecell' : 'tableau';
  // If selected card is from freecell, clicking tableau means move to tableau
  if (G.selected.src === 'freecell') {
    performMove('tableau', colIdx);
    return;
  }
  // If same column, ignore
  if (G.selected.src === 'tableau' && G.selected.col === colIdx) {
    G.selected = null;
    renderAll();
    return;
  }
  // Move to tableau column
  performMove('tableau', colIdx);
}

function onFreeClick(fcIdx) {
  if (G.phase !== 'playing') return;
  if (G.selected) {
    // Move selected card to this free cell
    performMove('freecell', fcIdx);
    return;
  }
  // Select card in free cell
  if (G.freecells[fcIdx]) {
    select('freecell', fcIdx, 0);
  }
}

function onFoundationClick(fdIdx) {
  if (G.phase !== 'playing') return;
  if (G.selected) {
    performMove('foundation', fdIdx);
    return;
  }
  // Quick-move from tableau bottom if only one option
  // (auto-find a movable card for this foundation)
  for (let ci = 0; ci < G.tableau.length; ci++) {
    const col = G.tableau[ci];
    if (col.length === 0) continue;
    const card = col[col.length - 1];
    if (canPlaceOnFoundation(card, G.foundations[fdIdx])) {
      G.selected = { src: 'tableau', col: ci, idx: col.length - 1 };
      performMove('foundation', fdIdx);
      return;
    }
  }
  for (let fc = 0; fc < G.freecells.length; fc++) {
    const card = G.freecells[fc];
    if (!card) continue;
    if (canPlaceOnFoundation(card, G.foundations[fdIdx])) {
      G.selected = { src: 'freecell', col: fc, idx: 0 };
      performMove('foundation', fdIdx);
      return;
    }
  }
  toast('No card available for that foundation');
}

/* ---------------------------------------------------------
   14. SCORE POPUP  &  TOAST
   --------------------------------------------------------- */
function showScorePop(total, card) {
  const pop = $('score-pop');
  const readout = $('chips-readout');
  const mult = $('mult-readout');
  readout.textContent = card.rank;
  mult.textContent = total > 0 ? Math.round(total / card.rank) : 1;
  pop.classList.remove('pop');
  void pop.offsetWidth; // reflow
  pop.classList.add('pop');
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 2000);
}

/* ---------------------------------------------------------
   15. MODAL  (shop / fail / game over / win)
   --------------------------------------------------------- */
function showModal(renderFn) {
  const el = $('modal-content');
  el.innerHTML = renderFn();
  $('modal').showModal();
}
function closeModal() {
  $('modal').close();
}

function renderShopModal() {
  let html = `<div class="modal-shop"><h2>🛒 Shop</h2><p>Money: <strong>$${G.money}</strong></p>`;
  html += `<div class="shop-items">`;
  for (let i = 0; i < shopState.jokers.length; i++) {
    const j = shopState.jokers[i];
    const canAfford = G.money >= j.cost;
    const owned = G.jokers.some(oj => oj.id === j.id);
    const full = G.jokers.length >= effectiveJokerSlots(G);
    html += `<div class="shop-item ${canAfford && !full ? '' : 'disabled'}">
      <div class="shop-item-rarity ${j.rarity}"></div>
      <strong>${j.name}</strong>
      <small>${j.desc}</small>
      <div class="shop-item-footer">$${j.cost} · ${j.rarity}</div>
      <button onclick="buyJoker(${i})" ${!canAfford || full ? 'disabled' : ''}>
        ${!canAfford ? 'Need $' + (j.cost - G.money) : full ? 'Slots full' : 'Buy'}
      </button>
    </div>`;
  }
  html += `</div>`;
  html += `<div class="modal-actions">
    <button class="button ghost" onclick="rerollShop()" ${G.money < 1 + shopState.rerolls ? 'disabled' : ''}>
      Reroll ($${1 + shopState.rerolls})
    </button>
    <button class="button primary" onclick="skipShop()">Continue →</button>
  </div></div>`;
  return html;
}

function renderFailScreen() {
  return `<div class="modal-result">
    <h2>✗ Need ${G.blindTarget} (got ${G.score})</h2>
    <p>You have ${G.redeals} redeal${G.redeals !== 1 ? 's' : ''} left.</p>
    <div class="modal-actions">
      <button class="button primary" onclick="redeal(); closeModal();">Redeal (${G.redeals} left)</button>
      <button class="button danger" onclick="giveUp()">Give Up</button>
    </div>
  </div>`;
}

function renderGameOverScreen() {
  const total = G.totalScore + G.score;
  return `<div class="modal-result">
    <h2>💀 Run Over</h2>
    <p>Reached Ante ${G.ante}, Blind ${G.blindIdx + 1}</p>
    <p>Total score: ${total}</p>
    <div class="modal-actions">
      <button class="button primary" onclick="closeModal(); newRun();">New Run</button>
    </div>
  </div>`;
}

function renderWinScreen() {
  return `<div class="modal-result win">
    <h2>🏆 Victory!</h2>
    <p>You beat all 8 Antes!</p>
    <p>Total money: $${G.money}</p>
    <div class="modal-actions">
      <button class="button primary" onclick="closeModal(); newRun();">Play Again</button>
    </div>
  </div>`;
}

/* ---------------------------------------------------------
   16. INIT
   --------------------------------------------------------- */
function init() {
  // Bind top-level actions
  $('undo-button').addEventListener('click', undo);
  $('hint-button').addEventListener('click', showHint);
  $('redeal-button').addEventListener('click', redeal);
  $('new-run-button').addEventListener('click', () => { closeModal(); newRun(); });
  $('modal').addEventListener('cancel', event => event.preventDefault());

  // Expose for onclick
  window.buyJoker = buyJoker;
  window.rerollShop = rerollShop;
  window.skipShop = skipShop;
  window.redeal = () => { redeal(); };
  window.closeModal = closeModal;
  window.newRun = newRun;
  window.giveUp = function() {
    closeModal();
    G.phase = 'lost';
    renderAll();
    showModal(renderGameOverScreen);
  };



  newRun();
}

// Boot when DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
