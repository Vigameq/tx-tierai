import json
import os
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


AWS_REGION = os.getenv("AWS_REGION", "ap-southeast-1")
BEDROCK_MODEL_ID = os.getenv("BEDROCK_MODEL_ID", "anthropic.claude-3-5-sonnet-20240620-v1:0")
TELEMETRY_TABLE = os.getenv("TELEMETRY_TABLE", "TierAITelemetry")
CONTEXT_TABLE = os.getenv("CONTEXT_TABLE", "TierAIContext")
MAX_TELEMETRY_ROWS = int(os.getenv("MAX_TELEMETRY_ROWS", "30"))

dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
bedrock_runtime = boto3.client("bedrock-runtime", region_name=AWS_REGION)
telemetry_table = dynamodb.Table(TELEMETRY_TABLE)
context_table = dynamodb.Table(CONTEXT_TABLE)

app = FastAPI(title="TierAI Chat API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    device_id: str = Field(..., examples=["servexl/edgeblr01"])
    message: str = Field(..., min_length=1, max_length=4000)


class ChatResponse(BaseModel):
    answer: str
    device_id: str
    context_used: dict[str, Any]


def _to_jsonable(value: Any) -> Any:
    if isinstance(value, list):
        return [_to_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {k: _to_jsonable(v) for k, v in value.items()}
    if hasattr(value, "to_eng_string"):
        return float(value)
    return value


def get_latest_context_by_window(device_id: str) -> dict[str, Any]:
    try:
        response = context_table.query(
            KeyConditionExpression=Key("device_id").eq(device_id),
            ScanIndexForward=False,
            Limit=25,
        )
    except (ClientError, BotoCoreError) as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read context table: {exc}") from exc

    items = [_to_jsonable(x) for x in response.get("Items", [])]
    context_5m = next((x for x in items if int(x.get("window_minutes", -1)) == 5), None)
    context_60m = next((x for x in items if int(x.get("window_minutes", -1)) == 60), None)
    return {"latest_5m": context_5m, "latest_60m": context_60m}


def get_recent_telemetry(device_id: str) -> list[dict[str, Any]]:
    try:
        response = telemetry_table.query(
            KeyConditionExpression=Key("device_id").eq(device_id),
            ScanIndexForward=False,
            Limit=MAX_TELEMETRY_ROWS,
        )
    except (ClientError, BotoCoreError) as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read telemetry table: {exc}") from exc
    items = [_to_jsonable(x) for x in response.get("Items", [])]
    return list(reversed(items))


def build_prompt(device_id: str, user_message: str, context_data: dict[str, Any], telemetry_rows: list[dict[str, Any]]) -> str:
    context_blob = json.dumps(context_data, indent=2)
    telemetry_blob = json.dumps(telemetry_rows[-10:], indent=2)
    return (
        "You are TierAI Ops Assistant.\n"
        "Only use provided telemetry context.\n"
        "If data is insufficient, say exactly what is missing.\n"
        "Return concise operational guidance with: current state, likely issue, next checks, urgency.\n\n"
        f"Device ID: {device_id}\n\n"
        f"Context summaries:\n{context_blob}\n\n"
        f"Recent telemetry (latest 10 rows):\n{telemetry_blob}\n\n"
        f"User question: {user_message}"
    )


def invoke_bedrock(prompt: str) -> str:
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 700,
        "temperature": 0.2,
        "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
    }
    try:
        response = bedrock_runtime.invoke_model(
            modelId=BEDROCK_MODEL_ID,
            body=json.dumps(body),
            contentType="application/json",
            accept="application/json",
        )
        payload = json.loads(response["body"].read())
        chunks = payload.get("content", [])
        text_parts = [x.get("text", "") for x in chunks if isinstance(x, dict) and x.get("type") == "text"]
        answer = "\n".join([x for x in text_parts if x]).strip()
        if not answer:
            raise HTTPException(status_code=502, detail="Bedrock returned empty response.")
        return answer
    except (ClientError, BotoCoreError) as exc:
        raise HTTPException(status_code=502, detail=f"Bedrock call failed: {exc}") from exc


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/chat", response_model=ChatResponse)
def chat(request: ChatRequest) -> ChatResponse:
    context_data = get_latest_context_by_window(request.device_id)
    telemetry_rows = get_recent_telemetry(request.device_id)

    if not telemetry_rows and not context_data.get("latest_5m") and not context_data.get("latest_60m"):
        raise HTTPException(
            status_code=404,
            detail=f"No telemetry/context found for device_id={request.device_id}.",
        )

    prompt = build_prompt(request.device_id, request.message, context_data, telemetry_rows)
    answer = invoke_bedrock(prompt)
    return ChatResponse(answer=answer, device_id=request.device_id, context_used=context_data)
