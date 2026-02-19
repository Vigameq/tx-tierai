export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: string;
  structured?: StructuredAnswer | null;
}

export interface ChatRequest {
  device_id: string;
  message: string;
  context_only?: boolean;
  local_timezone?: string;
}

export interface ChatResponse {
  answer: string;
  structured_answer?: StructuredAnswer | null;
  device_id: string;
  context_used: {
    latest_5m?: Record<string, unknown> | null;
    latest_60m?: Record<string, unknown> | null;
  };
}

export interface StructuredAnswer {
  current_state?: string;
  likely_issue?: string;
  next_checks?: string[];
  urgency?: 'low' | 'medium' | 'high' | string;
  data_freshness?: 'fresh_5m' | 'stale_5m' | 'no_context' | string;
  note?: string;
}
