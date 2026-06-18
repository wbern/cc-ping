import type { PromptStyle } from "./types.js";

type RandomSource = () => number;

const MATH_TEMPLATES = [
  "Quick, take a guess: what is {expr}?",
  "Without thinking too hard, what's {expr}?",
  "Off the top of your head: {expr} = ?",
  "Just guess, no need to be exact: {expr}?",
  "Rough estimate: what does {expr} equal?",
];

const OPERATIONS = [
  {
    symbol: "+",
    gen: (random: RandomSource) => [
      rand(100, 9999, random),
      rand(100, 9999, random),
    ],
  },
  {
    symbol: "-",
    gen: (random: RandomSource) => [
      rand(500, 9999, random),
      rand(100, 4999, random),
    ],
  },
  {
    symbol: "*",
    gen: (random: RandomSource) => [
      rand(10, 999, random),
      rand(10, 999, random),
    ],
  },
  {
    symbol: "/",
    gen: (random: RandomSource) => [
      rand(100, 9999, random),
      rand(2, 99, random),
    ],
  },
];

const TRIVIA_PROMPTS = [
  "Quick gut check: name one color you associate with grass.",
  "Without overthinking it, name a common fruit that is red.",
  "Give a one-word answer: what animal says meow?",
  "Quickly complete this pattern: Monday, Tuesday, Wednesday, ...",
  "Name one thing people commonly drink in the morning.",
  "In one short phrase, what season usually comes after spring?",
  "Give a rough answer: what do bees make?",
  "Name one common item you might find on a desk.",
  "Quick association: what color is a clear daytime sky often described as?",
  "One-word answer: what do you call frozen water?",
  "Complete this simple pair: hot and cold, up and ...",
  "Name a common pet that often barks.",
  "Give a tiny answer: what shape has three sides?",
  "What is a common greeting people say in the morning?",
  "Name one thing commonly used to write on paper.",
];

const TINY_CHAT_PROMPTS = [
  "Say hello in a short friendly sentence.",
  "Reply with one calm sentence about taking a short break.",
  "Give a tiny encouraging phrase, under six words.",
  "Write a five-word sentence about coffee.",
  "Answer with a short sentence about a quiet morning.",
  "Give one brief sentence that mentions a notebook.",
  "Reply with a tiny sentence about rain.",
  "Say one simple sentence about a sunny window.",
  "Write a short phrase about getting started.",
  "Answer with one sentence under eight words.",
];

const CHESS_FENS = [
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
  "r2qk2r/ppp2ppp/2npbn2/4p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 b kq - 4 8",
  "8/5pk1/6p1/3Pp3/4P3/5P2/6K1/8 w - - 0 41",
  "2r3k1/5ppp/p3pn2/1p6/3P4/P1N1PN2/1P3PPP/2R3K1 w - - 1 24",
  "4rrk1/pp3ppp/2n5/3q4/3P4/2P2Q2/PP3PPP/R4RK1 b - - 3 19",
];

const PIECE_NAMES: Record<string, string> = {
  k: "king",
  q: "queen",
  r: "rook",
  b: "bishop",
  n: "knight",
  p: "pawn",
};

const FILES = "abcdefgh";
const ALL_SQUARES = Array.from({ length: 8 }, (_, rankIndex) =>
  [...FILES].map((file) => `${file}${8 - rankIndex}`),
).flat();

interface ChessPiece {
  square: string;
  color: "white" | "black";
  name: string;
  code: string;
}

function rand(min: number, max: number, random: RandomSource): number {
  return Math.floor(random() * (max - min + 1)) + min;
}

function generateMathPrompt(random: RandomSource): string {
  const op = choice(OPERATIONS, random);
  const [a, b] = op.gen(random);
  const expr = `${a} ${op.symbol} ${b}`;
  const template = choice(MATH_TEMPLATES, random);
  return template.replace("{expr}", expr);
}

function choice<T>(items: T[], random: RandomSource): T {
  return items[Math.floor(random() * items.length)];
}

function parseFenPieces(fen: string): ChessPiece[] {
  const placement = fen.split(" ")[0];
  return placement.split("/").flatMap((rank, rankIndex) => {
    const pieces: ChessPiece[] = [];
    let fileIndex = 0;

    for (const char of rank) {
      if (/\d/.test(char)) {
        fileIndex += Number(char);
        continue;
      }

      const lower = char.toLowerCase();
      const square = `${FILES[fileIndex]}${8 - rankIndex}`;
      pieces.push({
        square,
        color: char === char.toUpperCase() ? "white" : "black",
        name: PIECE_NAMES[lower],
        code: char,
      });
      fileIndex += 1;
    }

    return pieces;
  });
}

function describePiece(piece: ChessPiece): string {
  return `${piece.color} ${piece.name} (${piece.code})`;
}

function generateChessPrompt(random: RandomSource): string {
  const fen = choice(CHESS_FENS, random);
  const pieces = parseFenPieces(fen);
  const occupiedSquares = new Set(pieces.map((piece) => piece.square));
  const emptySquares = ALL_SQUARES.filter(
    (square) => !occupiedSquares.has(square),
  );
  const type = rand(0, 2, random);

  if (type === 0) {
    const uniquePieces = pieces.filter(
      (piece) =>
        pieces.filter(
          (candidate) =>
            candidate.color === piece.color && candidate.name === piece.name,
        ).length === 1,
    );
    const piece = choice(uniquePieces, random);
    return `FEN: ${fen}. Square only: where is the ${describePiece(piece)}?`;
  }

  if (type === 1) {
    const piece = choice(pieces, random);
    return `FEN: ${fen}. Piece only: what is on ${piece.square}?`;
  }

  const square = choice(
    [...pieces.map((piece) => piece.square), ...emptySquares],
    random,
  );
  return `FEN: ${fen}. Yes/no: is there a piece on ${square}?`;
}

export function generatePrompt(
  style: PromptStyle = "mixed",
  random: RandomSource = Math.random,
): string {
  if (style === "math") return generateMathPrompt(random);

  const trivia = TRIVIA_PROMPTS;
  if (style === "trivia") {
    return choice(trivia, random);
  }

  const tinyChat = TINY_CHAT_PROMPTS;
  if (style === "tiny-chat") {
    return choice(tinyChat, random);
  }

  if (style === "chess") return generateChessPrompt(random);

  const choices = [
    () => generateMathPrompt(random),
    () => generateChessPrompt(random),
    ...trivia.map((prompt) => () => prompt),
    ...tinyChat.map((prompt) => () => prompt),
  ];
  return choice(choices, random)();
}
