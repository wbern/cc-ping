const TEMPLATES = [
  (expr: string) => `Quick, take a guess: what is ${expr}?`,
  (expr: string) => `Without thinking too hard, what's ${expr}?`,
  (expr: string) => `Off the top of your head: ${expr} = ?`,
  (expr: string) => `Just guess, no need to be exact: ${expr}?`,
  (expr: string) => `Rough estimate: what does ${expr} equal?`,
];

const OPERATIONS = [
  { symbol: "+", gen: () => [rand(100, 9999), rand(100, 9999)] },
  { symbol: "-", gen: () => [rand(500, 9999), rand(100, 4999)] },
  { symbol: "*", gen: () => [rand(10, 999), rand(10, 999)] },
  { symbol: "/", gen: () => [rand(100, 9999), rand(2, 99)] },
];

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function generatePrompt(): string {
  const op = OPERATIONS[Math.floor(Math.random() * OPERATIONS.length)];
  const [a, b] = op.gen();
  const expr = `${a} ${op.symbol} ${b}`;
  const template = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
  return template(expr);
}
