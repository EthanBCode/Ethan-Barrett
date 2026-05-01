import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const db = DynamoDBDocumentClient.from(client);
const TABLE = "Users";
const INDEX = "LeaderboardIndex";

const corsHeaders = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
  "Access-Control-Allow-Methods": "OPTIONS,GET",
});

const getUserFromEvent = (event) => {
  const claims = event?.requestContext?.authorizer?.claims;
  if (!claims?.sub) return null;
  return {
    userId: claims.sub,
    name:
      claims["cognito:username"] ||
      claims.username ||
      claims.email ||
      claims.sub,
  };
};

const safeName = (x) => String(x?.name || x?.userId || "unknown").slice(0, 32);

export const handler = async (event) => {
  try {
    if (event?.httpMethod === "OPTIONS")
      return { statusCode: 200, headers: corsHeaders(), body: "" };
    if (!getUserFromEvent(event))
      return {
        statusCode: 401,
        headers: corsHeaders(),
        body: JSON.stringify({ error: "Unauthorized" }),
      };

    const result = await db.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: INDEX,
        KeyConditionExpression: "lbPartition = :lb",
        ExpressionAttributeValues: { ":lb": "LB" },
        ScanIndexForward: false,
        Limit: 25,
      }),
    );

    const items = (result.Items || []).map((x) => ({
      name: safeName(x),
      points: Number(x?.money ?? 0),
    }));
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify(items),
    };
  } catch (err) {
    console.error("LeaderboardHandler error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};
