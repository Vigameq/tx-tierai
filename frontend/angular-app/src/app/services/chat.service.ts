import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ChatRequest, ChatResponse } from '../models/chat.models';

@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl =
    (window as { __TIERAI_API_URL__?: string }).__TIERAI_API_URL__ ||
    "http://127.0.0.1:5001/YOUR_FIREBASE_PROJECT_ID/asia-southeast1/chat";

  chat(payload: ChatRequest): Observable<ChatResponse> {
    return this.http.post<ChatResponse>(this.baseUrl, payload);
  }
}
