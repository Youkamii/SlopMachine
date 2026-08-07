/**
 * HOMEROW
 *
 * The arena is a QWERTY keyboard. Pressing a key teleports you to that key's
 * physical position, so typing real words draws movement routes across the
 * board — `SAD` is a short safe hop, `POLYGON` is a sprint across the whole
 * arena.
 *
 * Everything is keyed off KeyboardEvent.code, which is physical position, so
 * the game plays identically on AZERTY or Dvorak. On touch the drawn board
 * *is* the keyboard, which makes this one of the rare typing games that is
 * better with a thumb than with ten fingers.
 */

import { monoFont, uiFont } from "@/engine/draw";
import {
  TAU,
  clamp,
  clamp01,
  damp,
  easeOutCubic,
  easeOutQuart,
  lerp,
  pulse,
} from "@/engine/math";
import type { GameContext, GameFactory, GameInstance } from "@/games/types";

// --- palette ----------------------------------------------------------------

const BOARD = "#0d1424";
const BOARD_DEEP = "#070b14";
const CAP = "#1b2942";
const CAP_TOP = "#243550";
const LEGEND = "#c9d8f2";
const PLAYER = "#5ce1e6";
const DANGER = "#ff3b6b";
const WORD = "#ffd166";

// --- layout -----------------------------------------------------------------

const ROWS = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];
/** Standard stagger, in key widths. */
const ROW_OFFSET = [0, 0.35, 0.85];

interface Key {
  ch: string;
  code: string;
  row: number;
  col: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0..1, decays — drives the depress animation. */
  press: number;
  /** Seconds until this key detonates. 0 = safe. */
  fuse: number;
  fuseMax: number;
}

/**
 * A deliberately small lexicon. 150 well-chosen words beat 50,000 random ones:
 * every entry here is common enough that finding it feels like recall rather
 * than luck, and short enough to type under pressure.
 */
const LEXICON = new Set(
  ("ace act add age aid aim air ale all and ant any ape arc are arm art ash ask " +
    "bad bag ban bar bat bay bed bee beg bet bid big bit bow box boy bug bun bus " +
    "cab can cap car cat cod cog cop cot cow cry cub cue cup cut " +
    "dam day den dew dig dim dip dog dot dry dub dug duo dye " +
    "ear eat ebb eel egg ego elf elk elm end eve eye " +
    "fan far fat fax fed fee few fig fin fir fit fix fly fog for fox fry fun fur " +
    "gap gas gel gem get gig gin got gum gun gut guy gym " +
    "hat hay hen her hex hid him hip hit hog hop hot how hub hug hum hut " +
    "ice icy ink inn ion ire irk ivy jab jam jar jaw jet jig job jog joy jug " +
    "keg key kid kin kit lab lad lag lap law lax lay led leg let lid lie lip lit " +
    "log lot low mad man map mat maw men met mix mob mop mow mud mug " +
    "nab nag nap net new nib nil nip nod nor not now nun nut oak oar oat odd " +
    "off oil old one opt orb ore our out owl own " +
    "pad pan par pat paw pay pea peg pen pet pie pig pin pit ply pod pot pry pub pun put " +
    "rag ram ran rap rat raw ray red rib rid rig rim rip rob rod rot row rub rug rum run rut " +
    "sad sag sap sat saw say sea set sew she shy sin sip sir sit six ski sky sly sob sod son sow soy spa spy sty sub sum sun " +
    "tab tag tan tap tar tax tea ten the thy tie tin tip toe ton top tow toy try tub tug two " +
    "urn use van vat vex via vow wag war was wax way web wed wet who why wig win wit woe wok won wry " +
    "yak yam yap yes yet yew you zap zen zip zoo " +
    "able acid aged also area army away baby back ball band bank bare bark barn base bath beam bean bear beat been beer bell belt bend best bike bill bind bird bite blow blue boat body boil bold bolt bond bone book boot bore born boss both bowl brag bred brew brow buck bulk bull burn bury bush busy " +
    "cage cake calf call calm came camp cane cape card care cart case cash cast cave cell chat chef chew chin chip chop city clam clan claw clay clip club clue coal coat code coil coin cold colt comb come cook cool cope copy cord core cork corn cost cove crab crew crib crop crow cube cuff cult curb cure curl cute " +
    "dare dark dart dash data date dawn deal dean dear debt deck deed deep deer defy dent deny desk dial dice diet dime dine dirt dish disk dive dock does dole doll dome done doom door dose dove down drag draw drew drip drop drum dual duck duel dull dumb dune dusk dust duty " +
    "each earl earn ease east easy edge edit eels envy epic even ever evil exam exit face fact fade fail fair fake fall fame fang farm fast fate fawn fear feat feed feel fell felt fern feud file fill film find fine fire firm fish fist five flag flat flaw flea fled flee flew flex flip flow foam foil fold folk fond font food fool foot ford fore fork form fort foul four fowl free frog from fuel full fume fund fury fuse " +
    "gain gait gale game gang gape gate gave gaze gear gene gift gild gill girl give glad glee glow glue goal goat gold golf gone good gown grab gram gray grew grid grim grin grip grit grow gulf gull gust " +
    "hail hair half hall halt hand hang hard hare harm harp hart hate haul have hawk haze head heal heap hear heat heed heel heir held helm help herb herd here hero hide high hike hill hilt hind hint hire hive hold hole holy home hone hood hoof hook hoop hope horn hose host hour howl hued hulk hull hunt hurl hurt hush husk hymn " +
    "idea idle idol inch into iron isle item jade jail jazz jeep jerk jest jibe join joke jolt jump junk jury just keel keen keep kelp kept kick kiln kind king kiss kite knee knew knit knob knot know " +
    "lace lack lady laid lair lake lamb lame lamp land lane lark lash last late lava lawn laze lead leaf leak lean leap left lend lens lent less lest life lift like limb lime limp line link lint lion list live load loaf loan lock loft logo lone long look loom loop loot lord lore lose loss lost loud love luck lull lump lung lure lurk lush lute " +
    "made maid mail main make male mall malt mane many mare mark mars mash mask mass mast mate math maze mead meal mean meat meek meet melt memo mend menu mere mesh mess mice mild mile milk mill mind mine mint mist mite moan moat mock mode mold mole monk mood moon moor moss most moth move much mule mush must mute myth " +
    "nail name nape navy near neat neck need neon nest news next nice nick nine node none nook noon norm nose note noun null numb " +
    "oath obey odds oily omen once only onto onyx open oral ouch ours oust oval oven over owed owes owns " +
    "pace pack pact page paid pail pain pair pale palm pane pang pant park part pass past path pave pawn peak peal pear peat peck peel peer pelt pend perk pest pick pier pike pile pill pine pink pint pipe pity plan play plea plot plow plug plum plus poem poet poke pole poll pond pony pool poor pope pore pork port pose post pour pout pray prey prim prod prop prow pull pulp pump punk pure push " +
    "quit quiz race rack raft rage raid rail rain rake ramp rang rank rant rare rash rate rave read real reap rear reed reef reek reel rein rely rend rent rest ribs rice rich ride rift rile rime rind ring riot ripe rise risk rite road roam roar robe rock rode roll romp roof rook room root rope rose rosy rout rove rude ruin rule rung runt ruse rush rust " +
    "sack safe sage said sail sake sale salt same sand sane sang sank sash save scan scar seal seam sear seat sect seed seek seem seen seep self sell send sent sept sewn shed shin ship shoe shop shot show shut sick side sift sigh sign silk sill silo silt sing sink site size skew skid skim skin skip slab slam slap slat sled slew slid slim slip slit slot slow slug slum smog snag snap snip snow snug soak soap soar sock soda sofa soft soil sold sole solo some song soon soot sore sort soul soup sour sown span spar spat sped spin spit spot spun spur stab stag star stay stem step stew stir stop stow stub stud stun such suit sunk sure surf swam swan swap sway swim " +
    "tack tact tail take tale talk tall tame tank tape taps task teak teal team tear teem tell tend tent term test text than that thaw them then they thin this thud thug thus tick tide tidy tied tier tile till tilt time tine tint tiny tire toad toil told toll tomb tone tong took tool toot tore torn tort toss tour tout town trap tray tree trek trim trio trip trot true tuba tube tuck tuft tuna tune turf turn tusk twig twin twit type " +
    "ugly undo unit upon urge used user vain vale vane vase vast veal veer veil vein vend vent verb very vest veto vial vice view vine visa void volt vote " +
    "wade wage wail wait wake walk wall wand wane want ward ware warm warn warp wart wary wash wasp watt wave wavy waxy weak wean wear weed week weep weld well welt went wept were west what when whim whip whir whom wick wide wife wild will wilt wind wine wing wink wipe wire wise wish wisp with woke wolf wood wool word wore work worm worn wrap wren writ " +
    "yard yarn yawn year yell yoke your zeal zero zest zinc zone zoom"
  ).split(" "),
);

type Phase = "title" | "playing" | "dead";

type HazardShape = "row" | "column" | "scatter" | "neighbours" | "sweep";

interface Trail {
  x: number;
  y: number;
  life: number;
}

class Homerow implements GameInstance {
  private readonly c: GameContext;

  private w = 0;
  private h = 0;

  private keys: Key[] = [];
  private byCode = new Map<string, Key>();
  private keyW = 0;
  private keyH = 0;
  private boardTop = 0;

  private phase: Phase = "title";
  private time = 0;
  private titleTime = 0;
  private deadTime = 0;

  /** Index into `keys` of the key the player currently occupies. */
  private at = 0;
  /** Animated position, so a jump reads as an arc rather than a teleport. */
  private px = 0;
  private py = 0;
  private hopFrom = { x: 0, y: 0 };
  private hopTo = { x: 0, y: 0 };
  private hopT = 1;

  private typed: string[] = [];
  private lastWord = "";
  private lastWordTime = -10;
  private wordFlash = 0;

  private score = 0;
  private best = 0;
  private bestWord = "";
  private words = 0;
  private hazardTimer = 0;
  private wave = 0;
  private shield = 0;

  private trails: Trail[] = [];

  constructor(ctx: GameContext) {
    this.c = ctx;
    this.best = ctx.store.best("best") ?? 0;
    this.bestWord = ctx.store.get<string>("bestWord", "");
    this.buildKeys();
    ctx.report({ status: "idle", score: 0 });
  }

  private buildKeys() {
    this.keys = [];
    this.byCode.clear();
    for (let r = 0; r < ROWS.length; r++) {
      const row = ROWS[r];
      for (let i = 0; i < row.length; i++) {
        const ch = row[i];
        const key: Key = {
          ch,
          code: `Key${ch}`,
          row: r,
          col: i,
          x: 0, y: 0, w: 0, h: 0,
          press: 0,
          fuse: 0,
          fuseMax: 1,
        };
        this.keys.push(key);
        this.byCode.set(key.code, key);
      }
    }
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;

    const maxBoardW = Math.min(w * 0.92, 860);
    const gap = 6;
    this.keyW = (maxBoardW - gap * 9) / 10;
    this.keyH = Math.min(this.keyW, (h * 0.42) / 3 - gap);

    const boardW = this.keyW * 10 + gap * 9;
    const boardH = this.keyH * 3 + gap * 2;
    const left = (w - boardW) / 2;
    // Sits slightly below centre so the HUD and the typed-letter readout above
    // the board do not make the whole composition feel top-heavy.
    this.boardTop = h * 0.56 - boardH / 2;

    for (const k of this.keys) {
      const rowLen = ROWS[k.row].length;
      const rowW = this.keyW * rowLen + gap * (rowLen - 1);
      const rowLeft =
        k.row === 0 ? left : left + ROW_OFFSET[k.row] * (this.keyW + gap);
      // Centre short rows within the board rather than hard-left them.
      const centred = k.row === 0 ? rowLeft : Math.min(rowLeft, left + (boardW - rowW));
      k.w = this.keyW;
      k.h = this.keyH;
      k.x = centred + k.col * (this.keyW + gap);
      k.y = this.boardTop + k.row * (this.keyH + gap);
    }

    const cur = this.keys[this.at];
    if (cur) {
      this.px = cur.x + cur.w / 2;
      this.py = cur.y + cur.h / 2;
      this.hopFrom = { x: this.px, y: this.py };
      this.hopTo = { x: this.px, y: this.py };
    }
  }

  private centreOf(k: Key) {
    return { x: k.x + k.w / 2, y: k.y + k.h / 2 };
  }

  restart() {
    this.phase = "playing";
    this.time = 0;
    this.deadTime = 0;
    this.score = 0;
    this.words = 0;
    this.wave = 0;
    this.shield = 0;
    this.hazardTimer = 1.6;
    this.typed.length = 0;
    this.lastWord = "";
    this.lastWordTime = -10;
    this.wordFlash = 0;
    this.trails.length = 0;
    for (const k of this.keys) {
      k.fuse = 0;
      k.press = 0;
    }
    // Start on F — index finger home position, and centrally placed.
    this.at = this.keys.findIndex((k) => k.ch === "F");
    if (this.at < 0) this.at = 0;
    const c = this.centreOf(this.keys[this.at]);
    this.px = c.x;
    this.py = c.y;
    this.hopFrom = { ...c };
    this.hopTo = { ...c };
    this.hopT = 1;
    this.c.report({ status: "playing", score: 0 });
  }

  // --- update ---------------------------------------------------------------

  update(dt: number) {
    const { input } = this.c;

    if (this.phase === "title") {
      this.titleTime += dt;
      if (
        this.titleTime > 0.25 &&
        (input.pointer.justUp || input.justPressed.size > 0)
      ) {
        this.c.audio.play({
          wave: "triangle", freq: 260, freqTo: 620, glide: 0.16,
          vol: 0.18, attack: 0.004, hold: 0.04, release: 0.2,
        });
        this.restart();
      }
      return;
    }

    if (this.phase === "dead") {
      this.deadTime += dt;
      this.decayKeys(dt);
      if (
        this.deadTime > 0.7 &&
        (input.pointer.justUp || input.justPressed.size > 0)
      ) {
        this.restart();
      }
      return;
    }

    this.time += dt;
    this.handleInput();
    this.advanceHop(dt);
    this.runHazards(dt);
    this.decayKeys(dt);

    if (this.shield > 0) this.shield -= dt;
    if (this.wordFlash > 0) this.wordFlash -= dt;

    for (let i = this.trails.length - 1; i >= 0; i--) {
      this.trails[i].life -= dt;
      if (this.trails[i].life <= 0) this.trails.splice(i, 1);
    }

    this.score = Math.floor(this.time * 10) + this.words * 120;
    this.c.report({ score: this.score });
  }

  private handleInput() {
    const { input } = this.c;

    // Physical key positions: `code` is what makes this work on any layout.
    for (const code of input.justPressed) {
      const key = this.byCode.get(code);
      if (key) this.jumpTo(key);
    }

    // Touch: the drawn board is the keyboard.
    if (input.pointer.justDown) {
      const p = input.pointer;
      for (const k of this.keys) {
        if (p.x >= k.x && p.x <= k.x + k.w && p.y >= k.y && p.y <= k.y + k.h) {
          this.jumpTo(k);
          break;
        }
      }
    }
  }

  private jumpTo(key: Key) {
    const { audio, fx } = this.c;
    const target = this.keys.indexOf(key);
    if (target < 0 || target === this.at) {
      // Re-pressing the key you stand on is a wasted move, not a free one.
      key.press = 1;
      audio.play({
        wave: "noise", freq: 900, vol: 0.05,
        attack: 0.001, hold: 0.004, release: 0.03, filter: 4000, filterType: "highpass",
      });
      return;
    }

    const from = this.centreOf(this.keys[this.at]);
    const to = this.centreOf(key);
    this.hopFrom = from;
    this.hopTo = to;
    this.hopT = 0;
    this.at = target;
    key.press = 1;

    this.typed.push(key.ch.toLowerCase());
    if (this.typed.length > 8) this.typed.shift();
    this.checkWord();

    // Mechanical switch: a bright click transient plus a low thock, pitched
    // by column so running across the board sounds like running across a board.
    const pitch = 1 + (key.col / 10) * 0.35 - key.row * 0.06;
    audio.play({
      wave: "noise", freq: 2600 * pitch, vol: 0.09,
      attack: 0.0008, hold: 0.004, release: 0.022,
      filter: 3200, filterType: "highpass",
    });
    audio.play({
      wave: "sine", freq: 132 * pitch, freqTo: 88 * pitch, glide: 0.05,
      vol: 0.13, attack: 0.001, hold: 0.012, release: 0.06,
    });

    fx.emit(to.x, to.y, {
      count: 5, speed: 90, life: 0.26, size: 1.6,
      color: [PLAYER, LEGEND], drag: 5, additive: true,
    });
  }

  private checkWord() {
    const { audio, fx } = this.c;
    // Longest match wins, so TOWER scores instead of stopping at TOW.
    for (let len = Math.min(8, this.typed.length); len >= 3; len--) {
      const candidate = this.typed.slice(this.typed.length - len).join("");
      if (!LEXICON.has(candidate)) continue;
      if (candidate === this.lastWord && this.time - this.lastWordTime < 2.5) {
        // Don't let one word be farmed by re-typing its tail.
        return;
      }

      this.words++;
      this.lastWord = candidate;
      this.lastWordTime = this.time;
      this.wordFlash = 0.6;
      this.shield = Math.max(this.shield, 0.9);

      // Defusing is the reward: a word clears every fuse it spelled across.
      let cleared = 0;
      for (const ch of candidate.toUpperCase()) {
        const k = this.keys.find((v) => v.ch === ch);
        if (k && k.fuse > 0) {
          k.fuse = 0;
          cleared++;
          fx.emit(k.x + k.w / 2, k.y + k.h / 2, {
            count: 8, speed: 130, life: 0.4, size: 2.2,
            color: [WORD, LEGEND], drag: 3.4, additive: true,
          });
        }
      }

      fx.flash(WORD, 0.09);
      fx.shake(5, 6);
      const mid = this.centreOf(this.keys[this.at]);
      fx.text(mid.x, mid.y - this.keyH, candidate.toUpperCase(), WORD, 18);

      [0, 4, 7, 11].forEach((s, i) =>
        audio.play({
          wave: "square", freq: 523 * Math.pow(2, s / 12),
          vol: 0.11, attack: 0.002, hold: 0.03, release: 0.16, delay: i * 0.045,
        }),
      );

      if (candidate.length > this.bestWord.length) {
        this.bestWord = candidate;
        this.c.store.set("bestWord", candidate);
      }
      void cleared;
      return;
    }
  }

  private advanceHop(dt: number) {
    if (this.hopT >= 1) {
      this.px = this.hopTo.x;
      this.py = this.hopTo.y;
      return;
    }
    // Distance-scaled duration: a hop to a neighbour is snappy, a leap across
    // the board takes long enough to read as travel.
    const span = Math.hypot(
      this.hopTo.x - this.hopFrom.x,
      this.hopTo.y - this.hopFrom.y,
    );
    const duration = clamp(0.055 + span / 3400, 0.06, 0.19);
    this.hopT = clamp01(this.hopT + dt / duration);
    const e = easeOutQuart(this.hopT);
    this.px = lerp(this.hopFrom.x, this.hopTo.x, e);
    this.py = lerp(this.hopFrom.y, this.hopTo.y, e);
    // Arc height scales with distance — long words visibly vault.
    this.py -= pulse(this.hopT) * Math.min(span * 0.22, this.keyH * 1.6);

    this.trails.push({ x: this.px, y: this.py, life: 0.28 });
    if (this.trails.length > 40) this.trails.shift();
  }

  // --- hazards --------------------------------------------------------------

  private get intensity() {
    return clamp01(this.time / 100);
  }

  private runHazards(dt: number) {
    this.hazardTimer -= dt;
    if (this.hazardTimer <= 0) {
      this.spawnHazard();
      const k = this.intensity;
      this.hazardTimer = lerp(1.9, 0.72, k) * this.c.rng.range(0.85, 1.15);
    }

    for (const key of this.keys) {
      if (key.fuse <= 0) continue;
      key.fuse -= dt;
      if (key.fuse > 0) continue;
      this.detonate(key);
    }
  }

  private spawnHazard() {
    const r = this.c.rng;
    const k = this.intensity;
    this.wave++;

    const shapes: HazardShape[] = ["scatter", "row"];
    if (this.time > 10) shapes.push("neighbours");
    if (this.time > 20) shapes.push("column");
    if (this.time > 32) shapes.push("sweep");
    const shape = r.pick(shapes);

    // Warning time shrinks with difficulty but never below reaction speed.
    const warn = lerp(1.55, 0.85, k);
    const targets: Key[] = [];

    switch (shape) {
      case "row": {
        const row = r.int(0, 2);
        for (const key of this.keys) if (key.row === row) targets.push(key);
        break;
      }
      case "column": {
        const col = r.int(0, 9);
        for (const key of this.keys) {
          if (Math.abs(key.col - col) <= (r.bool(0.4) ? 1 : 0)) targets.push(key);
        }
        break;
      }
      case "scatter": {
        const n = Math.round(lerp(4, 11, k));
        const pool = this.keys.slice();
        r.shuffle(pool);
        for (let i = 0; i < n && i < pool.length; i++) targets.push(pool[i]);
        break;
      }
      case "neighbours": {
        // Ring around the player: forces a real move, never an instant death.
        const me = this.keys[this.at];
        for (const key of this.keys) {
          const dx = Math.abs(key.x - me.x);
          const dy = Math.abs(key.y - me.y);
          if (dx <= this.keyW * 1.6 && dy <= this.keyH * 1.3 && key !== me) {
            targets.push(key);
          }
        }
        break;
      }
      case "sweep": {
        // A moving wall: successive columns light with staggered fuses.
        const dir = r.sign();
        for (const key of this.keys) {
          const idx = dir > 0 ? key.col : 9 - key.col;
          key.fuse = Math.max(key.fuse, warn + idx * 0.11);
          key.fuseMax = key.fuse;
        }
        this.c.audio.play({
          wave: "sawtooth", freq: 130, freqTo: 90, glide: 0.5,
          vol: 0.1, attack: 0.02, hold: 0.1, release: 0.3, filter: 900,
        });
        return;
      }
    }

    // The key under the player is never armed by a fresh hazard — you must be
    // able to lose by reacting badly, not by having stood somewhere.
    const me = this.keys[this.at];
    for (const key of targets) {
      if (key === me && shape !== "row" && shape !== "column") continue;
      key.fuse = Math.max(key.fuse, warn);
      key.fuseMax = key.fuse;
    }

    this.c.audio.play({
      wave: "square", freq: 190, vol: 0.06,
      attack: 0.004, hold: 0.03, release: 0.1, filter: 1200,
    });
  }

  private detonate(key: Key) {
    const { fx, audio } = this.c;
    key.fuse = 0;
    const cx = key.x + key.w / 2;
    const cy = key.y + key.h / 2;

    fx.emit(cx, cy, {
      count: 10, speed: 200, life: 0.36, size: 2.4,
      color: [DANGER, "#ff8fa8"], drag: 3.2, additive: true,
    });
    audio.play({
      wave: "noise", freq: 700, freqTo: 160, vol: 0.11,
      attack: 0.001, hold: 0.02, release: 0.12, filter: 2000, filterTo: 400,
    });

    const standing = this.keys[this.at] === key;
    if (standing && this.hopT >= 0.55) {
      if (this.shield > 0) {
        this.shield = 0;
        fx.flash(WORD, 0.12);
        fx.shake(8, 6);
        audio.play({
          wave: "square", freq: 660, freqTo: 990, glide: 0.1,
          vol: 0.14, attack: 0.002, hold: 0.03, release: 0.14,
        });
        return;
      }
      this.die();
    }
  }

  private decayKeys(dt: number) {
    for (const k of this.keys) {
      if (k.press > 0) k.press = damp(k.press, 0, 0.35, dt);
    }
  }

  private die() {
    const { fx, audio } = this.c;
    if (this.phase !== "playing") return;
    this.phase = "dead";
    this.deadTime = 0;

    fx.shake(22, 3.6);
    fx.freeze(0.13);
    fx.flash(DANGER, 0.16);
    fx.emit(this.px, this.py, {
      count: 40, speed: 320, speedVar: 0.8, life: 0.85, lifeVar: 0.5,
      size: 3, color: [DANGER, PLAYER, LEGEND], drag: 1.9, additive: true,
    });

    audio.explode(0.3);
    audio.play({
      wave: "sawtooth", freq: 260, freqTo: 42, glide: 0.6,
      vol: 0.22, attack: 0.005, hold: 0.12, release: 0.5,
      filter: 1500, filterTo: 180,
    });

    if (this.c.store.recordBest("best", this.score)) this.best = this.score;
    this.c.store.bump("plays");
    this.c.report({ status: "over", score: this.score, best: this.best });
  }

  // --- render ---------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D) {
    const { fx } = this.c;
    ctx.fillStyle = BOARD_DEEP;
    ctx.fillRect(0, 0, this.w, this.h);

    const g = ctx.createRadialGradient(
      this.w / 2, this.h * 0.52, 0,
      this.w / 2, this.h * 0.52, Math.max(this.w, this.h) * 0.7,
    );
    g.addColorStop(0, BOARD);
    g.addColorStop(1, BOARD_DEEP);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);

    fx.pushCamera(ctx, this.w / 2, this.h / 2);

    this.drawKeys(ctx);
    if (this.phase !== "title") {
      this.drawTrail(ctx);
      this.drawPlayer(ctx);
    }
    fx.drawParticles(ctx);
    fx.drawTexts(ctx, "ui-monospace, monospace");

    fx.popCamera(ctx);

    if (this.phase === "playing") this.drawHud(ctx);
    if (this.phase === "title") this.drawTitle(ctx);
    if (this.phase === "dead") this.drawGameOver(ctx);

    fx.drawFlash(ctx, this.w, this.h);
  }

  private drawKeys(ctx: CanvasRenderingContext2D) {
    const legendSize = Math.max(10, this.keyH * 0.34);
    for (const k of this.keys) {
      const sink = k.press * 2.4;
      const x = k.x;
      const y = k.y + sink;
      const armed = k.fuse > 0;
      const heat = armed ? 1 - clamp01(k.fuse / Math.max(k.fuseMax, 0.001)) : 0;

      // Cap shadow gives the board depth without a shadowBlur call.
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.beginPath();
      ctx.roundRect(x, k.y + 3, k.w, k.h, 6);
      ctx.fill();

      ctx.beginPath();
      ctx.roundRect(x, y, k.w, k.h - sink, 6);
      if (armed) {
        // Ramps toward danger as the fuse burns down, so urgency is readable
        // from colour alone without watching a timer.
        const flick = heat > 0.75 ? 0.5 + Math.sin(this.time * 40) * 0.5 : 1;
        ctx.fillStyle = `rgba(${lerp(27, 255, heat) | 0},${lerp(41, 59, heat) | 0},${lerp(66, 107, heat) | 0},${0.65 + heat * 0.35 * flick})`;
      } else {
        ctx.fillStyle = k.press > 0.1 ? CAP_TOP : CAP;
      }
      ctx.fill();

      ctx.lineWidth = 1;
      ctx.strokeStyle = armed
        ? `rgba(255,59,107,${0.35 + heat * 0.6})`
        : "rgba(201,216,242,0.09)";
      ctx.stroke();

      ctx.font = monoFont(legendSize, 600);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = armed
        ? `rgba(255,255,255,${0.6 + heat * 0.4})`
        : "rgba(201,216,242,0.55)";
      ctx.fillText(k.ch, x + k.w / 2, y + (k.h - sink) / 2 + 0.5);
    }
  }

  private drawTrail(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const t of this.trails) {
      const a = clamp01(t.life / 0.28);
      ctx.beginPath();
      ctx.arc(t.x, t.y, 3 + a * 4, 0, TAU);
      ctx.fillStyle = `rgba(92,225,230,${a * 0.16})`;
      ctx.fill();
    }
    ctx.restore();
  }

  private drawPlayer(ctx: CanvasRenderingContext2D) {
    const r = this.keyH * 0.3;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const g = ctx.createRadialGradient(this.px, this.py, 0, this.px, this.py, r * 3.4);
    g.addColorStop(0, "rgba(92,225,230,0.5)");
    g.addColorStop(1, "rgba(92,225,230,0)");
    ctx.fillStyle = g;
    ctx.fillRect(this.px - r * 3.4, this.py - r * 3.4, r * 6.8, r * 6.8);
    ctx.restore();

    ctx.beginPath();
    ctx.arc(this.px, this.py, r, 0, TAU);
    ctx.fillStyle = PLAYER;
    ctx.fill();

    if (this.shield > 0) {
      const a = clamp01(this.shield / 0.9);
      ctx.beginPath();
      ctx.arc(this.px, this.py, r + 6 + (1 - a) * 4, 0, TAU);
      ctx.lineWidth = 2;
      ctx.strokeStyle = `rgba(255,209,102,${a * 0.85})`;
      ctx.stroke();
    }
  }

  private drawHud(ctx: CanvasRenderingContext2D) {
    const pad = 20;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    ctx.font = monoFont(11, 500);
    ctx.fillStyle = "rgba(201,216,242,0.4)";
    ctx.fillText("SCORE", pad, pad + 34);
    ctx.font = monoFont(30, 700);
    ctx.fillStyle = LEGEND;
    ctx.fillText(this.score.toString(), pad, pad + 48);

    ctx.textAlign = "right";
    ctx.font = monoFont(11, 500);
    ctx.fillStyle = "rgba(201,216,242,0.4)";
    ctx.fillText("WORDS", this.w - pad, pad + 34);
    ctx.font = monoFont(30, 700);
    ctx.fillStyle = this.words > 0 ? WORD : "rgba(201,216,242,0.35)";
    ctx.fillText(this.words.toString(), this.w - pad, pad + 48);

    // Recently typed letters, so the player can see the word forming.
    const buf = this.typed.join("").toUpperCase();
    if (buf) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = monoFont(15, 600);
      const flash = clamp01(this.wordFlash / 0.6);
      ctx.fillStyle =
        flash > 0
          ? `rgba(255,209,102,${0.5 + flash * 0.5})`
          : "rgba(201,216,242,0.3)";
      ctx.letterSpacing = "5px";
      ctx.fillText(buf, this.w / 2, this.boardTop - this.keyH * 0.72);
      ctx.letterSpacing = "0px";
    }
  }

  private drawTitle(ctx: CanvasRenderingContext2D) {
    const t = this.titleTime;
    const cx = this.w / 2;

    ctx.fillStyle = "rgba(7,11,20,0.72)";
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const size = Math.min(this.w * 0.14, 80);
    ctx.font = uiFont(size, 800);
    ctx.fillStyle = LEGEND;
    ctx.letterSpacing = "-0.03em";
    ctx.fillText("HOMEROW", cx, this.h * 0.26);
    ctx.letterSpacing = "0px";

    ctx.font = monoFont(Math.min(13, this.w * 0.031), 500);
    ctx.fillStyle = "rgba(201,216,242,0.6)";
    ctx.fillText("THE KEYBOARD IS THE ARENA.", cx, this.h * 0.26 + size * 0.62);
    ctx.fillStyle = "rgba(201,216,242,0.4)";
    ctx.fillText(
      "A KEY TELEPORTS YOU TO WHERE IT SITS.",
      cx,
      this.h * 0.26 + size * 0.62 + 20,
    );
    ctx.fillStyle = `rgba(255,209,102,${0.55 + Math.sin(t * 2.2) * 0.15})`;
    ctx.fillText(
      "SPELL A WORD TO DEFUSE THE KEYS IT CROSSES.",
      cx,
      this.h * 0.26 + size * 0.62 + 40,
    );

    const blink = 0.5 + Math.sin(t * 3.4) * 0.35;
    ctx.font = monoFont(12, 700);
    ctx.fillStyle = `rgba(201,216,242,${blink})`;
    ctx.fillText(
      this.c.isTouch ? "TAP A KEY TO BEGIN" : "PRESS ANY LETTER TO BEGIN",
      cx,
      this.h * 0.86,
    );

    if (this.best > 0) {
      ctx.font = monoFont(10.5, 500);
      ctx.fillStyle = "rgba(201,216,242,0.34)";
      const extra = this.bestWord
        ? `   ·   LONGEST WORD ${this.bestWord.toUpperCase()}`
        : "";
      ctx.fillText(`BEST ${this.best}${extra}`, cx, this.h * 0.86 + 24);
    }
  }

  private drawGameOver(ctx: CanvasRenderingContext2D) {
    const ease = easeOutCubic(clamp01(this.deadTime / 0.55));
    const cx = this.w / 2;
    const cy = this.h * 0.26;

    ctx.fillStyle = `rgba(7,11,20,${0.85 * ease})`;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const isBest = this.score >= this.best && this.score > 0;
    ctx.font = monoFont(11, 600);
    ctx.fillStyle = `rgba(201,216,242,${0.45 * ease})`;
    ctx.fillText(isBest ? "NEW BEST" : "KEY DETONATED", cx, cy - 52);

    const shown = Math.round(this.score * clamp01(this.deadTime / 0.5));
    ctx.font = monoFont(Math.min(this.w * 0.15, 72), 700);
    ctx.fillStyle = isBest ? WORD : LEGEND;
    ctx.fillText(shown.toString(), cx, cy);

    ctx.font = monoFont(12, 500);
    ctx.fillStyle = `rgba(201,216,242,${0.5 * ease})`;
    ctx.fillText(
      `${this.words} WORDS   ·   ${this.time.toFixed(1)}s`,
      cx,
      cy + 48,
    );
    if (this.lastWord) {
      ctx.fillStyle = `rgba(255,209,102,${0.6 * ease})`;
      ctx.fillText(`LAST WORD: ${this.lastWord.toUpperCase()}`, cx, cy + 70);
    }

    if (this.deadTime > 0.7) {
      const blink = 0.5 + Math.sin(this.deadTime * 3.6) * 0.35;
      ctx.font = monoFont(12, 700);
      ctx.fillStyle = `rgba(201,216,242,${blink})`;
      ctx.fillText(
        this.c.isTouch ? "TAP TO GO AGAIN" : "PRESS ANY LETTER TO GO AGAIN",
        cx,
        this.h * 0.86,
      );
    }
  }
}

const factory: GameFactory = (ctx) => new Homerow(ctx);
export default factory;
