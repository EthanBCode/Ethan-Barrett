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
    const item =
      (await db.send(new GetCommand({ TableName: TABLE, Key: { userId } })))
        .Item || {};
    const ppc = Number(item.ppc ?? 1);
    const pps = Number(item.pps ?? 0);
    const idle = computeIdleGain(
      now,
      normalizeLastTickMs(item.lastTick ?? now, now),
      pps,
    );
    const longPos = advancePosition(item.longPosition, userId, now, "long");
    const shortPos = advancePosition(item.shortPosition, userId, now, "short");
    const result = await db.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { userId },
        UpdateExpression:
          "SET lbPartition=:lb,#nm=:n,ppc=if_not_exists(ppc,:ppc0),pps=if_not_exists(pps,:pps0),upgrades=if_not_exists(upgrades,:u0),lastTick=:now,money=if_not_exists(money,:m0)+:inc,#lp=:lp,#sp=:sp",
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
          ":inc": idle + ppc,
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
        gained: { idle, click: ppc },
      }),
    };
  } catch (err) {
    console.error("ClickHandler error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};
