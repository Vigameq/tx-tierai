import { CommonModule } from '@angular/common';
import { Component, ElementRef, ViewChild, computed, effect, inject, signal } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
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
  private readonly sanitizer = inject(DomSanitizer);
  @ViewChild('messagesContainer') private messagesContainer?: ElementRef<HTMLDivElement>;
  private readonly bottomThresholdPx = 48;
  private stickToBottom = true;
  private forceNextScroll = false;

  readonly deviceId = signal('servexl/edgeblr01');
  readonly inputText = signal('');
  readonly loading = signal(false);
  readonly messages = signal<ChatMessage[]>([
    {
      role: 'assistant',
      content: 'TierAI assistant ready. Ask about current state, trend, risk, or next checks.',
      ts: new Date().toISOString(),
    },
  ]);
  readonly localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  readonly grafanaUrlRaw =
    (window as { __TIERAI_GRAFANA_URL__?: string }).__TIERAI_GRAFANA_URL__?.trim() || '';
  readonly grafanaEmbedUrl: SafeResourceUrl | null =
    this.grafanaUrlRaw && /^https?:\/\//i.test(this.grafanaUrlRaw)
      ? this.sanitizer.bypassSecurityTrustResourceUrl(this.grafanaUrlRaw)
      : null;
  readonly examplePrompts = [
    'What is the current state of this device?',
    'Did temperature exceed 40 C in the last hour?',
    'What was temperature at 2:45 AM EST yesterday?',
    'List the last 5 telemetry readings.',
  ];

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

  send(): void {
    const text = this.inputText().trim();
    if (!text || this.loading()) {
      return;
    }

    this.forceNextScroll = true;
    this.messages.update((m) => [...m, { role: 'user', content: text, ts: new Date().toISOString() }]);
    this.inputText.set('');
    this.loading.set(true);

    this.chatService
      .chat({
        device_id: this.deviceId(),
        message: text,
        context_only: false,
        local_timezone: this.localTimezone,
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

  applyPrompt(prompt: string): void {
    if (this.loading()) {
      return;
    }
    this.inputText.set(prompt);
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
}
