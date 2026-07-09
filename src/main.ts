import { Notice, Plugin, WorkspaceLeaf } from 'obsidian';

import { AICallSettings, CallMessage, DEFAULT_SETTINGS } from './types';
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

  async onload(): Promise<void> {
    await this.loadSettings();
    console.log('[llm-tts] plugin loaded, build 2026-07-09-v4');

    this.audioPlayer = new AudioPlayer();
    this.llmClient = new LLMClient(() => this.settings);
    this.ttsClient = new TTSClient(() => this.settings);

    let initialMessages: CallMessage[] = [];
    try {
      const dir = this.manifest.dir || '.obsidian/plugins/llm-tts';
      const historyPath = `${dir}/history.json`;
      if (await this.app.vault.adapter.exists(historyPath)) {
        const content = await this.app.vault.adapter.read(historyPath);
        initialMessages = JSON.parse(content);
      }
    } catch (e) {
      console.warn('[llm-tts] Failed to load chat history:', e);
    }

    this.conversation = new ConversationController({
      getSettings: () => this.settings,
      saveSettings: () => this.saveSettings(),
      llm: this.llmClient,
      tts: this.ttsClient,
      audio: this.audioPlayer,
      initialMessages,
      persistMessages: async (messages) => {
        try {
          const dir = this.manifest.dir || '.obsidian/plugins/llm-tts';
          const historyPath = `${dir}/history.json`;
          if (!(await this.app.vault.adapter.exists(dir))) {
            await this.app.vault.adapter.mkdir(dir);
          }
          await this.app.vault.adapter.write(historyPath, JSON.stringify(messages, null, 2));
        } catch (e) {
          console.warn('[llm-tts] Failed to save chat history:', e);
        }
      },
    });

    this.registerView(
      CALL_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new CallView(leaf, this),
    );

    this.addRibbonIcon('message-circle', 'Open LLM Call', async () => {
      await this.activateView();
    });

    this.addCommand({
      id: 'open-llm-call',
      name: 'Open LLM Call panel',
      callback: async () => {
        await this.activateView();
      },
    });

    this.addCommand({
      id: 'stop-llm-call',
      name: 'Stop LLM Call (abort stream + audio)',
      callback: () => {
        this.conversation.stop();
        new Notice('LLM Call stopped');
      },
    });

    this.addCommand({
      id: 'clear-llm-call',
      name: 'Clear LLM Call conversation',
      callback: () => {
        this.conversation.clear();
        new Notice('LLM Call conversation cleared');
      },
    });

    this.addSettingTab(new AICallSettingTab(this.app, this));
  }

  onunload(): void {
    this.audioPlayer.destroy();
    this.app.workspace.detachLeavesOfType(CALL_VIEW_TYPE);
  }

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(CALL_VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice('Cannot open LLM Call panel');
      return;
    }
    await leaf.setViewState({ type: CALL_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    
    let keys: Record<string, string> = {};
    let hasKeysFile = false;
    const dir = this.manifest.dir || '.obsidian/plugins/llm-tts';
    const keysPath = `${dir}/keys.json`;
    
    try {
      if (await this.app.vault.adapter.exists(keysPath)) {
        const content = await this.app.vault.adapter.read(keysPath);
        keys = JSON.parse(content);
        hasKeysFile = true;
      }
    } catch (e) {
      console.warn('[llm-tts] Failed to load keys.json:', e);
    }

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data,
      ...keys,
    };

    // Auto-migrate keys from data.json to keys.json on first run
    if (!hasKeysFile && (data?.llmApiKey || data?.volcanoApiKey || data?.ttsApiKey)) {
      console.log('[llm-tts] Migrating keys from data.json to keys.json...');
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    const { llmApiKey, volcanoApiKey, ttsApiKey, ...restSettings } = this.settings;
    
    // Save settings (excluding keys) to data.json
    await this.saveData(restSettings);
    
    // Save keys to keys.json
    try {
      const dir = this.manifest.dir || '.obsidian/plugins/llm-tts';
      const keysPath = `${dir}/keys.json`;
      if (!(await this.app.vault.adapter.exists(dir))) {
        await this.app.vault.adapter.mkdir(dir);
      }
      const keysContent = {
        llmApiKey: llmApiKey ?? '',
        volcanoApiKey: volcanoApiKey ?? '',
        ttsApiKey: ttsApiKey ?? '',
      };
      await this.app.vault.adapter.write(keysPath, JSON.stringify(keysContent, null, 2));
    } catch (e) {
      console.error('[llm-tts] Failed to save keys.json:', e);
    }
  }
}
