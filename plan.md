帮我做一个可语音回复用户消息的obsidian插件：LLM 用 DeepSeek；TTS 先做 HTTP 音频接口 + WebSpeech 兜底；AudioPlayer 自己写，实现`DeepSeek streaming + WebSocket TTS streaming + 边说边显示字幕`



## 0. 推荐目录

```text
src/
├─ main.ts
├─ types.ts
├─ views/
│  └─ CallView.ts
├─ core/
│  ├─ ConversationController.ts
│  ├─ LLMClient.ts
│  ├─ TTSClient.ts
│  └─ AudioPlayer.ts
├─ settings/
│  └─ SettingsTab.ts
└─ vendor/
   └─ nutstore-chatbox/
      ├─ components/solid-js/...
      └─ ai/chat/...
```

这里的 `vendor/nutstore-chatbox` 是你从坚果云项目里抽出来的 chatbox UI 相关模块。先别全量复制整个同步插件，否则会被 WebDAV、同步服务、权限 guard、AI agent 工具链拖住。

---

# 1. `types.ts`

```ts
export type CallStatus = 'idle' | 'thinking' | 'speaking' | 'paused' | 'error';

export type Role = 'user' | 'assistant' | 'system';

export interface CallMessage {
  id: string;
  role: Role;
  text: string;
  createdAt: number;
  voiceInstruction?: string;
}

export interface LLMReply {
  reply: string;
  voiceInstruction: string;
}

export type TTSMode = 'custom-http' | 'web-speech';

export interface TTSAudioResult {
  kind: 'audio';
  blob: Blob;
  mimeType: string;
}

export interface TTSSpeechSynthesisResult {
  kind: 'speech-synthesis';
  text: string;
  lang?: string;
  voiceName?: string;
}

export type TTSResult = TTSAudioResult | TTSSpeechSynthesisResult;

export interface AICallSettings {
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  deepseekModel: string;

  persona: string;
  maxHistoryMessages: number;

  ttsMode: TTSMode;

  /**
   * 推荐你先做一个自己的 TTS gateway：
   * Obsidian 插件 -> 你的 TTS gateway -> 火山 / 阿里 / 腾讯
   *
   * 这样可以避免在插件前端里写复杂签名，也避免泄露厂商 AccessKey。
   */
  ttsEndpoint: string;
  ttsApiKey: string;
  ttsVoice: string;
  ttsLang: string;

  autoPlay: boolean;
}

export const DEFAULT_SETTINGS: AICallSettings = {
  deepseekApiKey: '',
  deepseekBaseUrl: 'https://api.deepseek.com',
  deepseekModel: 'deepseek-chat',

  persona:
    '你正在和用户进行一场文字输入、语音输出的模拟电话。回复要像真人通话，不要写长篇文章。每次回复控制在 2-12 句话。语气自然，有停顿感，有情绪。输出 JSON：{"reply":"...","voiceInstruction":"..."}',
  maxHistoryMessages: 12,

  ttsMode: 'web-speech',
  ttsEndpoint: '',
  ttsApiKey: '',
  ttsVoice: 'zh-CN-XiaoxiaoNeural',
  ttsLang: 'zh-CN',

  autoPlay: true,
};
```

---

# 2. `main.ts`

这个文件负责：加载设置、注册右侧视图、注册命令、暴露 controller。



```ts
import { Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import { DEFAULT_SETTINGS, AICallSettings } from './types';
import { CallView, CALL_VIEW_TYPE } from './views/CallView';
import { AICallSettingTab } from './settings/SettingsTab';
import { ConversationController } from './core/ConversationController';
import { LLMClient } from './core/LLMClient';
import { TTSClient } from './core/TTSClient';
import { AudioPlayer } from './core/AudioPlayer';

export default class AICallPlugin extends Plugin {
  settings!: AICallSettings;

  audioPlayer!: AudioPlayer;
  llmClient!: LLMClient;
  ttsClient!: TTSClient;
  conversation!: ConversationController;

  async onload() {
    await this.loadSettings();

    this.audioPlayer = new AudioPlayer();
    this.llmClient = new LLMClient(() => this.settings);
    this.ttsClient = new TTSClient(() => this.settings);

    this.conversation = new ConversationController({
      getSettings: () => this.settings,
      llm: this.llmClient,
      tts: this.ttsClient,
      audio: this.audioPlayer,
    });

    this.registerView(
      CALL_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new CallView(leaf, this),
    );

    this.addRibbonIcon('phone-call', 'AI Call', async () => {
      await this.activateCallView();
    });

    this.addCommand({
      id: 'open-ai-call',
      name: 'Open AI Call',
      callback: async () => {
        await this.activateCallView();
      },
    });

    this.addCommand({
      id: 'stop-ai-call-audio',
      name: 'Stop AI Call Audio',
      callback: () => {
        this.conversation.stopAudio();
        new Notice('AI Call audio stopped');
      },
    });

    this.addSettingTab(new AICallSettingTab(this.app, this));
  }

  onunload() {
    this.audioPlayer.destroy();
    this.app.workspace.detachLeavesOfType(CALL_VIEW_TYPE);
  }

  async activateCallView() {
    const existingLeaf = this.app.workspace.getLeavesOfType(CALL_VIEW_TYPE)[0];

    const leaf =
      existingLeaf ?? this.app.workspace.getRightLeaf(false);

    if (!leaf) {
      new Notice('Cannot open AI Call view');
      return;
    }

    await leaf.setViewState({
      type: CALL_VIEW_TYPE,
      active: true,
    });

    this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(await this.loadData()),
    };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
```

---

# 3. `views/CallView.ts`

这里有两个关键点：

1. **照坚果云的做法继承 `ItemView`**；
2. **用 `mountChatbox(...)` 接入坚果云 chatbox UI**。

坚果云 `chatbox.view.ts` 里就是 `export const CHATBOX_VIEW_TYPE = 'nutstore-sync-chatbox'`，然后 `ChatboxView extends ItemView`，最后在 `onOpen()` 里创建 root element 并 mount chatbox。([GitHub][4])

你这里可以这样写：

```ts
import {
  Component,
  ItemView,
  MarkdownRenderer,
  WorkspaceLeaf,
} from 'obsidian';

import type AICallPlugin from '../main';
import type { CallMessage } from '../types';

/**
 * 你可以保留坚果云模块路径，也可以放到 vendor 里。
 *
 * 如果你是从 obsidian-nutstore-sync fork 出来改：
 * import { mountChatbox } from '../components/solid-js';
 * import type { ChatboxController } from '../ai/chat/ui/types';
 *
 * 如果你是新插件里 vendor：
 */
import { mountChatbox } from '../vendor/nutstore-chatbox/components/solid-js';
import type { ChatboxController } from '../vendor/nutstore-chatbox/ai/chat/ui/types';

export const CALL_VIEW_TYPE = 'ai-call-view';

export class CallView extends ItemView {
  private rootEl!: HTMLDivElement;
  private chatbox?: ChatboxController;
  private unsub?: () => void;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: AICallPlugin,
  ) {
    super(leaf);
  }

  getViewType() {
    return CALL_VIEW_TYPE;
  }

  getDisplayText() {
    return 'AI Call';
  }

  getIcon() {
    return 'phone-call';
  }

  async onOpen() {
    this.contentEl.empty();

    this.rootEl = this.contentEl.createDiv({
      cls: 'ai-call-view h-full',
    });

    this.remount();

    this.unsub = this.plugin.conversation.subscribe(() => {
      this.updateChatbox();
    });
  }

  async onClose() {
    this.unsub?.();
    this.unsub = undefined;

    this.chatbox?.destroy?.();
    this.chatbox = undefined;

    this.contentEl.empty();
  }

  private async renderMarkdown(el: HTMLElement, markdown: string) {
    const component = new Component();
    this.addChild(component);
    component.load();

    const renderedEl = el.ownerDocument.createElement('div');

    try {
      await MarkdownRenderer.render(
        this.app,
        markdown,
        renderedEl,
        '',
        component,
      );

      el.replaceChildren(...Array.from(renderedEl.childNodes));

      if (!el.childNodes.length) {
        el.textContent = markdown;
      }
    } catch {
      el.textContent = markdown;
    }

    return () => {
      component.unload();
      el.replaceChildren();
    };
  }

  private remount() {
    this.chatbox?.destroy?.();

    /**
     * 这里故意用 as any：
     * 因为 nutstore 的 ChatboxProps 字段比较多，而且版本可能变。
     * 你先把核心 props 对上，能跑之后再补全强类型。
     */
    this.chatbox = mountChatbox(
      this.rootEl,
      this.getChatboxProps() as any,
    );
  }

  private updateChatbox() {
    this.chatbox?.update?.(this.getChatboxProps() as any);
  }

  private getChatboxProps() {
    const state = this.plugin.conversation.getState();

    return {
      title: 'AI Call',
      status: state.status,

      messages: state.messages.map((m: CallMessage) => ({
        id: m.id,
        role: m.role,
        content: m.text,
        createdAt: m.createdAt,
      })),

      draft: {
        text: '',
        userContext: [],
      },

      isSending: state.status === 'thinking',
      isSpeaking: state.status === 'speaking',

      renderMarkdown: this.renderMarkdown.bind(this),

      onSendMessage: async (text: string) => {
        await this.plugin.conversation.send(text);
      },

      onStop: () => {
        this.plugin.conversation.stopAudio();
      },

      onReplayLast: async () => {
        await this.plugin.conversation.replayLastAssistantMessage();
      },

      onClear: () => {
        this.plugin.conversation.clear();
      },
    };
  }
}
```

这里最可能需要你微调的是 `getChatboxProps()`。因为坚果云的 `ChatboxProps` 不是为你的“AI 电话”场景设计的，字段名可能不完全一致。思路是：**把你的 Conversation state 映射成它的 messages / draft / callback。**

---

# 4. `core/ConversationController.ts`

这个是“电话感”的核心。它负责：

```text
用户输入
→ LLM 生成文本和语气说明
→ UI 显示文本
→ TTS 生成语音
→ AudioPlayer 播放
```

```ts
import {
  AICallSettings,
  CallMessage,
  CallStatus,
  LLMReply,
} from '../types';
import { LLMClient } from './LLMClient';
import { TTSClient } from './TTSClient';
import { AudioPlayer } from './AudioPlayer';

interface ControllerDeps {
  getSettings: () => AICallSettings;
  llm: LLMClient;
  tts: TTSClient;
  audio: AudioPlayer;
}

interface ConversationState {
  status: CallStatus;
  messages: CallMessage[];
  error?: string;
}

export class ConversationController {
  private state: ConversationState = {
    status: 'idle',
    messages: [],
  };

  private listeners = new Set<() => void>();
  private abortController?: AbortController;

  constructor(private deps: ControllerDeps) {}

  getState() {
    return this.state;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private setStatus(status: CallStatus, error?: string) {
    this.state = {
      ...this.state,
      status,
      error,
    };

    this.emit();
  }

  private addMessage(message: Omit<CallMessage, 'id' | 'createdAt'>) {
    const fullMessage: CallMessage = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      ...message,
    };

    this.state = {
      ...this.state,
      messages: [...this.state.messages, fullMessage],
    };

    this.emit();

    return fullMessage;
  }

  async send(userText: string) {
    const text = userText.trim();
    if (!text) return;

    this.abortController?.abort();
    this.abortController = new AbortController();

    this.addMessage({
      role: 'user',
      text,
    });

    try {
      this.setStatus('thinking');

      const reply: LLMReply = await this.deps.llm.generateReply({
        messages: this.trimHistory(this.state.messages),
        persona: this.deps.getSettings().persona,
        signal: this.abortController.signal,
      });

      const assistantMessage = this.addMessage({
        role: 'assistant',
        text: reply.reply,
        voiceInstruction: reply.voiceInstruction,
      });

      if (!this.deps.getSettings().autoPlay) {
        this.setStatus('idle');
        return;
      }

      this.setStatus('speaking');

      const ttsResult = await this.deps.tts.synthesize({
        text: assistantMessage.text,
        voiceInstruction: assistantMessage.voiceInstruction ?? '',
        signal: this.abortController.signal,
      });

      await this.deps.audio.play(ttsResult);

      this.setStatus('idle');
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        this.setStatus('idle');
        return;
      }

      console.error(err);
      this.setStatus('error', (err as Error).message);
    }
  }

  stopAudio() {
    this.abortController?.abort();
    this.deps.audio.stop();
    this.setStatus('idle');
  }

  async replayLastAssistantMessage() {
    const last = [...this.state.messages]
      .reverse()
      .find((m) => m.role === 'assistant');

    if (!last) return;

    try {
      this.setStatus('speaking');

      const result = await this.deps.tts.synthesize({
        text: last.text,
        voiceInstruction: last.voiceInstruction ?? '',
      });

      await this.deps.audio.play(result);

      this.setStatus('idle');
    } catch (err) {
      console.error(err);
      this.setStatus('error', (err as Error).message);
    }
  }

  clear() {
    this.stopAudio();

    this.state = {
      status: 'idle',
      messages: [],
    };

    this.emit();
  }

  private trimHistory(messages: CallMessage[]) {
    const max = this.deps.getSettings().maxHistoryMessages;
    return messages.slice(-max);
  }
}
```

---

# 5. `core/LLMClient.ts`

DeepSeek 官方文档说明它兼容 OpenAI / Anthropic API 格式；你这里用 OpenAI-compatible 的 `/chat/completions` 形式就行。([DeepSeek API Docs][5])

````ts
import { requestUrl } from 'obsidian';
import { AICallSettings, CallMessage, LLMReply } from '../types';

interface GenerateReplyInput {
  messages: CallMessage[];
  persona: string;
  signal?: AbortSignal;
}

export class LLMClient {
  constructor(private getSettings: () => AICallSettings) {}

  async generateReply(input: GenerateReplyInput): Promise<LLMReply> {
    const settings = this.getSettings();

    if (!settings.deepseekApiKey.trim()) {
      throw new Error('DeepSeek API Key is empty');
    }

    const url = `${settings.deepseekBaseUrl.replace(/\/$/, '')}/chat/completions`;

    const messages = [
      {
        role: 'system',
        content: input.persona,
      },
      ...input.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role,
          content: m.text,
        })),
    ];

    const response = await requestUrl({
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.deepseekApiKey}`,
      },
      body: JSON.stringify({
        model: settings.deepseekModel,
        messages,
        temperature: 0.8,
        stream: false,
      }),
    });

    const content =
      response.json?.choices?.[0]?.message?.content?.trim?.() ?? '';

    if (!content) {
      throw new Error('DeepSeek returned empty response');
    }

    return this.parseReply(content);
  }

  private parseReply(content: string): LLMReply {
    const cleaned = content
      .replace(/^```json/i, '')
      .replace(/^```/, '')
      .replace(/```$/, '')
      .trim();

    try {
      const parsed = JSON.parse(cleaned);

      return {
        reply: String(parsed.reply ?? '').trim() || cleaned,
        voiceInstruction:
          String(parsed.voiceInstruction ?? parsed.voice_instruction ?? '')
            .trim() || '自然、温和、有电话感',
      };
    } catch {
      return {
        reply: cleaned,
        voiceInstruction: '自然、温和、有电话感',
      };
    }
  }
}
````

---

# 6. `core/TTSClient.ts`

这里我建议你先抽象成两个模式：

```text
custom-http：接你自己的国内 TTS gateway
web-speech：浏览器 / Electron 自带 speechSynthesis 兜底
```

火山引擎豆包语音有 WebSocket 双向流式 TTS，支持文本流式输入、音频流式输出、低时延，适合做“真电话感”；阿里云语音合成也支持输出 PCM/WAV/MP3。([volcengine.com][6])

```ts
import { requestUrl } from 'obsidian';
import {
  AICallSettings,
  TTSResult,
} from '../types';

interface SynthesizeInput {
  text: string;
  voiceInstruction?: string;
  signal?: AbortSignal;
}

export class TTSClient {
  constructor(private getSettings: () => AICallSettings) {}

  async synthesize(input: SynthesizeInput): Promise<TTSResult> {
    const settings = this.getSettings();

    if (settings.ttsMode === 'web-speech') {
      return {
        kind: 'speech-synthesis',
        text: input.text,
        lang: settings.ttsLang,
        voiceName: settings.ttsVoice,
      };
    }

    if (settings.ttsMode === 'custom-http') {
      return await this.synthesizeByCustomHttp(input);
    }

    throw new Error(`Unsupported TTS mode: ${settings.ttsMode}`);
  }

  private async synthesizeByCustomHttp(
    input: SynthesizeInput,
  ): Promise<TTSResult> {
    const settings = this.getSettings();

    if (!settings.ttsEndpoint.trim()) {
      throw new Error('TTS endpoint is empty');
    }

    /**
     * 建议你的 TTS gateway 接收这个统一 body：
     *
     * POST /tts
     * {
     *   "text": "...",
     *   "voice": "...",
     *   "lang": "zh-CN",
     *   "style": "温柔、慢速、有安慰感",
     *   "format": "mp3"
     * }
     *
     * 返回：
     * Content-Type: audio/mpeg
     * body: mp3 binary
     */
    const response = await requestUrl({
      url: settings.ttsEndpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(settings.ttsApiKey
          ? { Authorization: `Bearer ${settings.ttsApiKey}` }
          : {}),
      },
      body: JSON.stringify({
        text: input.text,
        voice: settings.ttsVoice,
        lang: settings.ttsLang,
        style: input.voiceInstruction ?? '',
        format: 'mp3',
      }),
    });

    const contentType =
      response.headers?.['content-type'] ??
      response.headers?.['Content-Type'] ??
      'audio/mpeg';

    const arrayBuffer = response.arrayBuffer;

    if (!arrayBuffer) {
      throw new Error('TTS response has no audio data');
    }

    return {
      kind: 'audio',
      blob: new Blob([arrayBuffer], {
        type: contentType,
      }),
      mimeType: contentType,
    };
  }
}
```

---

# 7. `core/AudioPlayer.ts`

`obsidian-tts` 这个现有插件已经暴露了 `say / pause / resume / stop / isSpeaking / isPaused` 这样的播放控制 API，说明这个控制面板是合理的；ElevenLabs 的 Obsidian 插件也有“生成音频后在 Obsidian 内播放”的设置，并在代码里用 `HTMLAudioElement` 做预览播放。([GitHub][7])

你自己的 `AudioPlayer` 可以这样写：

```ts
import { TTSResult } from '../types';

export class AudioPlayer {
  private audio?: HTMLAudioElement;
  private objectUrl?: string;

  private utterance?: SpeechSynthesisUtterance;
  private lastResult?: TTSResult;

  async play(result: TTSResult): Promise<void> {
    this.stop();
    this.lastResult = result;

    if (result.kind === 'audio') {
      return await this.playBlob(result.blob);
    }

    return await this.speakByWebSpeech(result.text, {
      lang: result.lang,
      voiceName: result.voiceName,
    });
  }

  async replay(): Promise<void> {
    if (!this.lastResult) return;
    await this.play(this.lastResult);
  }

  pause() {
    if (this.audio && !this.audio.paused) {
      this.audio.pause();
      return;
    }

    if (speechSynthesis.speaking && !speechSynthesis.paused) {
      speechSynthesis.pause();
    }
  }

  resume() {
    if (this.audio && this.audio.paused) {
      void this.audio.play();
      return;
    }

    if (speechSynthesis.paused) {
      speechSynthesis.resume();
    }
  }

  stop() {
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
      this.audio = undefined;
    }

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = undefined;
    }

    if (speechSynthesis.speaking || speechSynthesis.pending) {
      speechSynthesis.cancel();
    }

    this.utterance = undefined;
  }

  destroy() {
    this.stop();
  }

  private async playBlob(blob: Blob): Promise<void> {
    this.objectUrl = URL.createObjectURL(blob);
    this.audio = new Audio(this.objectUrl);

    await new Promise<void>((resolve, reject) => {
      if (!this.audio) return resolve();

      this.audio.onended = () => resolve();
      this.audio.onerror = () => reject(new Error('Audio playback failed'));

      void this.audio.play().catch(reject);
    });
  }

  private async speakByWebSpeech(
    text: string,
    options: {
      lang?: string;
      voiceName?: string;
    },
  ): Promise<void> {
    if (!('speechSynthesis' in window)) {
      throw new Error('speechSynthesis is not available');
    }

    await this.waitForVoices();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = options.lang ?? 'zh-CN';

    const voices = speechSynthesis.getVoices();
    const matchedVoice = voices.find((voice) => {
      if (!options.voiceName) return false;

      return (
        voice.name === options.voiceName ||
        voice.name.includes(options.voiceName)
      );
    });

    if (matchedVoice) {
      utterance.voice = matchedVoice;
    }

    this.utterance = utterance;

    await new Promise<void>((resolve, reject) => {
      utterance.onend = () => resolve();
      utterance.onerror = (event) => {
        reject(new Error(`Speech synthesis failed: ${event.error}`));
      };

      speechSynthesis.speak(utterance);
    });
  }

  private async waitForVoices(): Promise<void> {
    const voices = speechSynthesis.getVoices();

    if (voices.length > 0) return;

    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        speechSynthesis.onvoiceschanged = null;
        resolve();
      }, 1000);

      speechSynthesis.onvoiceschanged = () => {
        window.clearTimeout(timer);
        speechSynthesis.onvoiceschanged = null;
        resolve();
      };
    });
  }
}
```

---

# 8. `settings/SettingsTab.ts`

```ts
import {
  App,
  PluginSettingTab,
  Setting,
} from 'obsidian';

import type AICallPlugin from '../main';

export class AICallSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: AICallPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', {
      text: 'AI Call Settings',
    });

    new Setting(containerEl)
      .setName('DeepSeek API Key')
      .setDesc('用于调用 DeepSeek Chat Completions')
      .addText((text) => {
        text
          .setPlaceholder('sk-...')
          .setValue(this.plugin.settings.deepseekApiKey)
          .onChange(async (value) => {
            this.plugin.settings.deepseekApiKey = value.trim();
            await this.plugin.saveSettings();
          });

        text.inputEl.type = 'password';
      });

    new Setting(containerEl)
      .setName('DeepSeek Base URL')
      .setDesc('默认：https://api.deepseek.com')
      .addText((text) =>
        text
          .setPlaceholder('https://api.deepseek.com')
          .setValue(this.plugin.settings.deepseekBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.deepseekBaseUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('DeepSeek Model')
      .setDesc('普通对话建议 deepseek-chat')
      .addText((text) =>
        text
          .setPlaceholder('deepseek-chat')
          .setValue(this.plugin.settings.deepseekModel)
          .onChange(async (value) => {
            this.plugin.settings.deepseekModel = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Persona / Call Prompt')
      .setDesc('控制电话人格、回复长度、情绪风格')
      .addTextArea((text) => {
        text
          .setPlaceholder('你正在和用户进行一场模拟电话...')
          .setValue(this.plugin.settings.persona)
          .onChange(async (value) => {
            this.plugin.settings.persona = value;
            await this.plugin.saveSettings();
          });

        text.inputEl.rows = 8;
        text.inputEl.cols = 40;
      });

    new Setting(containerEl)
      .setName('Max History Messages')
      .setDesc('每次请求带多少轮上下文')
      .addSlider((slider) =>
        slider
          .setLimits(4, 30, 1)
          .setValue(this.plugin.settings.maxHistoryMessages)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxHistoryMessages = value;
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl('h3', {
      text: 'TTS',
    });

    new Setting(containerEl)
      .setName('TTS Mode')
      .setDesc('custom-http 用国内 TTS gateway；web-speech 用系统兜底语音')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('web-speech', 'Web Speech fallback')
          .addOption('custom-http', 'Custom HTTP TTS')
          .setValue(this.plugin.settings.ttsMode)
          .onChange(async (value: 'web-speech' | 'custom-http') => {
            this.plugin.settings.ttsMode = value;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName('TTS Endpoint')
      .setDesc('你的 TTS gateway 地址，例如 http://localhost:8787/tts')
      .addText((text) =>
        text
          .setPlaceholder('http://localhost:8787/tts')
          .setValue(this.plugin.settings.ttsEndpoint)
          .onChange(async (value) => {
            this.plugin.settings.ttsEndpoint = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('TTS API Key')
      .setDesc('如果你的 TTS gateway 需要鉴权，就填这里')
      .addText((text) => {
        text
          .setPlaceholder('optional')
          .setValue(this.plugin.settings.ttsApiKey)
          .onChange(async (value) => {
            this.plugin.settings.ttsApiKey = value.trim();
            await this.plugin.saveSettings();
          });

        text.inputEl.type = 'password';
      });

    new Setting(containerEl)
      .setName('TTS Voice')
      .setDesc('音色名；WebSpeech 下填系统 voice name，HTTP 下填你的服务端约定值')
      .addText((text) =>
        text
          .setPlaceholder('zh-CN-XiaoxiaoNeural')
          .setValue(this.plugin.settings.ttsVoice)
          .onChange(async (value) => {
            this.plugin.settings.ttsVoice = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('TTS Language')
      .setDesc('例如 zh-CN / en-US / ja-JP')
      .addText((text) =>
        text
          .setPlaceholder('zh-CN')
          .setValue(this.plugin.settings.ttsLang)
          .onChange(async (value) => {
            this.plugin.settings.ttsLang = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Auto Play')
      .setDesc('AI 回复后自动朗读')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoPlay)
          .onChange(async (value) => {
            this.plugin.settings.autoPlay = value;
            await this.plugin.saveSettings();
          }),
      );
  }
}
```

---




[1]: https://github.com/nutstore/obsidian-nutstore-sync/blob/main/src/index.ts "obsidian-nutstore-sync/src/index.ts at main · nutstore/obsidian-nutstore-sync · GitHub"
[2]: https://github.com/nutstore/obsidian-nutstore-sync "GitHub - nutstore/obsidian-nutstore-sync · GitHub"
[3]: https://docs.obsidian.md/Reference/TypeScript%2BAPI/Plugin?utm_source=chatgpt.com "Plugin - Developer Documentation"
[4]: https://github.com/nutstore/obsidian-nutstore-sync/blob/main/src/views/chatbox.view.ts "obsidian-nutstore-sync/src/views/chatbox.view.ts at main · nutstore/obsidian-nutstore-sync · GitHub"
[5]: https://api-docs.deepseek.com/?utm_source=chatgpt.com "DeepSeek API Docs: Your First API Call"
[6]: https://www.volcengine.com/docs/6561/2532486?utm_source=chatgpt.com "WebSocket双向流式语音合成--豆包语音"
[7]: https://github.com/joethei/obsidian-tts "GitHub - joethei/obsidian-tts: Text to speech for Obsidian. Hear your notes. · GitHub"
