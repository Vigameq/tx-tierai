import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
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

  readonly canSend = computed(() => this.inputText().trim().length > 0 && !this.loading());

  private shouldIncludeTelemetry(userText: string): boolean {
    const text = userText.toLowerCase();
    return (
      text.includes('last 5') ||
      text.includes('last five') ||
      text.includes('readings') ||
      text.includes('raw') ||
      text.includes('recent values') ||
      text.includes('latest values')
    );
  }

  send(): void {
    const text = this.inputText().trim();
    if (!text || this.loading()) {
      return;
    }

    this.messages.update((m) => [...m, { role: 'user', content: text, ts: new Date().toISOString() }]);
    this.inputText.set('');
    this.loading.set(true);

    const includeTelemetry = this.shouldIncludeTelemetry(text);

    this.chatService
      .chat({
        device_id: this.deviceId(),
        message: text,
        context_only: !includeTelemetry,
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
}
