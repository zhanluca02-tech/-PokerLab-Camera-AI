import express from "express";
import multer from "multer";
import cors from "cors";
import OpenAI from "openai";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

app.use(cors());
app.use(express.static("public"));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const model = process.env.OPENAI_MODEL || "gpt-6-astra";

const CardString = z.string().regex(/^(10|[2-9AJQK])[shdc]$/);
const VisionResult = z.object({
  hero_cards: z.array(CardString).max(2),
  board_cards: z.array(CardString).max(5),
  pot: z.number().nullable(),
  to_call: z.number().nullable(),
  players: z.number().int().min(1).max(10).nullable(),
  street: z.enum(["翻牌前", "翻牌圈", "转牌圈", "河牌圈", "未知"]),
  confidence: z.number().min(0).max(1),
  notes: z.string(),
});

const RANK_VALUE = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
  "10": 10, "J": 11, "Q": 12, "K": 13, "A": 14,
};

const SUITS = ["s", "h", "d", "c"];
const RANKS = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
const DECK = [];
for (const suit of SUITS) {
  for (const rank of RANKS) {
    DECK.push({ rank, value: RANK_VALUE[rank], suit, id: rank + suit });
  }
}

function parseCard(id) {
  if (!id || !/^(10|[2-9AJQK])[shdc]$/.test(id)) return null;
  const suit = id.slice(-1);
  const rank = id.slice(0, -1);
  return { rank, value: RANK_VALUE[rank], suit, id };
}

function combinations(arr, k) {
  const out = [];
  function rec(start, chosen) {
    if (chosen.length === k) {
      out.push(chosen.slice());
      return;
    }
    for (let i = start; i <= arr.length - (k - chosen.length); i++) {
      chosen.push(arr[i]);
      rec(i + 1, chosen);
      chosen.pop();
    }
  }
  rec(0, []);
  return out;
}

function compareScore(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function evaluate5(cards) {
  const vals = cards.map(c => c.value).sort((a,b) => b-a);
  const suits = cards.map(c => c.suit);
  const counts = new Map();
  for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);

  const unique = [...new Set(vals)].sort((a,b) => b-a);
  if (unique.includes(14)) unique.push(1);

  let straightHigh = 0;
  for (let i = 0; i <= unique.length - 5; i++) {
    let ok = true;
    for (let j = 1; j < 5; j++) {
      if (unique[i + j] !== unique[i] - j) ok = false;
    }
    if (ok) {
      straightHigh = unique[i];
      break;
    }
  }

  const flush = suits.every(s => s === suits[0]);
  const groups = [...counts.entries()].sort((a,b) => b[1] - a[1] || b[0] - a[0]);

  if (flush && straightHigh) return [8, straightHigh];
  if (groups[0][1] === 4) return [7, groups[0][0], groups.find(g => g[1] === 1)[0]];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]];
  if (flush) return [5, ...vals];
  if (straightHigh) return [4, straightHigh];

  if (groups[0][1] === 3) {
    const kickers = groups.filter(g => g[1] === 1).map(g => g[0]).sort((a,b) => b-a);
    return [3, groups[0][0], ...kickers];
  }

  if (groups[0][1] === 2 && groups[1][1] === 2) {
    const pairs = [groups[0][0], groups[1][0]].sort((a,b) => b-a);
    const kicker = groups.find(g => g[1] === 1)[0];
    return [2, ...pairs, kicker];
  }

  if (groups[0][1] === 2) {
    const kickers = groups.filter(g => g[1] === 1).map(g => g[0]).sort((a,b) => b-a);
    return [1, groups[0][0], ...kickers];
  }

  return [0, ...vals];
}

function evaluateBest(cards) {
  if (cards.length < 5) return null;
  let best = null;
  for (const combo of combinations(cards, 5)) {
    const score = evaluate5(combo);
    if (!best || compareScore(score, best) > 0) best = score;
  }
  return best;
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function simulateEquity(heroIds, boardIds, opponents, iterations = 8000) {
  const knownHero = heroIds.map(parseCard).filter(Boolean);
  const knownBoard = boardIds.map(parseCard).filter(Boolean);

  if (knownHero.length === 0) {
    return { win_rate: null, tie_rate: null, equity: null };
  }

  const used = new Set([...knownHero, ...knownBoard].map(c => c.id));
  const baseRemain = DECK.filter(c => !used.has(c.id));
  const missingHero = 2 - knownHero.length;
  const missingBoard = 5 - knownBoard.length;

  let wins = 0, ties = 0, equitySum = 0;

  for (let n = 0; n < iterations; n++) {
    const rem = shuffled(baseRemain);
    let p = 0;

    const hero = knownHero.concat(rem.slice(p, p + missingHero));
    p += missingHero;

    const board = knownBoard.concat(rem.slice(p, p + missingBoard));
    p += missingBoard;

    const heroScore = evaluateBest([...hero, ...board]);
    let beaten = false;
    let tiedOpps = 0;

    for (let o = 0; o < opponents; o++) {
      const opp = [rem[p++], rem[p++]];
      const oppScore = evaluateBest([...opp, ...board]);
      const cmp = compareScore(oppScore, heroScore);

      if (cmp > 0) {
        beaten = true;
        break;
      }
      if (cmp === 0) tiedOpps++;
    }

    if (beaten) {
      // no equity
    } else if (tiedOpps > 0) {
      ties++;
      equitySum += 1 / (tiedOpps + 1);
    } else {
      wins++;
      equitySum += 1;
    }
  }

  return {
    win_rate: wins / iterations * 100,
    tie_rate: ties / iterations * 100,
    equity: equitySum / iterations * 100,
  };
}

function countOuts(heroIds, boardIds) {
  const hero = heroIds.map(parseCard).filter(Boolean);
  const board = boardIds.map(parseCard).filter(Boolean);

  if (hero.length !== 2 || board.length < 3 || board.length >= 5) {
    return null;
  }

  const current = evaluateBest([...hero, ...board]);
  if (!current) return null;

  const used = new Set([...hero, ...board].map(c => c.id));
  const remain = DECK.filter(c => !used.has(c.id));

  let outs = 0;
  for (const card of remain) {
    const next = evaluateBest([...hero, ...board, card]);
    if (next && compareScore(next, current) > 0) outs++;
  }
  return outs;
}

function makeTrainingText({ equity, pot, toCall, street, outs }) {
  if (equity == null) {
    return {
      training_action: "等待识别",
      explanation: "还没有稳定识别到你的手牌，继续保持画面清晰。",
    };
  }

  const call = Number(toCall) || 0;
  const p = Number(pot) || 0;
  const potOdds = call > 0 ? (call / (p + call)) * 100 : 0;
  const edge = equity - potOdds;

  let action = "继续观察";
  let explanation = `${street}：估算权益 ${equity.toFixed(1)}%，底池赔率 ${potOdds.toFixed(1)}%。`;

  if (call === 0) {
    action = equity >= 60 ? "训练：可练习主动下注" : "训练：可练习过牌";
  } else if (edge < -7) {
    action = "训练：偏向弃牌";
  } else if (edge >= 15 && equity >= 60) {
    action = "训练：可练习加注";
  } else if (edge >= 0) {
    action = "训练：可练习跟注";
  } else {
    action = "训练：偏向弃牌";
  }

  explanation += ` 权益差 ${edge >= 0 ? "+" : ""}${edge.toFixed(1)}%。`;
  if (outs != null) explanation += ` 当前约 ${outs} 个改善 outs。`;

  return { training_action: action, explanation };
}

async function analyzeVision(buffer) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const base64 = buffer.toString("base64");
  const imageUrl = `data:image/jpeg;base64,${base64}`;

  const response = await openai.responses.parse({
    model,
    input: [
      {
        role: "system",
        content:
          "You analyze screenshots/photos of a Texas Hold'em poker table for a training application. " +
          "Only extract information that is clearly visible. Never guess hidden cards. " +
          "Card encoding must be rank+suit: As, 10h, Qd, 7c. " +
          "s=spades, h=hearts, d=diamonds, c=clubs. " +
          "hero_cards are only the user's visible hole cards. " +
          "board_cards are only community cards. " +
          "pot and to_call must be numeric chip amounts when clearly visible, otherwise null. " +
          "players is the number of active/seated players visible if reasonably clear, otherwise null. " +
          "confidence should reflect how certain you are about the extracted state.",
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "Extract the current Texas Hold'em table state from this image. " +
              "Do not provide poker strategy. Only identify visible game state.",
          },
          {
            type: "input_image",
            image_url: imageUrl,
            detail: "high",
          },
        ],
      },
    ],
    text: {
      format: zodTextFormat(VisionResult, "poker_table_state"),
    },
  });

  if (!response.output_parsed) {
    throw new Error("No structured vision output");
  }

  return response.output_parsed;
}

app.post("/api/analyze-table", upload.single("frame"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "missing_frame" });
    }

    const vision = await analyzeVision(req.file.buffer);

    const manualToCall = req.body.manual_to_call !== undefined
      ? Number(req.body.manual_to_call)
      : null;

    const toCall = Number.isFinite(manualToCall)
      ? manualToCall
      : vision.to_call;

    const opponents = Math.max(1, (vision.players || 2) - 1);

    const equityResult = simulateEquity(
      vision.hero_cards,
      vision.board_cards,
      opponents,
      8000
    );

    const outs = countOuts(vision.hero_cards, vision.board_cards);

    const training = makeTrainingText({
      equity: equityResult.equity,
      pot: vision.pot,
      toCall,
      street: vision.street,
      outs,
    });

    return res.json({
      hero_cards: vision.hero_cards,
      board_cards: vision.board_cards,
      pot: vision.pot,
      to_call: toCall,
      players: vision.players,
      street: vision.street,
      confidence: vision.confidence,
      win_rate: equityResult.win_rate,
      tie_rate: equityResult.tie_rate,
      equity: equityResult.equity,
      outs,
      training_action: training.training_action,
      explanation: training.explanation,
      vision_notes: vision.notes,
      model,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "analysis_failed",
      message: error?.message || "Unknown error",
    });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    openai_key_configured: Boolean(process.env.OPENAI_API_KEY),
    model,
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`PokerLab Camera AI running on http://localhost:${port}`);
});
