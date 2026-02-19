const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const cors = require("cors");
const {
  DynamoDBClient,
  QueryCommand,
} = require("@aws-sdk/client-dynamodb");
const {
  BedrockRuntimeClient,
  InvokeModelCommand,
} = require("@aws-sdk/client-bedrock-runtime");
const { unmarshall } = require("@aws-sdk/util-dynamodb");

const corsHandler = cors({ origin: true });

const AWS_REGION = process.env.AWS_REGION || "ap-southeast-1";
const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID || "anthropic.claude-3-5-sonnet-20240620-v1:0";
const TELEMETRY_TABLE = process.env.TELEMETRY_TABLE || "TierAITelemetry";
const CONTEXT_TABLE = process.env.CONTEXT_TABLE || "TierAIContext";
const MAX_TELEMETRY_ROWS = Number(process.env.MAX_TELEMETRY_ROWS || 30);

const dynamo = new DynamoDBClient({ region: AWS_REGION });
const bedrock = new BedrockRuntimeClient({ region: AWS_REGION });

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

async function getLatestContextByWindow(deviceId) {
  const response = await dynamo.send(
    new QueryCommand({
      TableName: CONTEXT_TABLE,
      KeyConditionExpression: "device_id = :d",
      ExpressionAttributeValues: {
        ":d": { S: deviceId },
      },
      ScanIndexForward: false,
      Limit: 25,
    })
  );

  const items = (response.Items || []).map((item) => unmarshall(item));
  const latest5m = items.find((item) => Number(item.window_minutes) === 5) || null;
  const latest60m = items.find((item) => Number(item.window_minutes) === 60) || null;
  return { latest_5m: latest5m, latest_60m: latest60m };
}

async function getRecentTelemetry(deviceId) {
  const response = await dynamo.send(
    new QueryCommand({
      TableName: TELEMETRY_TABLE,
      KeyConditionExpression: "device_id = :d",
      ExpressionAttributeValues: {
        ":d": { S: deviceId },
      },
      ScanIndexForward: false,
      Limit: MAX_TELEMETRY_ROWS,
    })
  );
  const items = (response.Items || []).map((item) => unmarshall(item));
  return items.reverse();
}

function buildPrompt(deviceId, userMessage, contextData, telemetryRows) {
  const hasTelemetry = Array.isArray(telemetryRows) && telemetryRows.length > 0;
  return [
    "You are TierAI Ops Assistant.",
    "Use only the provided telemetry context.",
    "If data is insufficient, explicitly state what is missing.",
    "Return ONLY valid JSON with keys:",
    "{\"current_state\":\"...\",\"likely_issue\":\"...\",\"next_checks\":[\"...\"],\"urgency\":\"low|medium|high\",\"data_freshness\":\"fresh_5m|stale_5m|no_context\",\"note\":\"...\"}",
    "",
    `Device ID: ${deviceId}`,
    "",
    "Context summaries:",
    JSON.stringify(contextData, null, 2),
    "",
    "Recent telemetry (optional):",
    hasTelemetry ? JSON.stringify(telemetryRows.slice(-10), null, 2) : "Not included in this request.",
    "",
    `User question: ${userMessage}`,
  ].join("\n");
}

function extractJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const match = trimmed.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

function n(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function computeDeterministicSignals(contextData) {
  const latest5m = contextData?.latest_5m || null;
  const latest60m = contextData?.latest_60m || null;

  const sample5 = n(latest5m?.sample_count);
  const has5m = sample5 > 0;
  const chosen = has5m ? latest5m : latest60m;

  const hasAnyContext = Boolean(latest5m || latest60m);
  const dataFreshness = has5m
    ? "fresh_5m"
    : hasAnyContext
      ? "stale_5m"
      : "no_context";

  const breachTemp = Boolean(chosen?.breach_temp);
  const breachHumidity = Boolean(chosen?.breach_humidity);

  let score = 0;
  if (breachTemp) score += 2;
  if (breachHumidity) score += 1;
  if (dataFreshness === "stale_5m") score += 1;
  if (dataFreshness === "no_context") score += 2;

  const deterministicUrgency = score >= 4 ? "high" : score >= 2 ? "medium" : "low";
  const sourceWindowMinutes = has5m ? 5 : latest60m ? 60 : null;

  return {
    data_freshness: dataFreshness,
    deterministic_urgency: deterministicUrgency,
    source_window_minutes: sourceWindowMinutes,
  };
}

async function invokeBedrock(prompt) {
  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 700,
    temperature: 0.2,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
  };

  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: BEDROCK_MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(body),
    })
  );

  const json = JSON.parse(Buffer.from(response.body).toString("utf-8"));
  const parts = (json.content || [])
    .filter((x) => x && x.type === "text" && x.text)
    .map((x) => x.text);
  return parts.join("\n").trim();
}

exports.chat = onRequest(
  { region: "asia-southeast1", timeoutSeconds: 120, memory: "512MiB" },
  async (req, res) => {
    corsHandler(req, res, async () => {
      if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
      }

      if (req.method !== "POST") {
        res.status(405).json({ detail: "Method not allowed. Use POST." });
        return;
      }

      try {
        const body = parseBody(req);
        const deviceId = body.device_id;
        const message = body.message;
        const contextOnly = body.context_only !== false;

        if (!deviceId || !message || typeof message !== "string") {
          res.status(400).json({
            detail:
              "Invalid request. Expected { device_id: string, message: string, context_only?: boolean }.",
          });
          return;
        }

        const contextData = await getLatestContextByWindow(deviceId);
        const telemetryRows = contextOnly ? [] : await getRecentTelemetry(deviceId);
        const hasContext = Boolean(contextData.latest_5m || contextData.latest_60m);
        const hasTelemetry = telemetryRows.length > 0;
        const deterministic = computeDeterministicSignals(contextData);

        if ((contextOnly && !hasContext) || (!contextOnly && !hasContext && !hasTelemetry)) {
          res
            .status(404)
            .json({ detail: `No telemetry/context found for device_id=${deviceId}.` });
          return;
        }

        const prompt = buildPrompt(deviceId, message, contextData, telemetryRows);
        const answer = await invokeBedrock(prompt);

        if (!answer) {
          res.status(502).json({ detail: "Bedrock returned empty response." });
          return;
        }

        let structuredAnswer = null;
        try {
          const jsonText = extractJson(answer);
          if (jsonText) {
            structuredAnswer = JSON.parse(jsonText);
          }
        } catch (err) {
          logger.warn("Failed to parse structured JSON answer", err);
        }

        if (!structuredAnswer || typeof structuredAnswer !== "object") {
          structuredAnswer = {};
        }
        structuredAnswer.data_freshness = deterministic.data_freshness;
        structuredAnswer.urgency = deterministic.deterministic_urgency;
        if (!structuredAnswer.note) {
          if (deterministic.data_freshness === "stale_5m") {
            structuredAnswer.note = "No usable 5-minute telemetry; guidance is based on 60-minute context.";
          } else if (deterministic.data_freshness === "no_context") {
            structuredAnswer.note = "No telemetry context available for this device.";
          }
        }

        res.status(200).json({
          answer,
          structured_answer: structuredAnswer,
          device_id: deviceId,
          mode: contextOnly ? "context_only" : "context_plus_telemetry",
          deterministic,
          context_used: contextData,
        });
      } catch (error) {
        logger.error("chat function failed", error);
        res.status(500).json({
          detail: `Backend error: ${error.message || "unknown error"}`,
        });
      }
    });
  }
);
