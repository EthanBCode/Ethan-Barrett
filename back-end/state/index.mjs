import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const db = DynamoDBDocumentClient.from(client);
const TABLE = "Users";
const STEP_MS = 3000;
const MAX_POSITION_STEPS_PER_REQUEST = 50000;
const LONG_MAX_POSITION_DELTA = 0.1;
const LONG_MAX_STEP_MOVE = 0.01;
const LONG_FEE_RATE = 0.07;
const SHORT_MAX_STEP_MOVE = 0.011;
const SHORT_FEE_RATE = 0.08;
const MIN_PRICE = 25;
const MAX_PRICE = 975;

const corsHeaders = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
  "Access-Control-Allow-Methods": "OPTIONS,GET,POST",
});
const getUserFromEvent = (event) => {
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
const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const normalizeLastTickMs = (lastTick, now) => {
  const lt = Number(lastTick);
  if (!Number.isFinite(lt)) return now;
  if (lt > 0 && lt < 100000000000) return lt * 1000;
  return lt;
};
const computeIdleGain = (now, lastTickMs, pps) =>
  Math.floor((Math.max(0, now - lastTickMs) * (Number(pps) || 0)) / 1000);
const hashString = (str) => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const seededUnit = (seed) => (hashString(seed) % 1000000) / 1000000;
const stepMoveFor = (userId, openedAt, stepIndex, side) =>
  (seededUnit(`${userId}:${side}:${openedAt}:${stepIndex}`) * 2 - 1) *
  (side === "short" ? SHORT_MAX_STEP_MOVE : LONG_MAX_STEP_MOVE);
const entryPriceFor = (userId, openedAt, side) =>
  round2(
    MIN_PRICE +
      seededUnit(`${userId}:${side}:${openedAt}:price`) *
        (MAX_PRICE - MIN_PRICE),
  );

function advancePosition(position, userId, now, side) {
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
  if (missingSteps > MAX_POSITION_STEPS_PER_REQUEST) {
    lastStep = startStep - 1;
  }

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

const buildPositionView = (position, userId, now, side) => {
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

export const handler = async (event) => {
  try {
    if (event?.httpMethod === "OPTIONS")
      return { statusCode: 200, headers: corsHeaders(), body: "" };
    const user = getUserFromEvent(event);
    if (!user)
      return {
        statusCode: 401,
        headers: corsHeaders(),
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    const { userId, name } = user;
    const now = Date.now();
    const current = await db.send(
      new GetCommand({ TableName: TABLE, Key: { userId } }),
    );
    const item = current.Item || {};
    const idleGain = computeIdleGain(
      now,
      normalizeLastTickMs(item.lastTick ?? now, now),
      Number(item.pps ?? 0),
    );
    const longPos = advancePosition(item.longPosition, userId, now, "long");
    const shortPos = advancePosition(item.shortPosition, userId, now, "short");

    const result = await db.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { userId },
        UpdateExpression:
          "SET lbPartition=:lb, #nm=if_not_exists(#nm,:n), ppc=if_not_exists(ppc,:ppc0), pps=if_not_exists(pps,:pps0), upgrades=if_not_exists(upgrades,:u0), lastTick=:now, money=if_not_exists(money,:m0)+:idle, #lp=:lp, #sp=:sp",
        ExpressionAttributeNames: {
          "#nm": "name",
          "#lp": "longPosition",
          "#sp": "shortPosition",
        },
        ExpressionAttributeValues: {
          ":lb": "LB",
          ":n": name,
          ":ppc0": 1,
          ":pps0": 0,
          ":u0": {},
          ":now": now,
          ":m0": 0,
          ":idle": idleGain,
          ":lp": longPos,
          ":sp": shortPos,
        },
        ReturnValues: "ALL_NEW",
      }),
    );

    const updated = result.Attributes || {};
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        name: updated.name,
        money: round2(updated.money ?? 0),
        ppc: Number(updated.ppc ?? 1),
        pps: Number(updated.pps ?? 0),
        lastTick: Number(updated.lastTick ?? now),
        upgrades: updated.upgrades || {},
        longPosition: buildPositionView(
          updated.longPosition,
          userId,
          now,
          "long",
        ),
        shortPosition: buildPositionView(
          updated.shortPosition,
          userId,
          now,
          "short",
        ),
        gained: { idle: idleGain },
      }),
    };
  } catch (err) {
    console.error("StateHandler error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};
