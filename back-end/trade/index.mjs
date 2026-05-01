import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  SHORT_FEE_RATE,
  LONG_FEE_RATE,
  advancePosition,
  buildPositionView,
  computeIdleGain,
  corsHeaders,
  entryPriceFor,
  getUserFromEvent,
  normalizeLastTickMs,
  nowMs,
  pickTradeSymbol,
  round2,
} from "../shared_trading.mjs";
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = "Users";
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
    const side = String(body.side || "").toLowerCase();
    const action = String(body.action || "").toLowerCase();
    if (!["long", "short"].includes(side) || !["buy", "sell"].includes(action))
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ error: "Invalid side or action" }),
      };
    const item =
      (await db.send(new GetCommand({ TableName: TABLE, Key: { userId } })))
        .Item || {};
    const idle = computeIdleGain(
      now,
      normalizeLastTickMs(item.lastTick ?? now, now),
      Number(item.pps ?? 0),
    );
    let money = round2(Number(item.money ?? 0) + idle);
    let longPos = advancePosition(item.longPosition, userId, now, "long");
    let shortPos = advancePosition(item.shortPosition, userId, now, "short");
    const feeRate = side === "short" ? SHORT_FEE_RATE : LONG_FEE_RATE;
    if (action === "buy") {
      const amount = Math.floor(Number(body.amount ?? 0));
      if (!Number.isFinite(amount) || amount < 10 || money < amount)
        return {
          statusCode: 400,
          headers: corsHeaders(),
          body: JSON.stringify({ error: "Invalid or insufficient amount" }),
        };
      if (
        (side === "long" && longPos?.isOpen) ||
        (side === "short" && shortPos?.isOpen)
      )
        return {
          statusCode: 400,
          headers: corsHeaders(),
          body: JSON.stringify({ error: "Position already open" }),
        };
      const feePaid = round2(amount * feeRate);
      const principal = round2(amount - feePaid);
      const pos = {
        isOpen: true,
        side,
        symbol: pickTradeSymbol(userId, now, side),
        amount: round2(amount),
        principal,
        feePaid,
        feeRate,
        entryPrice: entryPriceFor(userId, now, side),
        pctDelta: 0,
        lastMove: 0,
        openedAt: now,
        lastStep: Math.floor(now / 3000),
      };
      money = round2(money - amount);
      if (side === "long") longPos = pos;
      else shortPos = pos;
    } else {
      if (side === "long") {
        if (!longPos?.isOpen)
          return {
            statusCode: 400,
            headers: corsHeaders(),
            body: JSON.stringify({ error: "No open long" }),
          };
        money = round2(money + Number(longPos.currentValue ?? 0));
        longPos = null;
      } else {
        if (!shortPos?.isOpen)
          return {
            statusCode: 400,
            headers: corsHeaders(),
            body: JSON.stringify({ error: "No open short" }),
          };
        money = round2(money + Number(shortPos.currentValue ?? 0));
        shortPos = null;
      }
    }
    const result = await db.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { userId },
        UpdateExpression:
          "SET lbPartition=:lb,#nm=if_not_exists(#nm,:n),ppc=if_not_exists(ppc,:ppc0),pps=if_not_exists(pps,:pps0),upgrades=if_not_exists(upgrades,:u0),lastTick=:now,money=:money,#lp=:lp,#sp=:sp",
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
          ":u0":
            item.upgrades && typeof item.upgrades === "object"
              ? item.upgrades
              : {},
          ":now": now,
          ":money": money,
          ":lp": longPos,
          ":sp": shortPos,
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
        trade: { side, action, idleGained: idle },
      }),
    };
  } catch (err) {
    console.error("TradeHandler error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};
