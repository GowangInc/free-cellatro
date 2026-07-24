/* =========================================================
   FREE BLATRO  —  FreeCell meets Balatro
   ========================================================= */
(function(){
'use strict';

/* ---------------------------------------------------------
   1. CONSTANTS
   --------------------------------------------------------- */
const SUITS     = ['S','H','D','C'];
const SUIT_SYM  = { S:'♠', H:'♥', D:'♦', C:'♣' };
const RANK_LABEL = { 1:'A',2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',
                     8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K' };
const TOTAL_CARDS = 52;
const TABLEAU_COLS = 8;
const FREE_CELL_COLS = 4;
const FOUNDATION_COLS = 4;
const MAX_JOKERS = 5;

/* Sound effects via Web Audio API */
const Sound = {
  _ctx: null,
  _ensure() {
    if (!this._ctx) this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this._ctx.state === 'suspended') this._ctx.resume();
  },
  _tone(f, d, t, v, delay) {
    this._ensure();
    const now = this._ctx.currentTime + (delay||0);
    const o = this._ctx.createOscillator();
    const g = this._ctx.createGain();
    o.connect(g); g.connect(this._ctx.destination);
    o.frequency.value = f; o.type = t||'square';
    g.gain.setValueAtTime(v||0.07, now);
    g.gain.exponentialRampToValueAtTime(0.001, now+(d||0.1));
    o.start(now); o.stop(now+(d||0.1));
  },
  click()  { this._tone(660,0.05,'square',0.05); },
  place()  { this._tone(360,0.08,'triangle',0.08); },
  score()  { this._tone(880,0.12,'sine',0.07); this._tone(1100,0.12,'sine',0.05,0.07); },
  win()    { [523,659,784,1047].forEach((f,i)=>this._tone(f,0.2,'sine',0.07,i*0.1)); },
  error()  { this._tone(180,0.2,'sawtooth',0.035); },
  buy()    { this._tone(1200,0.08,'sine',0.06); this._tone(1500,0.08,'sine',0.04,0.06); },
  redeem() { this._tone(400,0.15,'triangle',0.07); this._tone(500,0.15,'triangle',0.05,0.08); },
  redeal() { this.redeem(); },
  undo()   { this._tone(250,0.1,'sine',0.04); },
  deal()   { this._tone(200,0.04,'triangle',0.035); for(let i=1;i<4;i++)this._tone(200+i*40,0.04,'triangle',0.035,i*0.025); },
};


/* Ante targets — reduced ~40% from original for approachable difficulty */
const ANTE_TARGETS = [
  null,
  [180, 280, 420],
  [300, 420, 660],
  [480, 660, 1020],
  [720, 1020, 1560],
  [1080, 1500, 2300],
  [1560, 2160, 3300],
  [2300, 3120, 4800],
  [3300, 4500, 7200],
];
const BLIND_NAMES = ['Small Blind', 'Big Blind', 'Boss Blind'];
const BOSS_NAMES  = [null, null, 'The Goad', 'The Wall', 'The Needle',
                     'The Flint', 'The Water', 'The Wheel', 'The Eye'];
const BOSS_EFFECTS = [null, null,
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

/* Joker definitions */
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

/* ---------------------------------------------------------
   2. DECK — Microsoft FreeCell deal generation
   --------------------------------------------------------- */
function microsoftDeal(seed32) {
  const msSuits = ['H','S','D','C'];
  const card = [null];
  for (let si = 0; si < 4; si++)
    for (let r = 1; r <= 13; r++)
      card.push({ suit: msSuits[si], rank: r, id: msSuits[si] + r });
  let state = (seed32 >>> 0);
  for (let i = 1; i <= 52; i++) {
    state = (state * 214013 + 2531011) >>> 0;
    state = state & 0x7fffffff;
    const j = ((state >>> 16) % (53 - i)) + 1;
    const t = card[i]; card[i] = card[j]; card[j] = t;
  }
  return card.slice(1);
}

function dealColumns(deck) {
  const cols = Array.from({length: 8}, () => []);
  let p = 0;
  for (let r = 0; r < 7; r++)
    for (let c = 0; c < 8; c++)
      if (r < 6 || c < 4) cols[c].push(deck[p++]);
  return cols;
}

/* ---------------------------------------------------------
   3. FREECELL RULES
   --------------------------------------------------------- */
function canPlaceOnFoundation(card, foundation) {
  if (foundation.length === 0) return card.rank === 1;
  const top = foundation[foundation.length - 1];
  return card.suit === top.suit && card.rank === top.rank + 1;
}
function canPlaceOnTableau(card, col) {
  if (!col || col.length === 0) return true;
  const top = col[col.length - 1];
  const c = (card.suit === 'S' || card.suit === 'C') ? 'b' : 'r';
  const t = (top.suit === 'S' || top.suit === 'C') ? 'b' : 'r';
  return c !== t && card.rank === top.rank - 1;
}
function getSequenceLength(col) {
  if (!col || col.length === 0) return 0;
  let len = 1;
  for (let i = col.length - 1; i > 0; i--) {
    const a = col[i], b = col[i-1];
    const ca = (a.suit === 'S' || a.suit === 'C') ? 'b' : 'r';
    const cb = (b.suit === 'S' || b.suit === 'C') ? 'b' : 'r';
    if (ca === cb || b.rank !== a.rank + 1) break;
    len++;
  }
  return len;
}
function maxMoveCapacity(state) {
  const ef = state.freecells.filter(c => c === null).length;
  const ec = state.tableau.filter(col => col.length === 0).length;
  return (1 + ef) * Math.pow(2, ec);
}
function effectiveFreeCells(state) {
  let m = FREE_CELL_COLS;
  for (const j of state.jokers) if (j.id === 'double_up') m--;
  if (state.ante === 4 && state.blindIdx === 2) m--;
  return Math.max(1, m);
}
function effectiveJokerSlots(state) {
  return (state.ante === 7 && state.blindIdx === 2) ? 4 : MAX_JOKERS;
}

/* ---------------------------------------------------------
   4. JOKER EVALUATION
   --------------------------------------------------------- */
function evalJoker(id, state, card, idx) {
  const ef = state.freecells.filter(c => c === null).length;
  const ec = state.tableau.filter(col => col.length === 0).length;
  const ft = state.foundations.reduce((s,f) => s + f.length, 0);
  const cb = state.freecells.filter(c => c !== null).length;
  switch (id) {
    case 'free_cell':  return { addMult: 3 * ef };
    case 'banner':     return { addChips: 30 * ec };
    case 'greedy':     return { addMult: 4 + (card && card.suit === 'C' ? 4 : 0) };
    case 'lusty':      return card && card.suit === 'H' ? { addMult: 3 } : {};
    case 'wrathful':   return card && card.suit === 'S' ? { addMult: 3 } : {};
    case 'gluttonous': return card && card.suit === 'D' ? { addMult: 3 } : {};
    case 'scholar':    return card && card.rank === 1 ? { addChips: 20, addMult: 4 } : {};
    case 'ceremonial': return { addMult: ft };
    case 'double_up':  return { multMult: 1.5 };
    case 'fortune':    return { addMult: Math.floor(state.money / 3) };
    case 'stockpile':  return { addMult: 2 * cb };
    case 'blueprint': {
      if (idx <= 0) return {};
      const left = state.jokers[idx - 1];
      return (left && left.id !== 'blueprint') ? evalJoker(left.id, state, card, idx - 1) : {};
    }
    default: return {};
  }
}

/* ---------------------------------------------------------
   5. BOSS EFFECTS + SCORING
   --------------------------------------------------------- */
function applyBossChips(state, card, chips) {
  if (state.ante < 2 || state.blindIdx !== 2) return chips;
  if (state.ante === 2 && (card.suit === 'H' || card.suit === 'D')) return Math.max(1, chips - 2);
  if (state.ante === 3 && (card.suit === 'S' || card.suit === 'C')) return Math.max(1, chips - 2);
  if (state.ante === 8) return Math.ceil(chips / 2);
  return chips;
}
function computeScore(state, card) {
  let chips = Math.max(1, applyBossChips(state, card, card.rank));
  let addChips = 0, addMult = 0, multMult = 1;
  const slots = (state.ante === 7 && state.blindIdx === 2) ? 4 : MAX_JOKERS;
  for (let i = 0; i < state.jokers.length && i < slots; i++) {
    const r = evalJoker(state.jokers[i].id, state, card, i);
    addChips += r.addChips || 0; addMult += r.addMult || 0; multMult *= r.multMult || 1;
  }
  let m = 1 + addMult;
  if (state.ante === 6 && state.blindIdx === 2) m = Math.floor(m / 2);
  return { chips: chips + addChips, mult: Math.max(1, m) * multMult,
           total: Math.floor((chips + addChips) * Math.max(1, m) * multMult) };
}

/* ---------------------------------------------------------
   6. DEAL VALIDATION
   A conservative solver proves a deal with ordinary legal
   one-card moves before it is shown. It may reject a solvable
   deal; it never accepts an unproven one.
   --------------------------------------------------------- */
function isSolvableDeal(tableau, freeCellCount) {
  const initial = {
    tableau: tableau.map(col => [...col]),
    freecells: Array(freeCellCount).fill(null),
    foundations: [[], [], [], []],
  };
  const visited = new Set();
  const stateKey = state => [
    state.tableau.map(col => col.map(card => card.id).join(',')).join('/'),
    state.freecells.map(card => card ? card.id : '.').join(','),
    state.foundations.map(stack => stack.length ? stack.at(-1).id : '.').join(','),
  ].join('|');
  const copyState = state => ({
    tableau: state.tableau.map(col => [...col]),
    freecells: [...state.freecells],
    foundations: state.foundations.map(stack => [...stack]),
  });
  const search = (state, depth) => {
    if (state.foundations.every(stack => stack.length === 13)) return true;
    if (depth >= 250 || visited.size >= 6000) return false;
    const key = stateKey(state);
    if (visited.has(key)) return false;
    visited.add(key);
    const moves = [];
    for (let fi = 0; fi < FOUNDATION_COLS; fi++) {
      for (let ci = 0; ci < TABLEAU_COLS; ci++) {
        const col = state.tableau[ci], card = col.at(-1);
        if (card && canPlaceOnFoundation(card, state.foundations[fi]))
          moves.push({ type:'tableau-foundation', ci, fi });
      }
      for (let fci = 0; fci < state.freecells.length; fci++) {
        const card = state.freecells[fci];
        if (card && canPlaceOnFoundation(card, state.foundations[fi]))
          moves.push({ type:'freecell-foundation', fci, fi });
      }
    }
    if (!moves.length) {
    for (let ci = 0; ci < TABLEAU_COLS; ci++) {
      const card = state.tableau[ci].at(-1);
      if (!card) continue;
      for (let di = 0; di < TABLEAU_COLS; di++)
        if (ci !== di && canPlaceOnTableau(card, state.tableau[di]))
          moves.push({ type:'tableau-tableau', ci, di });
      for (let fci = 0; fci < state.freecells.length; fci++)
        if (!state.freecells[fci]) moves.push({ type:'tableau-freecell', ci, fci });
    }
    for (let fci = 0; fci < state.freecells.length; fci++) {
      const card = state.freecells[fci];
      if (!card) continue;
      for (let di = 0; di < TABLEAU_COLS; di++)
        if (canPlaceOnTableau(card, state.tableau[di]))
          moves.push({ type:'freecell-tableau', fci, di });
    }
    }
    for (const move of moves) {
      const next = copyState(state);
      if (move.type === 'tableau-foundation')
        next.foundations[move.fi].push(next.tableau[move.ci].pop());
      else if (move.type === 'freecell-foundation') {
        next.foundations[move.fi].push(next.freecells[move.fci]);
        next.freecells[move.fci] = null;
      } else if (move.type === 'tableau-tableau')
        next.tableau[move.di].push(next.tableau[move.ci].pop());
      else if (move.type === 'tableau-freecell') {
        next.freecells[move.fci] = next.tableau[move.ci].pop();
      } else {
        next.tableau[move.di].push(next.freecells[move.fci]);
        next.freecells[move.fci] = null;
      }
      if (search(next, depth + 1)) return true;
    }
    return false;
  };
  return search(initial, 0);
}

/* ---------------------------------------------------------
   6. GAME STATE
   --------------------------------------------------------- */
let G = null;
let shopState = null;

function gt(ante, bi) { const r = ANTE_TARGETS[ante] || ANTE_TARGETS[8]; return r ? r[bi]||700 : 700; }
function gr(ante, bi) { const r = BLIND_REWARDS[ante] || BLIND_REWARDS[8]; return r ? r[bi]||8 : 8; }
function bossName(ante) { return ante > 1 && ante <= 8 ? BOSS_NAMES[ante] : null; }
function bossEffect(ante) { return ante > 1 && ante <= 8 ? BOSS_EFFECTS[ante] : null; }

function freshState() {
  return {
    phase:'playing', ante:1, blindIdx:0, money:4, redeals:5, seed:Date.now(),
    skipCount:0, tableau:[], freecells:Array(4).fill(null),
    foundations:[[],[],[],[]], selected:null, undoStack:[],
    score:0, blindTarget:180, totalScore:0, jokers:[], cardsScored:0,
  };
}


/* ---------------------------------------------------------
   7. GAME ACTIONS
   --------------------------------------------------------- */
function newRun() {
  if (autoCompleting) return;
  G = freshState();
  const pool = JOKER_IDS.filter(j => j.rarity === 'common');
  G.jokers.push({ id: pool[Math.floor(Math.random() * pool.length)].id });
  dealBlind();
  renderAll();
}
let dealToken = 0;
function randomDealSeed() {
  return Math.floor(Math.random() * 0x80000000);
}
function dealBlind() {
  const token = ++dealToken;
  G.phase = 'validating';
  G.selected = null;
  G.tableau = Array.from({length: TABLEAU_COLS}, () => []);
  G.freecells = Array(effectiveFreeCells(G)).fill(null);
  G.foundations = [[],[],[],[]];
  updateBlindUI();
  renderAll();
  let retry = 0;
  const freeCellCount = effectiveFreeCells(G);
  const startingSeed = randomDealSeed();
  const validateNext = () => {
    if (token !== dealToken) return;
    const seed = ((startingSeed + retry) & 0x7fffffff) >>> 0;
    const candidate = dealColumns(microsoftDeal(seed));
    if (isSolvableDeal(candidate, freeCellCount)) {
      if (token !== dealToken) return;
      G.tableau = candidate;
      G.freecells = Array(freeCellCount).fill(null);
      G.foundations = [[],[],[],[]];
      G.score = 0; G.undoStack = []; G.cardsScored = 0;
      G.blindTarget = gt(G.ante, G.blindIdx);
      if (G.ante === 5 && G.blindIdx === 2) G.blindTarget = Math.floor(G.blindTarget * 1.5);
      G.phase = 'playing';
      G.dealing = true;
      updateBlindUI();
      renderAll();
      setTimeout(() => {
        if (token === dealToken && G.phase === 'playing') G.dealing = false;
      }, 520);
      return;
    }
    retry++;
    setTimeout(validateNext, 0);
  };
  setTimeout(validateNext, 0);
}
function redeal() {
  if (autoCompleting || G.redeals <= 0 || !['playing','blind-done'].includes(G.phase)) return;
  Sound.redeal(); G.redeals--; dealBlind();
  toast('Redeal! '+G.redeals+' left');
}
function skipDeal() {
  if (autoCompleting || G.phase !== 'playing') return;
  G.skipCount++; Sound.deal(); dealBlind();
  toast('Fresh deal');
}

/* --- selection & move --- */
function select(src, col, idx) {
  if (G.phase !== 'playing' || autoCompleting) return;
  Sound.click();
  if (G.selected && G.selected.src===src && G.selected.col===col && G.selected.idx===idx)
    { G.selected=null; renderAll(); return; }
  G.selected = { src, col, idx }; renderAll();
}
function getCard(s) {
  if (!s) return null;
  if (s.src === 'tableau') { const c = G.tableau[s.col]; return c && s.idx < c.length ? c[s.idx] : null; }
  if (s.src === 'freecell') return G.freecells[s.col] || null;
  return null;
}
function pushUndo() {
  G.undoStack.push({
    tableau: G.tableau.map(c=>[...c]), freecells:[...G.freecells],
    foundations: G.foundations.map(f=>[...f]), score:G.score, cardsScored:G.cardsScored, selected:G.selected,
  });
  if (G.undoStack.length > 50) G.undoStack.shift();
}
function rmCard(src, col, idx) {
  if (src === 'tableau') G.tableau[col].splice(idx, 1);
  else if (src === 'freecell') G.freecells[col] = null;
}

function performMove(dt, di) {
  if (!G.selected || G.phase !== 'playing' || (autoCompleting && !G.autoStep)) return;
  const card = getCard(G.selected); if (!card) return;
  const { src, col:sc, idx:si } = G.selected;

  if (dt === 'foundation') {
    if (src === 'tableau' && si !== G.tableau[sc].length-1)
      { toast('Must move the top card'); Sound.error(); return; }
    if (!canPlaceOnFoundation(card, G.foundations[di]))
      { toast('Cannot place there'); Sound.error(); return; }
    pushUndo(); rmCard(src, sc, si);
    G.foundations[di].push(card); G.cardsScored++;
    G.foundationPulse = di;
    const r = computeScore(G, card);
    G.score += r.total; G.selected = null;
    Sound.score(); showScorePop(r.total, card); renderAll(); checkBlindState(); return;
  }
  if (dt === 'freecell') {
    if (src !== 'tableau') { toast('Already in free cell'); Sound.error(); return; }
    if (G.freecells[di] !== null) { toast('Free cell occupied'); Sound.error(); return; }
    if (si !== G.tableau[sc].length - 1) { toast('Can only move the top card'); Sound.error(); return; }
    pushUndo(); rmCard(src, sc, si); G.freecells[di] = card; G.selected = null;
    Sound.place(); renderAll(); return;
  }
  if (dt === 'tableau') {
    const dc = G.tableau[di]; if (!dc) return;
    if (src === 'tableau') {
      const srcCol = G.tableau[sc];
      const seqLen = getSequenceLength(srcCol);
      const reqLen = srcCol.length - si;
      if (reqLen < 1) return;
      if (reqLen > 1) {
        if (seqLen < reqLen) { toast('Invalid sequence'); Sound.error(); return; }
        const ef = G.freecells.filter(c=>c===null).length;
        const ec2 = G.tableau.filter(c=>c.length===0).length;
        const adj = dc.length === 0 ? ec2 - 1 : ec2;
        if (reqLen > (1+ef)*Math.pow(2,Math.max(0,adj)))
          { toast('Can only move '+(1+ef)*Math.pow(2,Math.max(0,adj))+' cards'); Sound.error(); return; }
      }
      if (dc.length > 0 && !canPlaceOnTableau(srcCol[si], dc))
        { toast('Invalid placement'); Sound.error(); return; }
      pushUndo();
      const moved = srcCol.splice(si, reqLen);
      moved.forEach(c => dc.push(c));
      G.selected = null; Sound.place(); renderAll(); return;
    }
    if (src === 'freecell') {
      if (!canPlaceOnTableau(card, dc)) { toast('Cannot place there'); Sound.error(); return; }
      pushUndo(); G.freecells[sc] = null; dc.push(card); G.selected = null;
      Sound.place(); renderAll(); return;
    }
  }
}

function undo() {
  if (autoCompleting || !G.undoStack.length || G.phase !== 'playing') return;
  Sound.undo(); const s = G.undoStack.pop();
  G.tableau = s.tableau; G.freecells = s.freecells; G.foundations = s.foundations;
  G.score = s.score; G.cardsScored = s.cardsScored; G.selected = s.selected; renderAll();
}

let autoCompleting = false;
let autoCompleteToken = 0;
function hasOrderedTableau() {
  return G.freecells.every(card => card === null) && G.tableau.every(col =>
    col.length === 0 || (col[0].rank === 13 && getSequenceLength(col) === col.length)
  );
}
function nextFoundationMove() {
  for (let ci = 0; ci < G.tableau.length; ci++) {
    const col = G.tableau[ci], card = col.at(-1);
    if (!card) continue;
    const foundation = G.foundations.findIndex(stack => canPlaceOnFoundation(card, stack));
    if (foundation !== -1) return { src:'tableau', col:ci, idx:col.length-1, foundation };
  }
  return null;
}
function autoComplete() {
  if (G.phase !== 'playing' || autoCompleting) return;
  if (!hasOrderedTableau()) {
    toast('Auto Complete is ready when every column is a King-down alternating run');
    return;
  }
  const token = ++autoCompleteToken;
  let moves = 0;
  autoCompleting = true;
  const step = () => {
    if (token !== autoCompleteToken || G.phase !== 'playing') {
      autoCompleting = false;
      return;
    }
    const move = nextFoundationMove();
    if (!move) {
      autoCompleting = false;
      toast(moves ? 'Auto-complete moved '+moves+' card'+(moves===1?'':'s') : 'No foundation cards ready');
      return;
    }
    G.selected = { src:move.src, col:move.col, idx:move.idx };
    G.autoStep = true;
    performMove('foundation', move.foundation);
    G.autoStep = false;
    moves++;
    setTimeout(step, 130);
  };
  step();
}

function checkBlindState() {
  if (G.phase !== 'playing' || G.foundations.reduce((s,f)=>s+f.length,0) < 52) return;
  if (G.score >= G.blindTarget) {
    const reward = gr(G.ante, G.blindIdx) + Math.min(5, Math.floor(G.money/5));
    G.money += reward; G.totalScore += G.score; Sound.win();
    if (G.blindIdx === 2 && G.ante >= 8) {
      G.phase='won'; showModal(renderWinScreen); renderAll(); return;
    }
    G.roundReward = reward;
    G.phase='blind-cleared';
    renderAll();
    showModal(renderBlindWinScreen);
  } else if (G.redeals > 0) {
    G.phase='blind-done'; renderAll(); showModal(renderFailScreen);
  } else {
    G.phase='lost'; renderAll(); showModal(renderGameOverScreen);
  }
}
function continueAfterBlind() {
  if (G.phase !== 'blind-cleared') return;
  closeModal();
  if (G.blindIdx === 2) { G.ante++; G.blindIdx = 0; }
  else G.blindIdx++;
  G.phase='shop';
  renderAll();
  showShop();
}

/* ---------------------------------------------------------
   8. SHOP
   --------------------------------------------------------- */
function genShop() {
  const pool = JOKER_IDS.filter(j => !G.jokers.some(o => o.id === j.id));
  if (!pool.length) return [];
  const items = [];
  for (let i = 0; i < 2 && pool.length; i++) {
    const tw = pool.reduce((s,j) => s + j.shopWeight, 0);
    let r = Math.random() * tw;
    for (let j = 0; j < pool.length; j++) {
      r -= pool[j].shopWeight;
      if (r <= 0) { items.push({...pool[j]}); pool.splice(j,1); break; }
    }
  }
  return items;
}
function showShop() { shopState = { jokers: genShop(), rerolls:0 }; showModal(renderShopModal); }
function rerollShop() {
  const c = 1 + shopState.rerolls;
  if (G.money < c) { toast('Not enough money'); Sound.error(); return; }
  G.money -= c; shopState.rerolls++; shopState.jokers = genShop();
  $('modal-content').innerHTML = renderShopModal();
}
function buyJoker(i) {
  const item = shopState.jokers[i]; if (!item) return;
  if (G.money < item.cost) { toast('Not enough money'); Sound.error(); return; }
  if (G.jokers.length >= effectiveJokerSlots(G)) { toast('Joker slots full'); Sound.error(); return; }
  G.money -= item.cost; G.jokers.push({id:item.id}); shopState.jokers.splice(i,1);
  $('modal-content').innerHTML = renderShopModal(); Sound.buy(); toast('Bought '+item.name+'!');
}
function skipShop() { closeModal(); Sound.deal(); dealBlind(); }

/* ---------------------------------------------------------
   9. HINT
   --------------------------------------------------------- */
function showHint() {
  if (G.phase !== 'playing') return;
  for (let fi = 0; fi < 4; fi++) {
    const f = G.foundations[fi];
    for (let ci = 0; ci < G.tableau.length; ci++) {
      const col = G.tableau[ci]; if (!col.length) continue;
      const c = col[col.length-1];
      if (canPlaceOnFoundation(c, f)) {
        G.selected = { src:'tableau', col:ci, idx:col.length-1 }; renderAll();
        toast('Hint: move '+RANK_LABEL[c.rank]+SUIT_SYM[c.suit]+' to foundation '+(fi+1)); return;
      }
    }
    for (let fc = 0; fc < G.freecells.length; fc++) {
      const c = G.freecells[fc]; if (!c) continue;
      if (canPlaceOnFoundation(c, f)) { G.selected = { src:'freecell', col:fc, idx:0 }; renderAll(); toast('Hint: free cell to foundation'); return; }
    }
  }
  toast('No obvious moves found');
}

/* ---------------------------------------------------------
   10. RENDERING
   --------------------------------------------------------- */
function $(id) { return document.getElementById(id); }
function renderAll() { renderTableau(); renderFrees(); renderFoundations(); renderJokers(); renderHUD(); renderSelection(); }

const pendingCardClicks = new WeakMap();
function queueCardClick(element, src, col, idx) {
  pendingCardClicks.set(element, setTimeout(() => {
    pendingCardClicks.delete(element);
    onCardClick(src, col, idx);
  }, 500));
}
function cancelCardClick(element) {
  const timer = pendingCardClicks.get(element);
  clearTimeout(timer);
  pendingCardClicks.delete(element);
}

function renderTableau() {
  const el = $('tableau'); el.innerHTML = '';
  const ch = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-h'))||100;
  const co = Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-olap'))||48);
  const step = Math.max(20, ch - co);
  for (let i = 0; i < 8; i++) {
    const col = G.tableau[i];
    const div = document.createElement('div'); div.className = 'tcol'; div.dataset.col = i;
    div.addEventListener('click', ()=>onTableauClick(i));
    if (col.length) div.style.minHeight = (ch + (col.length-1) * step) + 'px';
    col.forEach((card, j) => {
      const cd = mCard(card); cd.dataset.col = i; cd.dataset.idx = j;
      if (G.dealing) { cd.classList.add('deal-in'); cd.style.setProperty('--deal-delay', (i*35+j*12)+'ms'); }
      cd.addEventListener('click', e => {
        e.stopPropagation();
        if (e.detail === 1) queueCardClick(cd, 'tableau', i, j);
      });
      cd.addEventListener('dblclick', e => {
        e.preventDefault(); e.stopPropagation();
        cancelCardClick(cd); autoMoveCard('tableau', i, j);
      });
      div.appendChild(cd);
    });
    el.appendChild(div);
  }
}
function renderFrees() {
  const el = $('freecells'); el.innerHTML = '';
  const cap = effectiveFreeCells(G);
  for (let i = 0; i < cap; i++) {
    const s = document.createElement('div'); s.className = 'freecell-slot'+(G.freecells[i]?'':' empty'); s.dataset.fc = i;
    if (G.freecells[i]) { const cd=mCard(G.freecells[i]); cd.addEventListener('click',e=>{e.stopPropagation();if(e.detail===1)queueCardClick(cd,'freecell',i,0);}); cd.addEventListener('dblclick',e=>{e.preventDefault();e.stopPropagation();cancelCardClick(cd);autoMoveCard('freecell',i,0);}); s.appendChild(cd); }
    s.addEventListener('click',()=>onFreeClick(i)); el.appendChild(s);
  }
}
function renderFoundations() {
  const el = $('foundations'); el.innerHTML = '';
  ['S','H','D','C'].forEach((suit, i) => {
    const s = document.createElement('div'); s.className = 'foundation-slot'+(G.foundations[i].length?'':' empty')+(G.foundationPulse===i?' foundation-pop':''); s.dataset.fd = i;
    if (G.foundations[i].length) s.appendChild(mCard(G.foundations[i][G.foundations[i].length-1]));
    else { const d = document.createElement('span'); d.className='foundation-base-suit'; d.textContent=SUIT_SYM[suit]; s.appendChild(d); }
    s.addEventListener('click',()=>onFoundationClick(i)); el.appendChild(s);
  });
  G.foundationPulse = null;
}
function mCard(card) {
  const d = document.createElement('div'); d.className = 'card'; d.dataset.id = card.id;
  d.dataset.rank = card.rank; d.dataset.suit = card.suit;
  if (card.suit === 'H' || card.suit === 'D') d.classList.add('red');
  for (const position of ['top', 'bottom']) {
    const index = document.createElement('span'); index.className = 'card-index '+position;
    const rank = document.createElement('span'); rank.className='card-rank'; rank.textContent=RANK_LABEL[card.rank];
    const suit = document.createElement('span'); suit.className='card-suit'; suit.textContent=SUIT_SYM[card.suit];
    index.append(rank, suit); d.appendChild(index);
  }
  const pip = document.createElement('span'); pip.className='card-pip'; pip.textContent=SUIT_SYM[card.suit];
  d.appendChild(pip);
  return d;
}
function renderJokers() {
  const el = $('jokers'); el.innerHTML = '';
  const slots = effectiveJokerSlots(G);
  for (let i = 0; i < slots; i++) {
    const s = document.createElement('div'); s.className = 'joker-slot'+(i<G.jokers.length?' filled':' empty');
    if (i < G.jokers.length) {
      const j = G.jokers[i]; const def = JOKER_MAP[j.id];
      const r = document.createElement('span'); r.className='joker-rarity '+(def?def.rarity:'');
      const n = document.createElement('strong'); n.textContent=def?def.name:j.id;
      const d = document.createElement('small'); d.textContent=def?def.desc:'';
      s.appendChild(r); s.appendChild(n); s.appendChild(d);
    }
    el.appendChild(s);
  }
  $('joker-count').textContent = G.jokers.length+' / '+slots;
}
function renderHUD() {
  $('ante-value').textContent = G.ante+'/8'; $('money-value').textContent = '$'+G.money;
  $('redeal-value').textContent = G.redeals; $('score-value').textContent = G.score;
  $('target-value').textContent = G.blindTarget;
  $('score-meter-fill').style.width = Math.min(100, (G.score/G.blindTarget)*100)+'%';
  $('capacity-label').textContent = G.phase==='playing' ? 'Move up to '+maxMoveCapacity(G)+' cards' : G.phase==='validating' ? 'Validating a beatable deal…' : '—';
  const rb = $('redeal-button'); rb.disabled = !(G.redeals>0 && ['playing','blind-done'].includes(G.phase));
}
function renderSelection() {
  document.querySelectorAll('.selected').forEach(e=>e.classList.remove('selected'));
  if (!G.selected) return;
  if (G.selected.src === 'tableau') {
    const ce = document.querySelector('.tcol[data-col="'+G.selected.col+'"]');
    if (ce) { const kids = ce.querySelectorAll('.card'); const c = kids[G.selected.idx]; if (c) c.classList.add('selected'); }
  } else {
    const t = document.querySelector('.freecell-slot[data-fc="'+G.selected.col+'"] .card');
    if (t) t.classList.add('selected');
  }
}
function updateBlindUI() {
  if (G.phase === 'validating') {
    $('blind-kicker').textContent = 'Preparing Blind';
    $('blind-name').textContent = 'Validating…';
    $('blind-icon').textContent = '♠';
    $('blind-icon').className = 'blind-icon validating';
    $('boss-effect').style.display = 'none';
    return;
  }
  const isBoss = G.blindIdx === 2;
  $('blind-kicker').textContent = BLIND_NAMES[G.blindIdx];
  const bn = bossName(G.ante);
  if (isBoss && bn) {
    $('blind-name').textContent = bn; $('blind-icon').textContent = '◆'; $('blind-icon').className = 'blind-icon boss';
    const be = bossEffect(G.ante); $('boss-effect').textContent = be ? be() : ''; $('boss-effect').style.display = 'inline';
  } else {
    $('blind-name').textContent = 'The Opening'; $('blind-icon').textContent = '●'; $('blind-icon').className = 'blind-icon';
    $('boss-effect').style.display = 'none';
  }
}

/* ---------------------------------------------------------
   11. EVENTS
   --------------------------------------------------------- */
function autoMoveCard(src, col, idx) {
  if (G.phase !== 'playing' || autoCompleting) return;
  const card = src === 'tableau' ? G.tableau[col]?.[idx] : G.freecells[col];
  if (!card) return;

  const selectCard = () => { G.selected = { src, col, idx }; };
  const foundationIndex = G.foundations.findIndex(foundation => canPlaceOnFoundation(card, foundation));
  if (foundationIndex !== -1 && (src === 'freecell' || idx === G.tableau[col].length - 1)) {
    selectCard();
    performMove('foundation', foundationIndex);
    return;
  }

  const sequenceLength = src === 'tableau' ? G.tableau[col].length - idx : 1;
  const movableSequence = src === 'freecell' || (
    getSequenceLength(G.tableau[col]) >= sequenceLength &&
    (sequenceLength === 1 || sequenceLength <= maxMoveCapacity(G))
  );
  if (movableSequence) {
    for (const preferEmpty of [false, true]) {
      for (let destination = 0; destination < G.tableau.length; destination++) {
        const target = G.tableau[destination];
        if (destination === col || Boolean(target.length) === preferEmpty || !canPlaceOnTableau(card, target)) continue;
        if (src === 'tableau' && sequenceLength > 1) {
          const emptyColumns = G.tableau.filter(column => column.length === 0).length;
          const capacity = (1 + G.freecells.filter(cell => cell === null).length) *
            Math.pow(2, target.length === 0 ? Math.max(0, emptyColumns - 1) : emptyColumns);
          if (sequenceLength > capacity) continue;
        }
        selectCard();
        performMove('tableau', destination);
        return;
      }
    }
  }

  if (src === 'tableau' && sequenceLength === 1) {
    const freeCell = G.freecells.findIndex(cell => cell === null);
    if (freeCell !== -1) {
      selectCard();
      performMove('freecell', freeCell);
      return;
    }
  }
  toast('No automatic move available');
}

function onCardClick(src, col, idx) {
  if (G.phase !== 'playing') return;
  if (G.selected) {
    if (G.selected.src===src && G.selected.col===col && G.selected.idx===idx) { G.selected=null; renderAll(); return; }
    if (G.selected.src===src && G.selected.col===col) { select(src,col,idx); return; }
    if (src==='tableau' && idx===G.tableau[col].length-1) { performMove('tableau',col); return; }
    select(src,col,idx); return;
  }
  select(src,col,idx);
}
function onTableauClick(ci) { if (G.selected) performMove('tableau', ci); }
function onFreeClick(fi) {
  if (G.phase !== 'playing') return;
  if (G.selected) { performMove('freecell', fi); return; }
  if (G.freecells[fi]) select('freecell', fi, 0);
}
function onFoundationClick(fi) {
  if (G.phase !== 'playing') return;
  if (G.selected) { performMove('foundation', fi); return; }
  for (let ci = 0; ci < G.tableau.length; ci++) {
    const col = G.tableau[ci]; if (!col.length) continue;
    const c = col[col.length-1];
    if (canPlaceOnFoundation(c, G.foundations[fi])) { G.selected={src:'tableau',col:ci,idx:col.length-1}; performMove('foundation',fi); return; }
  }
  for (let fc = 0; fc < G.freecells.length; fc++) {
    const c = G.freecells[fc]; if (!c) continue;
    if (canPlaceOnFoundation(c, G.foundations[fi])) { G.selected={src:'freecell',col:fc,idx:0}; performMove('foundation',fi); return; }
  }
  toast('No card available for that foundation');
}

/* ---------------------------------------------------------
   12. UI EXTRAS
   --------------------------------------------------------- */
function showScorePop(total, card) {
  const p = $('score-pop'); $('chips-readout').textContent = card.rank;
  $('mult-readout').textContent = total > 0 ? Math.round(total/card.rank) : 1;
  p.classList.remove('pop'); void p.offsetWidth; p.classList.add('pop');
}
function toast(msg) {
  const e = $('toast'); e.textContent = msg; e.classList.remove('show'); void e.offsetWidth; e.classList.add('show');
  clearTimeout(e._timer); e._timer = setTimeout(() => e.classList.remove('show'), 2000);
}
function showModal(fn) { $('modal-content').innerHTML = fn(); $('modal').showModal(); }
function closeModal() { $('modal').close(); }

function renderShopModal() {
  let h = '<div class="modal-shop"><h2>🛒 Shop</h2><p>Money: <strong>$'+G.money+'</strong></p><div class="shop-items">';
  for (let i = 0; i < shopState.jokers.length; i++) {
    const j = shopState.jokers[i]; const can = G.money >= j.cost; const full = G.jokers.length >= effectiveJokerSlots(G);
    h += '<div class="shop-item '+(can&&!full?'':'disabled')+'"><div class="shop-item-rarity '+j.rarity+'"></div><strong>'+j.name+'</strong><small>'+j.desc+'</small><div class="shop-item-footer">$'+j.cost+' · '+j.rarity+'</div><button onclick="buyJoker('+i+')"'+(can&&!full?'':' disabled')+'>'+(can?full?'Slots full':'Buy':'Need $'+(j.cost-G.money))+'</button></div>';
  }
  h += '</div><div class="modal-actions"><button class="button ghost" onclick="rerollShop()"'+(G.money<1+shopState.rerolls?' disabled':'')+'>Reroll ($'+(1+shopState.rerolls)+')</button><button class="button primary" onclick="skipShop()">Continue →</button></div></div>';
  return h;
}
function renderBlindWinScreen() {
  const blind = BLIND_NAMES[G.blindIdx];
  return '<div class="modal-result round-celebration"><h2>★ '+blind+' Cleared!</h2><p>Score: <strong>'+G.score+' / '+G.blindTarget+'</strong></p><p class="reward">+$'+G.roundReward+'</p><div class="modal-actions"><button class="button primary" onclick="continueAfterBlind()">Collect & Continue</button></div></div>';
}

function renderFailScreen() {
  return '<div class="modal-result"><h2>✗ Need '+G.blindTarget+' (got '+G.score+')</h2><p>'+(G.redeals?'You have '+G.redeals+' redeal'+(G.redeals!==1?'s':'')+' left.':'No redeals remain.')+'</p><div class="modal-actions">'+(G.redeals?'<button class="button primary" onclick="redeal(); closeModal();">Redeal ('+G.redeals+' left)</button>':'')+'<button class="button danger" onclick="giveUp()">Give Up</button></div></div>';
}
function renderGameOverScreen() {
  return '<div class="modal-result"><h2>💀 Run Over</h2><p>Ante '+G.ante+', Blind '+(G.blindIdx+1)+'</p><p>Total score: '+(G.totalScore+G.score)+'</p><div class="modal-actions"><button class="button primary" onclick="closeModal();newRun();">New Run</button></div></div>';
}
function renderWinScreen() {
  return '<div class="modal-result win"><h2>🏆 Victory!</h2><p>You beat all 8 Antes!</p><div class="modal-actions"><button class="button primary" onclick="closeModal();newRun();">Play Again</button></div></div>';
}

/* ---------------------------------------------------------
   13. INIT
   --------------------------------------------------------- */
function init() {
  $('undo-button').addEventListener('click', undo);
  $('hint-button').addEventListener('click', showHint);
  $('autocomplete-button').addEventListener('click', autoComplete);
  $('redeal-button').addEventListener('click', redeal);
  $('skip-button').addEventListener('click', skipDeal);
  $('new-run-button').addEventListener('click', ()=>{ closeModal(); newRun(); });
  $('modal').addEventListener('cancel', e => e.preventDefault());
  window.buyJoker=buyJoker; window.rerollShop=rerollShop; window.skipShop=skipShop;
  window.redeal=()=>{redeal();}; window.closeModal=closeModal; window.newRun=newRun;
  window.continueAfterBlind=continueAfterBlind;
  window.giveUp=function(){ closeModal(); G.phase='lost'; renderAll(); showModal(renderGameOverScreen); };
  newRun();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
