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
const MAX_QUERY_GAP_SECONDS = Number(process.env.MAX_QUERY_GAP_SECONDS || 21600);

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

async function getNearestTelemetryAtTs(deviceId, queryTs) {
  const qTs = n(queryTs);
  if (!qTs) return null;

  const [beforeResp, afterResp] = await Promise.all([
    dynamo.send(
      new QueryCommand({
        TableName: TELEMETRY_TABLE,
        KeyConditionExpression: "device_id = :d AND #ts <= :q",
        ExpressionAttributeNames: { "#ts": "ts" },
        ExpressionAttributeValues: {
          ":d": { S: deviceId },
          ":q": { N: String(qTs) },
        },
        ScanIndexForward: false,
        Limit: 1,
      })
    ),
    dynamo.send(
      new QueryCommand({
        TableName: TELEMETRY_TABLE,
        KeyConditionExpression: "device_id = :d AND #ts >= :q",
        ExpressionAttributeNames: { "#ts": "ts" },
        ExpressionAttributeValues: {
          ":d": { S: deviceId },
          ":q": { N: String(qTs) },
        },
        ScanIndexForward: true,
        Limit: 1,
      })
    ),
  ]);

  const before = beforeResp.Items?.[0] ? unmarshall(beforeResp.Items[0]) : null;
  const after = afterResp.Items?.[0] ? unmarshall(afterResp.Items[0]) : null;
  if (!before && !after) return null;

  const beforeTs = before ? n(before.ts) : 0;
  const afterTs = after ? n(after.ts) : 0;
  const beforeGap = beforeTs ? Math.abs(qTs - beforeTs) : Number.MAX_SAFE_INTEGER;
  const afterGap = afterTs ? Math.abs(afterTs - qTs) : Number.MAX_SAFE_INTEGER;

  const nearest = beforeGap <= afterGap ? before : after;
  const nearestTs = n(nearest?.ts);
  if (!nearestTs) return null;

  const gapSeconds = Math.abs(nearestTs - qTs);
  if (gapSeconds > MAX_QUERY_GAP_SECONDS) {
    return {
      status: "no_data_for_requested_time",
      query_ts: qTs,
      gap_seconds: gapSeconds,
      max_gap_seconds: MAX_QUERY_GAP_SECONDS,
      nearest: null,
    };
  }

  return {
    status: nearestTs === qTs ? "exact_match" : "nearest_within_gap",
    query_ts: qTs,
    gap_seconds: gapSeconds,
    max_gap_seconds: MAX_QUERY_GAP_SECONDS,
    nearest,
  };
}

function buildPrompt(deviceId, userMessage, contextData, telemetryRows, requestedPoint) {
  const hasTelemetry = Array.isArray(telemetryRows) && telemetryRows.length > 0;
  const requestedPointBlock = requestedPoint
    ? JSON.stringify(requestedPoint, null, 2)
    : "Not provided.";
  return [
    "You are TierAI Ops Assistant.",
    "Use only the provided telemetry context.",
    `All time references in your answer must be in timezone: ${contextData?.requested_timezone || "UTC"}.`,
    "If data is insufficient, explicitly state what is missing.",
    "Return ONLY valid JSON with keys:",
    "{\"current_state\":\"...\",\"likely_issue\":\"...\",\"next_checks\":[\"...\"],\"urgency\":\"low|medium|high\",\"data_freshness\":\"fresh_5m|stale_5m|no_context\",\"requested_time_local\":\"...\",\"requested_time_temperature\":0,\"requested_time_humidity\":0,\"note\":\"...\"}",
    "",
    `Device ID: ${deviceId}`,
    "",
    "Context summaries:",
    JSON.stringify(contextData, null, 2),
    "",
    "Recent telemetry (optional):",
    hasTelemetry ? JSON.stringify(telemetryRows.slice(-10), null, 2) : "Not included in this request.",
    "",
    "Requested timestamp lookup (optional):",
    requestedPointBlock,
    "If requested timestamp lookup is present and has nearest telemetry, answer with those exact values first.",
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

function formatEpochSecondsInTimezone(epochSeconds, timeZone) {
  const ms = n(epochSeconds) * 1000;
  if (!ms) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

function extractTempAndTs(row) {
  if (!row || typeof row !== "object") {
    return { ts: null, temp: null };
  }
  const ts = n(row.ts);
  let temp = null;
  if (row.temp !== undefined) {
    temp = Number(row.temp);
  } else if (row.payload && row.payload.temp !== undefined) {
    temp = Number(row.payload.temp);
  }
  if (!Number.isFinite(temp)) {
    temp = null;
  }
  return { ts, temp };
}

function extractHumidity(row) {
  if (!row || typeof row !== "object") {
    return null;
  }
  let humidity = null;
  if (row.humidity !== undefined) {
    humidity = Number(row.humidity);
  } else if (row.payload && row.payload.humidity !== undefined) {
    humidity = Number(row.payload.humidity);
  }
  return Number.isFinite(humidity) ? humidity : null;
}

function computeLastPositiveSlope(telemetryRows, timeZone) {
  if (!Array.isArray(telemetryRows) || telemetryRows.length < 2) {
    return { last_positive_slope_ts: null, last_positive_slope_local: null };
  }

  let lastPositiveTs = null;
  let lastPositiveDelta = null;

  for (let i = 1; i < telemetryRows.length; i += 1) {
    const prev = extractTempAndTs(telemetryRows[i - 1]);
    const curr = extractTempAndTs(telemetryRows[i]);
    if (!prev.ts || !curr.ts || prev.temp === null || curr.temp === null) {
      continue;
    }
    const delta = curr.temp - prev.temp;
    if (delta > 0) {
      lastPositiveTs = curr.ts;
      lastPositiveDelta = Number(delta.toFixed(4));
    }
  }

  return {
    last_positive_slope_ts: lastPositiveTs,
    last_positive_slope_delta: lastPositiveDelta,
    last_positive_slope_local: lastPositiveTs
      ? formatEpochSecondsInTimezone(lastPositiveTs, timeZone || "UTC")
      : null,
  };
}

function enrichContextWithTimezone(contextData, timeZone) {
  const tz = timeZone || "UTC";
  const clone = {
    ...contextData,
    requested_timezone: tz,
  };
  if (clone.latest_5m) {
    clone.latest_5m = {
      ...clone.latest_5m,
      window_end_local: formatEpochSecondsInTimezone(clone.latest_5m.window_end_ts, tz),
    };
  }
  if (clone.latest_60m) {
    clone.latest_60m = {
      ...clone.latest_60m,
      window_end_local: formatEpochSecondsInTimezone(clone.latest_60m.window_end_ts, tz),
    };
  }
  return clone;
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

function deriveCurrentState(contextData, deterministic) {
  const tz = contextData?.requested_timezone || "UTC";
  const use5m = deterministic?.source_window_minutes === 5;
  const source = use5m ? contextData?.latest_5m : contextData?.latest_60m;
  if (!source) {
    return `No recent telemetry context available in timezone ${tz}.`;
  }
  const windowEndLocal = source.window_end_local || "unknown local time";
  return `Last reading recorded at ${windowEndLocal} (${tz})`;
}

function enrichRequestedPoint(requestedPoint, timeZone) {
  if (!requestedPoint) return null;
  const nearest = requestedPoint.nearest || null;
  const nearestTs = n(nearest?.ts);
  const tempInfo = extractTempAndTs(nearest);
  return {
    ...requestedPoint,
    query_local: formatEpochSecondsInTimezone(requestedPoint.query_ts, timeZone || "UTC"),
    nearest_local: nearestTs ? formatEpochSecondsInTimezone(nearestTs, timeZone || "UTC") : null,
    nearest_temp: tempInfo.temp,
    nearest_humidity: extractHumidity(nearest),
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
        const queryTs = Number(body.query_ts || 0);
        const localTimezone =
          typeof body.local_timezone === "string" && body.local_timezone.trim()
            ? body.local_timezone.trim()
            : "UTC";

        if (!deviceId || !message || typeof message !== "string") {
          res.status(400).json({
            detail:
              "Invalid request. Expected { device_id: string, message: string, context_only?: boolean, local_timezone?: string }.",
          });
          return;
        }

        const baseContextData = await getLatestContextByWindow(deviceId);
        const contextData = enrichContextWithTimezone(baseContextData, localTimezone);
        const telemetryRows = (contextOnly && !queryTs) ? [] : await getRecentTelemetry(deviceId);
        const requestedPointRaw = queryTs ? await getNearestTelemetryAtTs(deviceId, queryTs) : null;
        const requestedPoint = enrichRequestedPoint(requestedPointRaw, localTimezone);
        const hasContext = Boolean(contextData.latest_5m || contextData.latest_60m);
        const hasTelemetry = telemetryRows.length > 0 || Boolean(requestedPoint?.nearest);
        const deterministic = computeDeterministicSignals(contextData);
        const slopeInfo = computeLastPositiveSlope(telemetryRows, localTimezone);

        if ((contextOnly && !hasContext) || (!contextOnly && !hasContext && !hasTelemetry)) {
          res
            .status(404)
            .json({ detail: `No telemetry/context found for device_id=${deviceId}.` });
          return;
        }

        const prompt = buildPrompt(deviceId, message, contextData, telemetryRows, requestedPoint);
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
        structuredAnswer.current_state = deriveCurrentState(contextData, deterministic);
        structuredAnswer.data_freshness = deterministic.data_freshness;
        structuredAnswer.urgency = deterministic.deterministic_urgency;
        structuredAnswer.last_positive_slope_local =
          slopeInfo.last_positive_slope_local || null;
        structuredAnswer.requested_time_local = requestedPoint?.nearest_local || null;
        structuredAnswer.requested_time_temperature = requestedPoint?.nearest_temp ?? null;
        structuredAnswer.requested_time_humidity = requestedPoint?.nearest_humidity ?? null;
        if (!structuredAnswer.note) {
          if (deterministic.data_freshness === "stale_5m") {
            structuredAnswer.note = "No usable 5-minute telemetry; guidance is based on 60-minute context.";
          } else if (deterministic.data_freshness === "no_context") {
            structuredAnswer.note = "No telemetry context available for this device.";
          }
        }
        if (!structuredAnswer.note && requestedPoint && !requestedPoint.nearest) {
          structuredAnswer.note =
            `No telemetry found near requested time within ${MAX_QUERY_GAP_SECONDS} seconds.`;
        }

        res.status(200).json({
          answer,
          structured_answer: structuredAnswer,
          device_id: deviceId,
          mode: contextOnly ? "context_only" : "context_plus_telemetry",
          deterministic: {
            ...deterministic,
            ...slopeInfo,
            requested_point: requestedPoint,
          },
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
