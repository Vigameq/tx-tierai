import { CommonModule } from '@angular/common';
import { Component, ElementRef, ViewChild, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { catchError, finalize, of } from 'rxjs';
import { ChatMessage } from '../../models/chat.models';
import { ChatService } from '../../services/chat.service';

@Component({
  selector: 'app-tierai-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './tierai-dashboard.component.html',
  styleUrl: './tierai-dashboard.component.css',
})
export class TieraiDashboardComponent {
  private readonly chatService = inject(ChatService);
  @ViewChild('messagesContainer') private messagesContainer?: ElementRef<HTMLDivElement>;
  private readonly bottomThresholdPx = 48;
  private stickToBottom = true;
  private forceNextScroll = false;

  readonly deviceId = signal('servexl/edgeblr01');
  readonly inputText = signal('');
  readonly selectedDateTime = signal('');
  readonly loading = signal(false);
  readonly messages = signal<ChatMessage[]>([
    {
      role: 'assistant',
      content: 'TierAI assistant ready. Ask about current state, trend, risk, or next checks.',
      ts: new Date().toISOString(),
    },
  ]);
  readonly localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  readonly canSend = computed(() => this.inputText().trim().length > 0 && !this.loading());

  constructor() {
    effect(() => {
      this.messages();
      this.loading();
      if (this.forceNextScroll || this.stickToBottom) {
        this.forceNextScroll = false;
        this.scheduleScrollToBottom();
      }
    });
  }

  private shouldIncludeTelemetry(userText: string): boolean {
    const text = userText.toLowerCase();
    const telemetryKeywords = [
      'readings',
      'raw',
      'recent values',
      'latest values',
      'last 5',
      'last five',
      'last ',
      'when',
      'rose',
      'rise',
      'hour',
      'minute',
      'timeline',
      'time series',
      'history',
    ];
    const metricKeywords = ['temp', 'temperature', 'humidity', 'value', 'values'];
    const hasTelemetryIntent = telemetryKeywords.some((k) => text.includes(k));
    const hasMetricIntent = metricKeywords.some((k) => text.includes(k));
    return hasTelemetryIntent && hasMetricIntent;
  }

  send(): void {
    const text = this.inputText().trim();
    if (!text || this.loading()) {
      return;
    }

    this.forceNextScroll = true;
    this.messages.update((m) => [...m, { role: 'user', content: text, ts: new Date().toISOString() }]);
    this.inputText.set('');
    this.loading.set(true);

    const includeTelemetry = this.shouldIncludeTelemetry(text);
    const queryTs = this.toQueryTs(this.selectedDateTime());

    this.chatService
      .chat({
        device_id: this.deviceId(),
        message: text,
        context_only: queryTs ? false : !includeTelemetry,
        local_timezone: this.localTimezone,
        query_ts: queryTs ?? undefined,
      })
      .pipe(
        catchError((err) => {
          const message = err?.error?.detail || 'Chat request failed. Check API URL and backend logs.';
          this.messages.update((m) => [...m, { role: 'assistant', content: String(message), ts: new Date().toISOString() }]);
          return of(null);
        }),
        finalize(() => this.loading.set(false))
      )
      .subscribe((res) => {
        if (!res) {
          return;
        }
        this.messages.update((m) => [
          ...m,
          {
            role: 'assistant',
            content: res.answer,
            structured: res.structured_answer ?? null,
            ts: new Date().toISOString(),
          },
        ]);
      });
  }

  onComposerKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }

  onMessagesScroll(): void {
    this.stickToBottom = this.isNearBottom();
  }

  clearDateTime(): void {
    this.selectedDateTime.set('');
  }

  private scheduleScrollToBottom(): void {
    setTimeout(() => this.scrollToBottom(), 0);
  }

  private scrollToBottom(): void {
    const el = this.messagesContainer?.nativeElement;
    if (!el) {
      return;
    }
    el.scrollTop = el.scrollHeight;
    this.stickToBottom = true;
  }

  private isNearBottom(): boolean {
    const el = this.messagesContainer?.nativeElement;
    if (!el) {
      return true;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distanceFromBottom <= this.bottomThresholdPx;
  }

  private toQueryTs(localDateTime: string): number | null {
    if (!localDateTime) {
      return null;
    }
    const ms = new Date(localDateTime).getTime();
    if (!Number.isFinite(ms) || ms <= 0) {
      return null;
    }
    return Math.floor(ms / 1000);
  }
}
