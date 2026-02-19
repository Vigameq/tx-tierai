export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: string;
}

export interface ChatRequest {
  device_id: string;
  message: string;
  context_only?: boolean;
}

export interface ChatResponse {
  answer: string;
  device_id: string;
  context_used: {
    latest_5m?: Record<string, unknown> | null;
    latest_60m?: Record<string, unknown> | null;
  };
}
