import { App, ButtonComponent, Modal, PluginSettingTab, Setting } from 'obsidian';

import type AICallPlugin from '../main';
import { makePromptId } from '../types';
import type { ContextMode, PromptPreset, TTSMode } from '../types';

export class AICallSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: AICallPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.plugin.settings;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'LLM TTS' });

    new Setting(containerEl)
      .setName('LLM Base URL')
      .setDesc(
        'Any OpenAI-compatible endpoint. DeepSeek: https://api.deepseek.com; OpenAI: https://api.openai.com/v1; local Ollama: http://localhost:11434/v1.',
      )
      .addText((text) =>
        text
          .setPlaceholder('https://api.deepseek.com')
          .setValue(settings.llmBaseUrl)
          .onChange(async (value) => {
            settings.llmBaseUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('LLM API Key')
      .setDesc('Bearer token sent in Authorization header. Leave empty for local servers.')
      .addText((text) => {
        text
          .setPlaceholder('sk-...')
          .setValue(settings.llmApiKey)
          .onChange(async (value) => {
            settings.llmApiKey = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = 'password';
      });

    new Setting(containerEl)
      .setName('LLM Model')
      .setDesc('e.g. deepseek-chat, gpt-4o-mini, qwen2.5:7b')
      .addText((text) =>
        text
          .setPlaceholder('deepseek-chat')
          .setValue(settings.llmModel)
          .onChange(async (value) => {
            settings.llmModel = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl('h3', { text: 'Prompt 库' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: '在这里管理多套 prompt（如财管、经济法、审计等）。chatbox 顶部下拉可快速切换。',
    });

    this.renderPromptList();

    new Setting(containerEl)
      .setName('Add new prompt')
      .setDesc('新建一条空白 prompt，进去再编辑')
      .addButton((btn) =>
        btn
          .setButtonText('新建 prompt')
          .setCta()
          .onClick(async () => {
            const preset: PromptPreset = {
              id: makePromptId(),
              name: `未命名 prompt ${settings.prompts.length + 1}`,
              contentSingle: '',
              contentMulti: '',
              content: '',
            };
            settings.prompts.push(preset);
            if (!settings.activePromptId) settings.activePromptId = preset.id;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName('Max History Messages')
      .setDesc('How many prior turns to include as context.')
      .addSlider((slider) =>
        slider
          .setLimits(2, 40, 1)
          .setValue(settings.maxHistoryMessages)
          .setDynamicTooltip()
          .onChange(async (value) => {
            settings.maxHistoryMessages = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Temperature')
      .setDesc('Sampling temperature for chat completions.')
      .addSlider((slider) =>
        slider
          .setLimits(0, 1.5, 0.05)
          .setValue(settings.temperature)
          .setDynamicTooltip()
          .onChange(async (value) => {
            settings.temperature = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Default Document Context')
      .setDesc(
        '面板打开或清空对话时默认的上下文范围。',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption('h3-single', '单个 ### 知识点')
          .addOption('h2-block', '整节 ## (含下属所有知识点)')
          .addOption('all-h3', '全章所有 ### 知识点')
          .setValue(settings.defaultContextMode)
          .onChange(async (value: string) => {
            settings.defaultContextMode = value as ContextMode;
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl('h3', { text: 'TTS' });

    new Setting(containerEl)
      .setName('TTS Mode')
      .setDesc('custom-http → your TTS gateway; web-speech → built-in browser voice; cosyvoice-local → local CosyVoice; volcano → Volcano stream.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('web-speech', 'Web Speech fallback')
          .addOption('custom-http', 'Custom HTTP TTS')
          .addOption('cosyvoice-local', 'Local CosyVoice')
          .addOption('volcano', 'Volcano Stream')
          .setValue(settings.ttsMode)
          .onChange(async (value: string) => {
            settings.ttsMode = value as TTSMode;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (settings.ttsMode === 'custom-http') {
      new Setting(containerEl)
        .setName('TTS Endpoint')
        .setDesc('e.g. http://localhost:8787/tts')
        .addText((text) =>
          text
            .setPlaceholder('http://localhost:8787/tts')
            .setValue(settings.ttsEndpoint)
            .onChange(async (value) => {
              settings.ttsEndpoint = value.trim();
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName('TTS API Key')
        .setDesc('Optional bearer token for your gateway.')
        .addText((text) => {
          text
            .setPlaceholder('optional')
            .setValue(settings.ttsApiKey)
            .onChange(async (value) => {
              settings.ttsApiKey = value.trim();
              await this.plugin.saveSettings();
            });
          text.inputEl.type = 'password';
        });
    }

    if (settings.ttsMode === 'cosyvoice-local') {
      new Setting(containerEl)
        .setName('CosyVoice URL')
        .setDesc('Local CosyVoice API URL (e.g. http://localhost:50000).')
        .addText((text) =>
          text
            .setPlaceholder('http://localhost:50000')
            .setValue(settings.cosyvoiceUrl || 'http://localhost:50000')
            .onChange(async (value) => {
              settings.cosyvoiceUrl = value.trim();
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName('CosyVoice Speaker ID')
        .setDesc('Speaker ID / Role (e.g. 中文女, 中文男, etc.).')
        .addText((text) =>
          text
            .setPlaceholder('中文女')
            .setValue(settings.cosyvoiceSpkId || '中文女')
            .onChange(async (value) => {
              settings.cosyvoiceSpkId = value.trim();
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName('CosyVoice Sample Rate')
        .setDesc('PCM audio sample rate. Default is 22050.')
        .addText((text) =>
          text
            .setPlaceholder('22050')
            .setValue(String(settings.cosyvoiceSampleRate || 22050))
            .onChange(async (value) => {
              const parsed = parseInt(value.trim(), 10);
              settings.cosyvoiceSampleRate = isNaN(parsed) ? 22050 : parsed;
              await this.plugin.saveSettings();
            }),
        );
    }

    if (settings.ttsMode === 'volcano') {
      new Setting(containerEl)
        .setName('Volcano API Key')
        .setDesc('Bearer token (Access Token) for Volcano Engine TTS.')
        .addText((text) => {
          text
            .setPlaceholder('API Key')
            .setValue(settings.volcanoApiKey || '')
            .onChange(async (value) => {
              settings.volcanoApiKey = value.trim();
              await this.plugin.saveSettings();
            });
          text.inputEl.type = 'password';
        });

      new Setting(containerEl)
        .setName('Volcano Speaker ID')
        .setDesc('Speaker ID for voice selection (from Volcano console).')
        .addText((text) =>
          text
            .setPlaceholder('e.g. Chengcheng')
            .setValue(settings.volcanoSpeaker || '')
            .onChange(async (value) => {
              settings.volcanoSpeaker = value.trim();
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName('Volcano Resource ID')
        .setDesc('App resource ID (defaults to volc.service_type.10029).')
        .addText((text) =>
          text
            .setPlaceholder('volc.service_type.10029')
            .setValue(settings.volcanoResourceId || 'volc.service_type.10029')
            .onChange(async (value) => {
              settings.volcanoResourceId = value.trim();
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName('Volcano Sample Rate')
        .setDesc('Audio sample rate. Default is 24000 (usually 16000 or 24000).')
        .addText((text) =>
          text
            .setPlaceholder('24000')
            .setValue(String(settings.volcanoSampleRate || 24000))
            .onChange(async (value) => {
              const parsed = parseInt(value.trim(), 10);
              settings.volcanoSampleRate = isNaN(parsed) ? 24000 : parsed;
              await this.plugin.saveSettings();
            }),
        );
    }

    if (settings.ttsMode === 'web-speech' || settings.ttsMode === 'custom-http') {
      new Setting(containerEl)
        .setName('TTS Voice')
        .setDesc(
          settings.ttsMode === 'web-speech'
            ? 'System voice name (e.g. zh-CN-XiaoxiaoNeural).'
            : 'Voice identifier your gateway understands.',
        )
        .addText((text) =>
          text
            .setPlaceholder('zh-CN-XiaoxiaoNeural')
            .setValue(settings.ttsVoice)
            .onChange(async (value) => {
              settings.ttsVoice = value.trim();
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName('TTS Language')
        .setDesc('BCP-47 tag like zh-CN, en-US, ja-JP.')
        .addText((text) =>
          text
            .setPlaceholder('zh-CN')
            .setValue(settings.ttsLang)
            .onChange(async (value) => {
              settings.ttsLang = value.trim();
              await this.plugin.saveSettings();
            }),
        );
    }

    new Setting(containerEl)
      .setName('Auto Play')
      .setDesc('Read assistant replies out loud as soon as they finish streaming.')
      .addToggle((toggle) =>
        toggle
          .setValue(settings.autoPlay)
          .onChange(async (value) => {
            settings.autoPlay = value;
            await this.plugin.saveSettings();
          }),
      );
  }

  private renderPromptList() {
    const { containerEl } = this;
    const settings = this.plugin.settings;

    settings.prompts.forEach((preset, index) => {
      const isActive = preset.id === settings.activePromptId;
      const setting = new Setting(containerEl)
        .setName(preset.name || `(未命名 #${index + 1})`)
        .setDesc(
          isActive
            ? '当前正在使用'
            : `单知识点: ${(preset.contentSingle || preset.content || '').slice(0, 25)}… | 多知识点: ${(preset.contentMulti || preset.content || '').slice(0, 25)}…`,
        );

      setting.addExtraButton((btn) =>
        btn
          .setIcon(isActive ? 'check-circle' : 'circle')
          .setTooltip(isActive ? '当前 prompt' : '设为当前 prompt')
          .onClick(async () => {
            settings.activePromptId = preset.id;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

      setting.addExtraButton((btn) =>
        btn
          .setIcon('pencil')
          .setTooltip('编辑')
          .onClick(() => {
            new PromptEditModal(
              this.app,
              preset,
              async (next) => {
                Object.assign(preset, next);
                await this.plugin.saveSettings();
                this.display();
              },
            ).open();
          }),
      );

      setting.addExtraButton((btn) =>
        btn
          .setIcon('copy')
          .setTooltip('复制为新 prompt')
          .onClick(async () => {
            const dup: PromptPreset = {
              id: makePromptId(),
              name: `${preset.name} (副本)`,
              contentSingle: preset.contentSingle || '',
              contentMulti: preset.contentMulti || '',
              content: preset.content,
            };
            settings.prompts.push(dup);
            await this.plugin.saveSettings();
            this.display();
          }),
      );

      setting.addExtraButton((btn) =>
        btn
          .setIcon('trash-2')
          .setTooltip('删除')
          .onClick(async () => {
            if (settings.prompts.length <= 1) {
              return;
            }
            settings.prompts.splice(index, 1);
            if (settings.activePromptId === preset.id) {
              settings.activePromptId = settings.prompts[0].id;
            }
            await this.plugin.saveSettings();
            this.display();
          }),
      );
    });
  }
}

class PromptEditModal extends Modal {
  private nameInput!: HTMLInputElement;
  private contentSingleInput!: HTMLTextAreaElement;
  private contentMultiInput!: HTMLTextAreaElement;
  private saveBtn!: ButtonComponent;

  constructor(
    app: App,
    private preset: PromptPreset,
    private onSave: (next: { name: string; contentSingle: string; contentMulti: string; content: string }) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('llm-tts-prompt-modal');
    this.titleEl.setText('编辑 prompt（双版本自适应）');

    new Setting(contentEl)
      .setName('名称')
      .setDesc('在 chatbox 面板顶部下拉菜单中显示的预设名称。')
      .addText((text) => {
        this.nameInput = text.inputEl;
        text.setValue(this.preset.name).onChange(() => this.validate());
      });

    // 1. 单节点 Prompt
    const singleSetting = new Setting(contentEl)
      .setName('单节点 Prompt')
      .setDesc('当前仅定位在单个知识点大纲时发送给大模型的提示词。');
    singleSetting.controlEl.empty();
    this.contentSingleInput = singleSetting.controlEl.createEl('textarea', {
      cls: 'llm-tts-prompt-modal__content-single',
    });
    this.contentSingleInput.value = this.preset.contentSingle || this.preset.content || '';
    this.contentSingleInput.rows = 8;
    this.contentSingleInput.cols = 60;
    this.contentSingleInput.addEventListener('input', () => this.validate());

    // 2. 多节点 Prompt
    const multiSetting = new Setting(contentEl)
      .setName('多节点 Prompt')
      .setDesc('当前定位在整节或全章多个知识点时发送给大模型的提示词。');
    multiSetting.controlEl.empty();
    this.contentMultiInput = multiSetting.controlEl.createEl('textarea', {
      cls: 'llm-tts-prompt-modal__content-multi',
    });
    this.contentMultiInput.value = this.preset.contentMulti || this.preset.content || '';
    this.contentMultiInput.rows = 8;
    this.contentMultiInput.cols = 60;
    this.contentMultiInput.addEventListener('input', () => this.validate());

    const footer = contentEl.createDiv({ cls: 'llm-tts-prompt-modal__footer' });
    new ButtonComponent(footer)
      .setButtonText('取消')
      .onClick(() => this.close());
    new ButtonComponent(footer)
      .setButtonText('保存')
      .setCta()
      .onClick(async () => {
        await this.onSave({
          name: this.nameInput.value.trim() || '未命名 prompt',
          contentSingle: this.contentSingleInput.value,
          contentMulti: this.contentMultiInput.value,
          content: this.contentSingleInput.value,
        });
        this.close();
      });
    this.saveBtn = footer.querySelector('button.mod-cta') as unknown as ButtonComponent;
    this.validate();
  }

  private validate() {
    const ok =
      this.nameInput.value.trim().length > 0 &&
      this.contentSingleInput.value.trim().length > 0 &&
      this.contentMultiInput.value.trim().length > 0;
    const btnEl = this.contentEl.querySelector('button.mod-cta') as HTMLButtonElement | null;
    if (btnEl) btnEl.disabled = !ok;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
