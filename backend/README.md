# TierAI Chat Backend (Python)

## What this provides
- `POST /chat` endpoint (`FastAPI`)
- Reads latest context + recent telemetry from DynamoDB
- Calls Bedrock Runtime and returns an ops answer
- Lambda-compatible entrypoint via `Mangum`

## Environment variables
- `AWS_REGION=ap-southeast-1`
- `BEDROCK_MODEL_ID=anthropic.claude-3-5-sonnet-20240620-v1:0`
- `TELEMETRY_TABLE=TierAITelemetry`
- `CONTEXT_TABLE=TierAIContext`
- `MAX_TELEMETRY_ROWS=30`

## Local run
```bash
pip install -r requirements.txt
uvicorn chat_api:app --reload --port 8000
```

## Lambda / Functions hosting
Yes, this can be hosted as a function.

- Handler: `lambda_handler.handler`
- Runtime: Python 3.11+
- Package this folder with dependencies
- Put API Gateway in front of Lambda

## Required IAM permissions for function role
- `dynamodb:Query` on `TierAITelemetry`
- `dynamodb:Query` on `TierAIContext`
- `bedrock:InvokeModel` on selected model
- CloudWatch Logs write permissions

## Request body example
```json
{
  "device_id": "servexl/edgeblr01",
  "message": "Is this device at risk now? What should I check next?"
}
```
