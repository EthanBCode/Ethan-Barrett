import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  advancePosition,
  buildPositionView,
  computeIdleGain,
  corsHeaders,
  getUserFromEvent,
  normalizeLastTickMs,
  nowMs,
  round2,
} from "../shared_trading.mjs";
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = "Users";
const UPGRADES = {
  cursor: { baseCost: 10, growth: 1.15, ppcAdd: 1, ppsAdd: 0 },
  dayTrader: { baseCost: 500, growth: 1.18, ppcAdd: 0, ppsAdd: 1 },
  generator: { baseCost: 15000, growth: 1.2, ppcAdd: 0, ppsAdd: 2 },
  scalper: { baseCost: 250000, growth: 1.22, ppcAdd: 0, ppsAdd: 5 },
  speculator: { baseCost: 2000000, growth: 1.24, ppcAdd: 0, ppsAdd: 30 },
  stockbroker: { baseCost: 5000000, growth: 1.26, ppcAdd: 0, ppsAdd: 80 },
};
const nextCost = (id, level) =>
  Math.floor(UPGRADES[id].baseCost * Math.pow(UPGRADES[id].growth, level));
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
    const now = nowMs();
    let body = {};
    try {
      body = event?.body ? JSON.parse(event.body) : {};
    } catch {}
    const upgradeId = body.upgradeId;
    if (!upgradeId || !UPGRADES[upgradeId])
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ error: "Invalid upgradeId" }),
      };
    const item =
      (await db.send(new GetCommand({ TableName: TABLE, Key: { userId } })))
        .Item || {};
    const ppc = Number(item.ppc ?? 1),
      pps = Number(item.pps ?? 0);
    const upgrades =
      item.upgrades && typeof item.upgrades === "object" ? item.upgrades : {};
    const idle = computeIdleGain(
      now,
      normalizeLastTickMs(item.lastTick ?? now, now),
      pps,
    );
    const moneyAfterIdle = round2(Number(item.money ?? 0) + idle);
    const level = Number(upgrades[upgradeId] ?? 0);
    const cost = nextCost(upgradeId, level);
    if (moneyAfterIdle < cost)
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({
          error: "Not enough money",
          have: moneyAfterIdle,
          need: cost,
        }),
      };
    const newUpgrades = { ...upgrades, [upgradeId]: level + 1 };
    const result = await db.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { userId },
        UpdateExpression:
          "SET lbPartition=:lb,#nm=:n,money=:money,ppc=:ppc,pps=:pps,lastTick=:now,upgrades=:up,#lp=:lp,#sp=:sp",
        ExpressionAttributeNames: {
          "#nm": "name",
          "#lp": "longPosition",
          "#sp": "shortPosition",
        },
        ExpressionAttributeValues: {
          ":lb": "LB",
          ":n": name,
          ":money": round2(moneyAfterIdle - cost),
          ":ppc": ppc + UPGRADES[upgradeId].ppcAdd,
          ":pps": pps + UPGRADES[upgradeId].ppsAdd,
          ":now": now,
          ":up": newUpgrades,
          ":lp": advancePosition(item.longPosition, userId, now, "long"),
          ":sp": advancePosition(item.shortPosition, userId, now, "short"),
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    const u = result.Attributes || {};
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        name: u.name,
        money: round2(u.money ?? 0),
        ppc: Number(u.ppc ?? 1),
        pps: Number(u.pps ?? 0),
        lastTick: Number(u.lastTick ?? now),
        upgrades: u.upgrades || {},
        longPosition: buildPositionView(u.longPosition, userId, now, "long"),
        shortPosition: buildPositionView(u.shortPosition, userId, now, "short"),
        bought: { upgradeId, level: level + 1, cost, idleGained: idle },
      }),
    };
  } catch (err) {
    console.error("BuyHandler error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};
