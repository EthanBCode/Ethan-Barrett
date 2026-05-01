export const STEP_MS = 3000;
export const MAX_POSITION_STEPS_PER_REQUEST = 50000;
export const LONG_MAX_POSITION_DELTA = 0.1;
export const LONG_MAX_STEP_MOVE = 0.01;
export const LONG_FEE_RATE = 0.07;
export const SHORT_MAX_STEP_MOVE = 0.011;
export const SHORT_FEE_RATE = 0.08;
export const MIN_PRICE = 25;
export const MAX_PRICE = 975;
export const TRADE_SYMBOLS = [
  "AAPL",
  "NVDA",
  "MSFT",
  "TSLA",
  "AMZN",
  "META",
  "QQQ",
  "SPY",
];

export const round2 = (v) =>
  Math.round((Number(v) + Number.EPSILON) * 100) / 100;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const nowMs = () => Date.now();
export const normalizeLastTickMs = (lastTick, now) => {
  const lt = Number(lastTick);
  if (!Number.isFinite(lt)) return now;
  if (lt > 0 && lt < 100000000000) return lt * 1000;
  return lt;
};
export const computeIdleGain = (now, lastTickMs, pps) =>
  Math.floor((Math.max(0, now - lastTickMs) * (Number(pps) || 0)) / 1000);
export const hashString = (str) => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
export const seededUnit = (seed) => (hashString(seed) % 1000000) / 1000000;
export const pickTradeSymbol = (userId, now, side) =>
  TRADE_SYMBOLS[hashString(`${userId}:${side}:${now}`) % TRADE_SYMBOLS.length];
export const stepMoveFor = (userId, openedAt, stepIndex, side) =>
  (seededUnit(`${userId}:${side}:${openedAt}:${stepIndex}`) * 2 - 1) *
  (side === "short" ? SHORT_MAX_STEP_MOVE : LONG_MAX_STEP_MOVE);
export const entryPriceFor = (userId, openedAt, side) =>
  round2(
    MIN_PRICE +
      seededUnit(`${userId}:${side}:${openedAt}:price`) *
        (MAX_PRICE - MIN_PRICE),
  );

export function advancePosition(position, userId, now, side) {
  if (!position?.isOpen) return null;
  const openedAt = Number(position.openedAt ?? now);
  const entryPrice = Number(
    position.entryPrice ?? entryPriceFor(userId, openedAt, side),
  );
  let lastStep = Number(position.lastStep ?? Math.floor(openedAt / STEP_MS));
  let pctDelta = Number(position.pctDelta ?? 0);
  let lastMove = Number(position.lastMove ?? 0);
  const targetStep = Math.floor(now / STEP_MS);
  const missingSteps = Math.max(0, targetStep - lastStep);
  const startStep =
    missingSteps > MAX_POSITION_STEPS_PER_REQUEST
      ? targetStep - MAX_POSITION_STEPS_PER_REQUEST
      : lastStep + 1;
  for (let step = startStep; step <= targetStep; step++) {
    const mv = stepMoveFor(userId, openedAt, step, side);
    pctDelta += mv;
    lastMove = mv;
    if (side === "long")
      pctDelta = clamp(
        pctDelta,
        -LONG_MAX_POSITION_DELTA,
        LONG_MAX_POSITION_DELTA,
      );
  }
  const currentPrice = round2(Math.max(0.01, entryPrice * (1 + pctDelta)));
  const principal = Number(position.principal ?? 0);
  const currentValue =
    side === "long"
      ? round2(principal * (currentPrice / entryPrice))
      : round2(principal * (2 - currentPrice / entryPrice));
  return {
    ...position,
    side,
    entryPrice,
    pctDelta,
    lastMove,
    lastStep: targetStep,
    currentPrice,
    currentValue,
    feeRate: side === "short" ? SHORT_FEE_RATE : LONG_FEE_RATE,
  };
}
export const buildPositionView = (position, userId, now, side) => {
  const p = advancePosition(position, userId, now, side);
  if (!p) return null;
  const amount = round2(p.amount);
  const currentValue = round2(p.currentValue);
  return {
    side,
    symbol: p.symbol,
    amount,
    principal: round2(p.principal),
    feePaid: round2(p.feePaid ?? 0),
    feeRate: p.feeRate,
    entryPrice: round2(p.entryPrice),
    currentPrice: round2(p.currentPrice),
    lastMovePct: Number((p.lastMove * 100).toFixed(2)),
    pctDelta: Number((p.pctDelta * 100).toFixed(2)),
    currentValue,
    unrealized: round2(currentValue - amount),
    openedAt: p.openedAt,
  };
};

export const corsHeaders = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
  "Access-Control-Allow-Methods": "OPTIONS,GET,POST",
});
export const getUserFromEvent = (event) => {
  const claims = event?.requestContext?.authorizer?.claims;
  return claims?.sub
    ? {
        userId: claims.sub,
        name:
          claims["cognito:username"] ||
          claims.username ||
          claims.email ||
          claims.sub,
      }
    : null;
};
