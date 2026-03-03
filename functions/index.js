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
const MAX_QUERY_ROWS = Number(process.env.MAX_QUERY_ROWS || 500);

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

function parseNum(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function parseLocalDateTimeText(text) {
  if (!text || typeof text !== "string") return null;
  const m = text
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6] || 0);
  if (
    year < 1970 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }
  return { year, month, day, hour, minute, second };
}

function parseGmtOffsetToMinutes(text) {
  if (!text) return null;
  const m = String(text).match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const hours = Number(m[2]);
  const mins = Number(m[3] || 0);
  if (!Number.isFinite(hours) || !Number.isFinite(mins)) return null;
  return sign * (hours * 60 + mins);
}

function getOffsetMinutesForTimezone(epochMs, timeZone) {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "UTC",
      timeZoneName: "shortOffset",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = dtf.formatToParts(new Date(epochMs));
    const tzName = parts.find((p) => p.type === "timeZoneName")?.value || "";
    const offsetMin = parseGmtOffsetToMinutes(tzName);
    return offsetMin === null ? 0 : offsetMin;
  } catch {
    return 0;
  }
}

function localDateTimeToEpoch(localText, timeZone) {
  const p = parseLocalDateTimeText(localText);
  if (!p) return null;
  const localMsAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  let offsetMin = getOffsetMinutesForTimezone(localMsAsUtc, timeZone);
  let epochMs = localMsAsUtc - offsetMin * 60 * 1000;
  const refinedOffset = getOffsetMinutesForTimezone(epochMs, timeZone);
  if (refinedOffset !== offsetMin) {
    offsetMin = refinedOffset;
    epochMs = localMsAsUtc - offsetMin * 60 * 1000;
  }
  return Math.floor(epochMs / 1000);
}

function getTodayDateInTimezone(timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    if (byType.year && byType.month && byType.day) {
      return `${byType.year}-${byType.month}-${byType.day}`;
    }
  } catch {
    // ignore
  }
  return new Date().toISOString().slice(0, 10);
}

function shiftIsoDate(isoDate, dayOffset) {
  const m = String(isoDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return isoDate;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() + dayOffset);
  const y = dt.getUTCFullYear();
  const mo = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

function inferDatePartFromMessage(text, fallbackTimezone) {
  const lower = String(text || "").toLowerCase();
  const explicitDate = lower.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (explicitDate) {
    return explicitDate[1];
  }
  const today = getTodayDateInTimezone(fallbackTimezone || "UTC");
  if (/\byesterday\b/.test(lower)) {
    return shiftIsoDate(today, -1);
  }
  if (/\btomorrow\b/.test(lower)) {
    return shiftIsoDate(today, 1);
  }
  return today;
}

function timezoneAbbrevToOffset(tz) {
  const map = {
    UTC: "+00:00",
    GMT: "+00:00",
    EST: "-05:00",
    EDT: "-04:00",
    CST: "-06:00",
    CDT: "-05:00",
    MST: "-07:00",
    MDT: "-06:00",
    PST: "-08:00",
    PDT: "-07:00",
  };
  return map[String(tz || "").toUpperCase()] || null;
}

function inferQueryTsFromMessage(message, fallbackTimezone) {
  if (typeof message !== "string" || !message.trim()) return null;

  const text = message.trim();
  const fullPattern =
    /(?:(\d{4}-\d{2}-\d{2})\s*(?:at\s*)?)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s*(UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT)?/i;
  const m = text.match(fullPattern);
  if (!m) return null;

  const [, datePartRaw, hhRaw, mmRaw, ssRaw, ampmRaw, tzRaw] = m;
  const datePart = datePartRaw || inferDatePartFromMessage(text, fallbackTimezone || "UTC");
  let hour = n(hhRaw);
  const minute = n(mmRaw);
  const second = n(ssRaw || 0);
  const ampm = (ampmRaw || "").toUpperCase();
  const tzOffset = timezoneAbbrevToOffset(tzRaw);

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return null;
  }

  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === "AM") {
      hour = hour % 12;
    } else if (ampm === "PM") {
      hour = (hour % 12) + 12;
    }
  }

  if (!tzOffset) {
    return null;
  }

  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const ss = String(second).padStart(2, "0");
  const iso = `${datePart}T${hh}:${mm}:${ss}${tzOffset}`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function formatEpochSecondsInTimezone(epochSeconds, timeZone) {
  const ms = n(epochSeconds) * 1000;
  if (!ms) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).formatToParts(new Date(ms));
    const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    const dd = byType.day || "00";
    const mm = byType.month || "00";
    const yyyy = byType.year || "0000";
    const hh = byType.hour || "00";
    const min = byType.minute || "00";
    const sec = byType.second || "00";
    const tz = byType.timeZoneName || "UTC";
    return `${dd}-${mm}-${yyyy}, ${hh}:${min}:${sec} ${tz}`;
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

function normalizeTelemetryRow(row, timeZone) {
  const ts = n(row?.ts);
  const tempInfo = extractTempAndTs(row);
  return {
    device_id: row?.device_id || null,
    ts,
    ts_local: ts ? formatEpochSecondsInTimezone(ts, timeZone || "UTC") : null,
    temp: tempInfo.temp,
    humidity: extractHumidity(row),
    unit_temp: row?.unit_temp || row?.payload?.unit_temp || "degC",
    unit_humidity: row?.unit_humidity || row?.payload?.unit_humidity || "RH",
  };
}

function inferLastNReadingsRequest(message) {
  const text = String(message || "");
  const m = text.match(
    /\b(?:last|latest|recent)\s+(\d+)\s+(?:telemetry\s+)?(?:readings?|values?|data\s*points?)\b/i
  );
  if (!m) return null;
  const nValue = parseNum(m[1], 0);
  if (!nValue) return null;
  return Math.min(Math.max(nValue, 1), 20);
}

function buildLastNReadings(rows, nCount, timeZone) {
  const normalized = (rows || []).map((r) => normalizeTelemetryRow(r, timeZone));
  const latest = normalized.slice(-nCount).reverse();
  return latest.map((r, idx) => ({
    index: idx + 1,
    ts: r.ts,
    ts_local: r.ts_local,
    temp: r.temp,
    humidity: r.humidity,
    unit_temp: r.unit_temp || "degC",
    unit_humidity: r.unit_humidity || "RH",
  }));
}

function structuredAnswerToText(structured) {
  const checks = Array.isArray(structured?.next_checks)
    ? structured.next_checks.join("\n")
    : String(structured?.next_checks || "");
  return [
    `Current state\n${structured?.current_state || ""}`,
    `Likely issue\n${structured?.likely_issue || ""}`,
    `Next checks\n${checks}`,
    `Urgency\n${structured?.urgency || ""}`,
    `Data freshness\n${structured?.data_freshness || ""}`,
    `Note\n${structured?.note || ""}`,
  ].join("\n\n");
}

async function queryTelemetryRange(deviceId, startTs, endTs, limit = MAX_QUERY_ROWS) {
  const safeLimit = Math.min(Math.max(1, parseNum(limit, MAX_QUERY_ROWS)), MAX_QUERY_ROWS);
  const items = [];
  let lastEvaluatedKey;

  do {
    const resp = await dynamo.send(
      new QueryCommand({
        TableName: TELEMETRY_TABLE,
        KeyConditionExpression: "device_id = :d AND #ts BETWEEN :s AND :e",
        ExpressionAttributeNames: { "#ts": "ts" },
        ExpressionAttributeValues: {
          ":d": { S: deviceId },
          ":s": { N: String(startTs) },
          ":e": { N: String(endTs) },
        },
        ScanIndexForward: true,
        ExclusiveStartKey: lastEvaluatedKey,
        Limit: Math.min(100, safeLimit - items.length),
      })
    );
    (resp.Items || []).forEach((item) => items.push(unmarshall(item)));
    lastEvaluatedKey = resp.LastEvaluatedKey;
  } while (lastEvaluatedKey && items.length < safeLimit);

  return {
    items,
    truncated: Boolean(lastEvaluatedKey),
    limit: safeLimit,
  };
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

function withCors(handler) {
  return async (req, res) => {
    corsHandler(req, res, async () => {
      if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
      }
      await handler(req, res);
    });
  };
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
        const contextOnly = body.context_only === true;
        const explicitQueryTs = Number(body.query_ts || 0);
        const localTimezone =
          typeof body.local_timezone === "string" && body.local_timezone.trim()
            ? body.local_timezone.trim()
            : "UTC";
        const parsedQueryTs = inferQueryTsFromMessage(message, localTimezone);
        const queryTs = explicitQueryTs || parsedQueryTs || 0;

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
        const lastNRequest = inferLastNReadingsRequest(message);

        if ((contextOnly && !hasContext) || (!contextOnly && !hasContext && !hasTelemetry)) {
          res
            .status(404)
            .json({ detail: `No telemetry/context found for device_id=${deviceId}.` });
          return;
        }

        if (lastNRequest) {
          const lastReadings = buildLastNReadings(telemetryRows, lastNRequest, localTimezone);
          const readingLines = lastReadings.map(
            (r) =>
              `${r.index}. ${r.ts_local}: Temp ${r.temp ?? "NA"} ${r.unit_temp}, Humidity ${r.humidity ?? "NA"} ${r.unit_humidity}`
          );
          const structuredAnswer = {
            current_state: readingLines.length
              ? `Latest ${readingLines.length} telemetry readings for ${deviceId}:\n${readingLines.join("\n")}`
              : `No telemetry readings available for ${deviceId}.`,
            likely_issue: readingLines.length
              ? "No immediate issue identified from the requested readings."
              : "No raw telemetry found in the queried window.",
            next_checks: readingLines.length
              ? ["Ask for trend analysis or threshold breaches on these readings."]
              : ["Verify IoT ingestion and DynamoDB writes for this device."],
            urgency: deterministic.deterministic_urgency,
            data_freshness: deterministic.data_freshness,
            note:
              readingLines.length < lastNRequest
                ? `Requested last ${lastNRequest} readings, but only ${readingLines.length} were available.`
                : `Showing last ${readingLines.length} readings from raw telemetry.`,
            last_positive_slope_local: slopeInfo.last_positive_slope_local || null,
          };

          res.status(200).json({
            answer: structuredAnswerToText(structuredAnswer),
            structured_answer: structuredAnswer,
            device_id: deviceId,
            mode: contextOnly ? "context_only" : "context_plus_telemetry",
            deterministic: {
              ...deterministic,
              ...slopeInfo,
              requested_point: requestedPoint,
              query_ts_used: queryTs || null,
              query_ts_source: explicitQueryTs
                ? "request.query_ts"
                : parsedQueryTs
                  ? "parsed_from_message"
                  : null,
              last_readings: lastReadings,
            },
            context_used: contextData,
          });
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
            query_ts_used: queryTs || null,
            query_ts_source: explicitQueryTs
              ? "request.query_ts"
              : parsedQueryTs
                ? "parsed_from_message"
                : null,
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

exports.readings = onRequest(
  { region: "asia-southeast1", timeoutSeconds: 120, memory: "512MiB" },
  withCors(async (req, res) => {
    if (!["GET", "POST"].includes(req.method)) {
      res.status(405).json({ detail: "Method not allowed. Use GET or POST." });
      return;
    }
    try {
      const body = req.method === "GET" ? req.query : parseBody(req);
      const deviceId = body.device_id;
      const localTimezone =
        typeof body.local_timezone === "string" && body.local_timezone.trim()
          ? body.local_timezone.trim()
          : "UTC";
      const startTs =
        parseNum(body.start_ts) || localDateTimeToEpoch(body.start_local, localTimezone) || 0;
      const endTs =
        parseNum(body.end_ts) || localDateTimeToEpoch(body.end_local, localTimezone) || 0;
      const limit = parseNum(body.limit, MAX_QUERY_ROWS);

      if (!deviceId || !startTs || !endTs || endTs < startTs) {
        res.status(400).json({
          detail:
            "Invalid request. Expected device_id and either (start_ts,end_ts) or (start_local,end_local), optional limit/local_timezone.",
        });
        return;
      }

      const result = await queryTelemetryRange(deviceId, startTs, endTs, limit);
      const readings = result.items.map((row) => normalizeTelemetryRow(row, localTimezone));

      res.status(200).json({
        device_id: deviceId,
        start_ts: startTs,
        end_ts: endTs,
        local_timezone: localTimezone,
        count: readings.length,
        truncated: result.truncated,
        limit: result.limit,
        readings,
      });
    } catch (error) {
      logger.error("readings function failed", error);
      res.status(500).json({
        detail: `Backend error: ${error.message || "unknown error"}`,
      });
    }
  })
);

exports.exceedances = onRequest(
  { region: "asia-southeast1", timeoutSeconds: 120, memory: "512MiB" },
  withCors(async (req, res) => {
    if (!["GET", "POST"].includes(req.method)) {
      res.status(405).json({ detail: "Method not allowed. Use GET or POST." });
      return;
    }
    try {
      const body = req.method === "GET" ? req.query : parseBody(req);
      const deviceId = body.device_id;
      const localTimezone =
        typeof body.local_timezone === "string" && body.local_timezone.trim()
          ? body.local_timezone.trim()
          : "UTC";
      const startTs =
        parseNum(body.start_ts) || localDateTimeToEpoch(body.start_local, localTimezone) || 0;
      const endTs =
        parseNum(body.end_ts) || localDateTimeToEpoch(body.end_local, localTimezone) || 0;
      const thresholdTemp = parseNum(body.threshold_temp, 40);
      const limit = parseNum(body.limit, MAX_QUERY_ROWS);

      if (!deviceId || !startTs || !endTs || endTs < startTs) {
        res.status(400).json({
          detail:
            "Invalid request. Expected device_id and either (start_ts,end_ts) or (start_local,end_local), optional threshold_temp/limit/local_timezone.",
        });
        return;
      }

      const result = await queryTelemetryRange(deviceId, startTs, endTs, limit);
      const exceedances = result.items
        .map((row) => normalizeTelemetryRow(row, localTimezone))
        .filter((row) => row.temp !== null && row.temp > thresholdTemp);

      res.status(200).json({
        device_id: deviceId,
        start_ts: startTs,
        end_ts: endTs,
        threshold_temp: thresholdTemp,
        local_timezone: localTimezone,
        count: exceedances.length,
        scanned_count: result.items.length,
        truncated: result.truncated,
        limit: result.limit,
        exceedances,
      });
    } catch (error) {
      logger.error("exceedances function failed", error);
      res.status(500).json({
        detail: `Backend error: ${error.message || "unknown error"}`,
      });
    }
  })
);

exports.timeToEpoch = onRequest(
  { region: "asia-southeast1", timeoutSeconds: 120, memory: "256MiB" },
  withCors(async (req, res) => {
    if (!["GET", "POST"].includes(req.method)) {
      res.status(405).json({ detail: "Method not allowed. Use GET or POST." });
      return;
    }
    try {
      const body = req.method === "GET" ? req.query : parseBody(req);
      const localDatetime = body.local_datetime;
      const localTimezone =
        typeof body.local_timezone === "string" && body.local_timezone.trim()
          ? body.local_timezone.trim()
          : "UTC";

      if (!localDatetime) {
        res.status(400).json({
          detail: "Invalid request. Expected local_datetime and optional local_timezone.",
        });
        return;
      }

      const epoch = localDateTimeToEpoch(localDatetime, localTimezone);
      if (!epoch) {
        res.status(400).json({
          detail:
            "Could not parse local_datetime. Expected format: YYYY-MM-DD HH:mm:ss or YYYY-MM-DDTHH:mm:ss",
        });
        return;
      }

      res.status(200).json({
        local_datetime: localDatetime,
        local_timezone: localTimezone,
        epoch_ts: epoch,
        formatted_local: formatEpochSecondsInTimezone(epoch, localTimezone),
      });
    } catch (error) {
      logger.error("timeToEpoch function failed", error);
      res.status(500).json({
        detail: `Backend error: ${error.message || "unknown error"}`,
      });
    }
  })
);
