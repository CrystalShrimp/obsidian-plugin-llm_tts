import { Notice } from 'obsidian';
import {
  AICallSettings,
  CallMessage,
  CallStatus,
  ContextMode,
  MessageContext,
  TTSResult,
} from '../types';
import { LLMClient } from './LLMClient';
import { TTSClient } from './TTSClient';
import { AudioPlayer } from './AudioPlayer';

interface ControllerDeps {
  getSettings: () => AICallSettings;
  saveSettings?: () => Promise<void> | void;
  llm: LLMClient;
  tts: TTSClient;
  audio: AudioPlayer;
  initialMessages?: CallMessage[];
  persistMessages?: (messages: CallMessage[]) => void | Promise<void>;
}

interface ConversationState {
  status: CallStatus;
  messages: CallMessage[];
  contextMode: ContextMode;
  error?: string;
}

export interface SendOptions {
  context?: MessageContext;
}

export class ConversationController {
  private state: ConversationState;

  private listeners = new Set<() => void>();
  private abortController?: AbortController;
  private lastTurnAudioCache: TTSResult[] = [];
  private cachedAudioMessageId: string | null = null;

  constructor(private deps: ControllerDeps) {
    this.state = {
      status: 'idle',
      messages: (deps.initialMessages || []).map((m) => ({ ...m, streaming: false })),
      contextMode: deps.getSettings().defaultContextMode,
    };
  }

  private saveHistory() {
    if (this.deps.persistMessages) {
      void this.deps.persistMessages(this.state.messages);
    }
  }

  getState(): ConversationState {
    return this.state;
  }

  setContextMode(mode: ContextMode) {
    if (mode === this.state.contextMode) return;
    this.state = { ...this.state, contextMode: mode };
    this.emit();
  }

  setActivePrompt(promptId: string) {
    const settings = this.deps.getSettings();
    if (!settings.prompts.some((p) => p.id === promptId)) return;
    settings.activePromptId = promptId;
    void this.deps.saveSettings?.();
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private setStatus(status: CallStatus, error?: string) {
    this.state = { ...this.state, status, error };
    this.emit();
  }

  private addMessage(
    message: Omit<CallMessage, 'id' | 'createdAt'>,
  ): CallMessage {
    const fullMessage: CallMessage = {
      id: this.makeId(),
      createdAt: Date.now(),
      ...message,
    };
    this.state = {
      ...this.state,
      messages: [...this.state.messages, fullMessage],
    };
    this.emit();
    this.saveHistory();
    return fullMessage;
  }

  private patchMessage(id: string, patch: Partial<CallMessage>) {
    let changed = false;
    const messages = this.state.messages.map((m) => {
      if (m.id !== id) return m;
      changed = true;
      return { ...m, ...patch };
    });
    if (!changed) return;
    this.state = { ...this.state, messages };
    this.emit();
  }

  private appendToMessage(id: string, delta: string) {
    const messages = this.state.messages.map((m) => {
      if (m.id !== id) return m;
      return { ...m, text: m.text + delta };
    });
    this.state = { ...this.state, messages };
    this.emit();
  }

  private makeId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }
    return `m_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  async send(userText: string, options?: SendOptions) {
    const text = userText.trim();
    if (!text) return;

    // If options?.context is provided, it's a new knowledge point inquiry.
    // Clear previous history/step outputs and stop any current audio FIRST.
    if (options?.context) {
      this.clear();
    }

    if (this.state.status === 'thinking' || this.state.status === 'streaming') {
      this.abortController?.abort();
    }

    this.abortController = new AbortController();

    this.addMessage({
      role: 'user',
      text,
      context: options?.context,
    });

    const assistant = this.addMessage({
      role: 'assistant',
      text: '',
      streaming: true,
    });

    await this.streamAssistantTurn(assistant.id);
  }

  /**
   * Drop the last assistant turn and re-run the last user turn with its
   * original context. Useful when the user wants a different phrasing.
   */
  async regenerate() {
    if (this.state.status === 'thinking' || this.state.status === 'streaming') {
      return;
    }
    const messages = this.state.messages;
    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex === -1) return;

    const lastUser = messages[lastUserIndex];
    const trimmed = messages.slice(0, lastUserIndex);
    this.state = { ...this.state, messages: trimmed };
    this.emit();
    this.saveHistory();

    await this.send(lastUser.text, { context: lastUser.context });
  }

  private async streamAssistantTurn(assistantId: string) {
    try {
      this.setStatus('thinking');
      console.log('[llm-tts] streamAssistantTurn started for ID:', assistantId);

      const settings = this.deps.getSettings();
      const filtered = this.state.messages.filter((m) => m.id !== assistantId);
      const lastUser = filtered[filtered.length - 1];
      const currentScope = lastUser?.context?.scope;

      const persona = this.resolveActivePersona(settings, currentScope);
      const hasContext = !!lastUser?.context;
      console.log('[llm-tts] streamAssistantTurn context info:', { hasContext, currentScope, messageCount: this.state.messages.length });

      if (hasContext) {
        // --- Knowledge Point Mode (2-step prompt) ---
        console.log('[llm-tts] [Step 1] starting technical generation...');
        // Step 1: Generate technical text silently (UI shows "正在生成文本...")
        this.patchMessage(assistantId, { text: '正在生成文本...', streaming: false });

        const reply = await this.deps.llm.generateReplyStream({
          messages: this.trimHistory(this.state.messages, assistantId),
          persona,
          temperature: settings.temperature,
          signal: this.abortController!.signal,
          // onDelta omitted so it does not stream Step 1 text to the bubble
        });
        console.log('[llm-tts] [Step 1] completed successfully. Length:', reply.reply.length);

        // Save Step 1 text, clear the bubble text, and prepare for Step 2 streaming
        this.patchMessage(assistantId, {
          step1Text: reply.reply,
          text: '',
          streaming: true,
        });
        this.saveHistory();

        console.log('[llm-tts] [Step 2] starting colloquial translation...');
        this.setStatus('streaming');
        const spokenText = await this.deps.llm.translateToTTS(
          reply.reply,
          this.abortController!.signal,
          (delta) => {
            this.appendToMessage(assistantId, delta);
          }
        );
        console.log('[llm-tts] [Step 2] completed successfully. Length:', spokenText.length);

        this.patchMessage(assistantId, {
          text: spokenText,
          streaming: false,
        });
        this.saveHistory();

        if (!this.deps.getSettings().autoPlay) {
          console.log('[llm-tts] autoPlay is false. Stopping.');
          this.setStatus('idle');
          return;
        }

        console.log('[llm-tts] [TTS] starting pipelined synthesis...');
        this.setStatus('speaking');

        await this.playTextPipelined(
          spokenText,
          reply.voiceInstruction ?? '',
          this.abortController!.signal,
          assistantId
        );
        console.log('[llm-tts] [TTS] playback finished.');

      } else {
        // --- Follow-up Mode (1-step normal chat) ---
        console.log('[llm-tts] [Follow-up Mode] starting normal stream...');
        const reply = await this.deps.llm.generateReplyStream({
          // Limit to 3 messages (2 historical messages + 1 current user query)
          messages: this.trimHistory(this.state.messages, assistantId, 3),
          persona,
          temperature: settings.temperature,
          signal: this.abortController!.signal,
          onDelta: (delta) => {
            if (this.state.status !== 'streaming') this.setStatus('streaming');
            this.appendToMessage(assistantId, delta);
          },
        });
        console.log('[llm-tts] [Follow-up Mode] completed successfully. Length:', reply.reply.length);

        this.patchMessage(assistantId, {
          text: reply.reply,
          streaming: false,
        });
        this.saveHistory();
      }

      this.setStatus('idle');
      this.saveHistory();
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        console.log('[llm-tts] generation aborted by user.');
        this.patchMessage(assistantId, { streaming: false });
        this.setStatus('idle');
        this.saveHistory();
        return;
      }
      console.error('[llm-tts] conversation error', err);
      new Notice('发生错误，详情请按 Ctrl+Shift+I 查看控制台', 5000);
      this.patchMessage(assistantId, { streaming: false });
      this.setStatus('error', describeError(err));
      this.saveHistory();
    }
  }

  /** Abort any in-flight stream and stop any audio playback. */
  stop() {
    this.abortController?.abort();
    this.deps.audio.stop();
    if (this.state.status !== 'idle' || this.state.error) {
      this.setStatus('idle');
    }
  }

  async replayLastAssistantMessage() {
    const last = [...this.state.messages]
      .reverse()
      .find((m) => m.role === 'assistant' && !m.streaming && m.text.trim());

    if (!last) return;

    if (this.state.status === 'thinking' || this.state.status === 'streaming' || this.state.status === 'speaking') {
      this.abortController?.abort();
    }
    this.abortController = new AbortController();

    try {
      this.setStatus('speaking');
      if (this.cachedAudioMessageId === last.id && this.lastTurnAudioCache.length > 0) {
        console.log('[llm-tts] Replaying from cache for message:', last.id);
        for (const result of this.lastTurnAudioCache) {
          if (this.abortController.signal.aborted) return;
          await this.deps.audio.play(result);
        }
      } else {
        console.log('[llm-tts] Cache miss or different message, synthesizing for:', last.id);
        await this.playTextPipelined(
          last.text,
          last.voiceInstruction ?? '',
          this.abortController.signal,
          last.id
        );
      }
      this.setStatus('idle');
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        this.setStatus('idle');
        return;
      }
      console.error('[llm-tts] replay error', err);
      new Notice('重新朗读失败，详情请在控制台查看', 5000);
      this.setStatus('error', describeError(err));
    }
  }

  private async playTextPipelined(text: string, voiceInstruction: string, signal?: AbortSignal, messageId?: string) {
    const sentences = splitSentences(text);
    if (sentences.length === 0) return;

    if (messageId) {
      this.cachedAudioMessageId = messageId;
      this.lastTurnAudioCache = [];
    }

    const prefetch = (idx: number) => {
      if (idx >= sentences.length) return null;
      return this.deps.tts.synthesize({
        text: sentences[idx],
        voiceInstruction,
        signal,
      });
    };

    let nextSynthesisPromise = prefetch(0);

    for (let i = 0; i < sentences.length; i++) {
      if (signal?.aborted) return;
      const result = await nextSynthesisPromise!;
      nextSynthesisPromise = prefetch(i + 1);
      
      if (messageId) {
        this.lastTurnAudioCache.push(result);
      }
      
      await this.deps.audio.play(result);
    }
  }

  clear() {
    this.stop();
    this.state = {
      status: 'idle',
      messages: [],
      contextMode: this.deps.getSettings().defaultContextMode,
      error: undefined,
    };
    this.lastTurnAudioCache = [];
    this.cachedAudioMessageId = null;
    this.emit();
    this.saveHistory();
  }

  private trimHistory(messages: CallMessage[], excludeId?: string, limit?: number): CallMessage[] {
    const filtered = excludeId
      ? messages.filter((m) => m.id !== excludeId)
      : messages;
    const max = limit ?? this.deps.getSettings().maxHistoryMessages;
    return filtered.slice(-max);
  }

  private resolveActivePersona(settings: AICallSettings, scope?: ContextMode): string {
    if (settings.prompts && settings.prompts.length > 0) {
      const active =
        settings.prompts.find((p) => p.id === settings.activePromptId) ??
        settings.prompts[0];
      if (scope === 'h3-single') {
        return active.contentSingle || active.content || '';
      } else {
        return active.contentMulti || active.content || '';
      }
    }
    return settings.persona;
  }
}

/**
 * Extract a non-empty human-readable message from a thrown error. Many fetch
 * failures produce an empty `err.message` (CORS preflight, network down), and
 * SpeechSynthesis errors sometimes come back with `event.error === ''`. In
 * those cases fall back to a concrete string so the UI error banner isn't
 * blank.
 */
function describeError(err: unknown): string {
  if (err == null) return '未知错误';
  if (typeof err === 'string') return err.trim() || '未知错误';
  if (err instanceof Error) {
    const msg = (err.message ?? '').trim();
    if (msg) return msg;
    return err.name && err.name !== 'Error' ? err.name : '未知错误';
  }
  const str = String(err).trim();
  return str || '未知错误';
}

function splitSentences(text: string): string[] {
  // Split by Chinese period, exclamation, question mark, semicolon and newlines
  const raw = text.split(/([。？！；\n])/g);
  const result: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const sentence = raw[i];
    const punctuation = raw[i + 1] || '';
    const full = (sentence + punctuation).trim();
    if (full) {
      result.push(full);
    }
  }
  return result;
}
