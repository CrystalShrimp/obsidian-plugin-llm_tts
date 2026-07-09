import {
  Component,
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  TFile,
  WorkspaceLeaf,
} from 'obsidian';

import AICallPlugin from '../main';
import { mountChatbox } from './chatbox';
import type {
  ChatboxController,
  ChatboxHeadingOption,
  ChatboxMessage,
  ChatboxProps,
} from './chatbox';
import type { ContextMode, MessageContext } from '../types';

export const CALL_VIEW_TYPE = 'llm-tts-call-view';

const MAX_CONTEXT_CHARS = 24000;

interface ResolvedHeading {
  index: number;
  level: number;
  text: string;
  startLine: number;
}

export class CallView extends ItemView {
  private rootEl?: HTMLDivElement;
  private chatbox?: ChatboxController;
  private unsub?: () => void;
  private renderComponent?: Component;

  private activeFile: TFile | null = null;
  private headings: ResolvedHeading[] = [];

  /** Selected heading VALUE (index into this.headings). */
  private selectedH3Value: number | undefined;
  private selectedH2Value: number | undefined;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: AICallPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return CALL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'CPA 知识点讲解';
  }

  getIcon(): string {
    return 'graduation-cap';
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('llm-tts-view');

    this.rootEl = this.contentEl.createDiv({ cls: 'llm-tts-view__root' });

    const component = new Component();
    this.addChild(component);
    component.load();
    this.renderComponent = component;

    this.remount();

    this.unsub = this.plugin.conversation.subscribe(() => this.sync());
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => this.onFileOpen(file)),
    );
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => this.refreshActiveState()),
    );
    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        if (file.path === this.activeFile?.path) {
          void this.refreshHeadings();
        }
      }),
    );

    this.activeFile = this.app.workspace.getActiveFile();
    void this.refreshHeadings();
  }

  async onClose(): Promise<void> {
    this.unsub?.();
    this.unsub = undefined;

    this.chatbox?.destroy();
    this.chatbox = undefined;
    this.renderComponent = undefined;

    this.contentEl.empty();
  }

  private onFileOpen(file: TFile | null) {
    this.activeFile = file;
    void this.refreshHeadings();
  }

  private refreshActiveState() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file && view.file !== this.activeFile) {
      this.activeFile = view.file;
      void this.refreshHeadings();
      return;
    }
    this.sync();
  }

  /**
   * Re-read headings for the active file and reset the H3/H2 selection to
   * follow the editor cursor.
   */
  private async refreshHeadings() {
    this.headings = this.activeFile
      ? this.parseHeadings(await this.getFileContent())
      : [];
    this.selectedH3Value = this.followCursorToHeading(3);
    this.selectedH2Value = this.followCursorToHeading(2);
    this.sync();
  }

  /**
   * Parse ATX headings from raw markdown text. Skips code blocks. Strips
   * Obsidian wikilink brackets from the displayed text.
   *
   * We do NOT use metadataCache because its handling of `## [[xxx]]` headings
   * is inconsistent across versions.
   */
  private parseHeadings(raw: string): ResolvedHeading[] {
    const lines = raw.split('\n');
    const result: ResolvedHeading[] = [];
    let inFence = false;
    let fenceMarker = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1][0];
        const len = fenceMatch[1].length;
        if (!inFence) {
          inFence = true;
          fenceMarker = marker;
        } else if (marker === fenceMarker) {
          inFence = false;
          fenceMarker = '';
        }
        continue;
      }

      if (inFence) continue;

      const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
      if (!m) continue;

      const level = m[1].length;
      const rawText = m[2];
      const text = rawText.replace(/^\[\[|\]\]$/g, '').replace(/^\[\[|\]\]$/g, '').trim();

      result.push({
        index: result.length,
        level,
        text,
        startLine: i,
      });
    }

    return result;
  }

  /**
   * Find the heading value (index into this.headings) of the given level
   * that contains the current editor cursor. Returns undefined if there is
   * no heading of that level covering the cursor.
   */
  private followCursorToHeading(level: number): number | undefined {
    if (this.headings.length === 0) return undefined;
    const view = this.findMarkdownViewForActiveFile();
    const cursorLine = view?.editor?.getCursor?.('from')?.line ?? 0;

    let candidate: number | undefined;
    for (const h of this.headings) {
      if (h.level > level) continue;
      if (h.startLine > cursorLine) break;
      candidate = h.index;
    }
    if (candidate === undefined) return undefined;

    if (level === 3) {
      const headCandidate = this.headings[candidate];
      if (headCandidate.level === 3) return candidate;
      for (let i = candidate + 1; i < this.headings.length; i++) {
        if (this.headings[i].level > 3) continue;
        if (this.headings[i].level === 3) return i;
        break;
      }
      return undefined;
    }

    const headCandidate = this.headings[candidate];
    return headCandidate.level === 2 ? candidate : undefined;
  }

  /**
   * Find the MarkdownView showing this.activeFile across all workspace leaves.
   * `getActiveViewOfType(MarkdownView)` returns null when the chatbox itself
   * is the active leaf, so we have to scan.
   */
  private findMarkdownViewForActiveFile(): MarkdownView | null {
    if (!this.activeFile) return null;
    const target = this.activeFile.path;
    let result: MarkdownView | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (result) return;
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === target) {
        result = view;
      }
    });
    return result;
  }

  /**
   * Get the current text of the active file. Prefer the editor buffer so
   * unsaved edits are reflected; fall back to vault.cachedRead otherwise.
   */
  private async getFileContent(): Promise<string> {
    if (!this.activeFile) return '';
    const view = this.findMarkdownViewForActiveFile();
    if (view?.editor?.getValue) {
      try {
        const text = view.editor.getValue();
        if (text) return text;
      } catch {
        /* fall through */
      }
    }
    return this.app.vault.cachedRead(this.activeFile);
  }

  private getH3Options(): ChatboxHeadingOption[] {
    return this.headings
      .filter((h) => h.level === 3)
      .map((h) => ({
        value: h.index,
        label: h.text,
        breadcrumb: this.buildBreadcrumb(h.index),
      }));
  }

  private getH2Options(): ChatboxHeadingOption[] {
    return this.headings
      .filter((h) => h.level === 2)
      .map((h) => ({
        value: h.index,
        label: h.text,
        breadcrumb: this.buildBreadcrumb(h.index),
      }));
  }

  /** Build a "chapter › section" path for the given heading. */
  private buildBreadcrumb(idx: number): string {
    const target = this.headings[idx];
    if (!target) return '';
    const chain: string[] = [];
    let currentLevel = target.level;
    for (let i = idx; i >= 0; i--) {
      const h = this.headings[i];
      if (i === idx) {
        chain.unshift(h.text);
        continue;
      }
      if (h.level < currentLevel) {
        chain.unshift(h.text);
        currentLevel = h.level;
        if (currentLevel === 1) break;
      }
    }
    return chain.slice(0, -1).join(' › ');
  }

  private remount() {
    if (!this.rootEl) return;
    this.chatbox?.destroy();
    this.chatbox = mountChatbox(this.rootEl, this.buildProps());
  }

  private sync() {
    this.chatbox?.update(this.buildProps());
  }

  private buildProps(): ChatboxProps {
    const state = this.plugin.conversation.getState();

    return {
      title: 'CPA 知识点讲解',
      status: state.status,
      error: state.error,
      messages: state.messages.map((m): ChatboxMessage => ({
        id: m.id,
        role: m.role,
        content: m.text,
        createdAt: m.createdAt,
        streaming: m.streaming,
        context: m.context
          ? {
              scope: m.context.scope,
              path: m.context.path,
              headingPath: m.context.headingPath,
            }
          : undefined,
        step1Text: m.step1Text,
      })),
      isSending: state.status === 'thinking',
      isSpeaking: state.status === 'speaking',

      activeFile: this.activeFile
        ? {
            path: this.activeFile.path,
            basename: this.activeFile.basename,
            size: this.activeFile.stat?.size ?? 0,
          }
        : null,
      contextMode: state.contextMode,
      h3Options: this.getH3Options(),
      h2Options: this.getH2Options(),
      selectedH3: this.selectedH3Value,
      selectedH2: this.selectedH2Value,
      promptOptions: this.plugin.settings.prompts.map((p) => ({
        id: p.id,
        name: p.name,
      })),
      activePromptId: this.plugin.settings.activePromptId,

      renderMarkdown: (el, markdown) => this.renderMarkdown(el, markdown),
      onSendMessage: async (text, options) => {
        await this.handleSend(text, options);
      },
      onStop: () => {
        this.plugin.conversation.stop();
      },
      onReplayLast: async () => {
        await this.plugin.conversation.replayLastAssistantMessage();
      },
      onClear: () => {
        this.plugin.conversation.clear();
      },
      onCopyMessage: async (message) => {
        await navigator.clipboard.writeText(message.content);
        new Notice('已复制');
      },
      onRegenerate: async () => {
        await this.plugin.conversation.regenerate();
      },
      onChangeContextMode: (mode) => {
        this.plugin.conversation.setContextMode(mode);
      },
      onSelectH3: (value) => {
        this.selectedH3Value = value;
        this.sync();
      },
      onSelectH2: (value) => {
        this.selectedH2Value = value;
        this.sync();
      },
      onSelectPrompt: (promptId) => {
        this.plugin.conversation.setActivePrompt(promptId);
      },
      onRefreshActiveFile: () => {
        void this.refreshHeadings();
      },
    };
  }

  private async handleSend(text: string, options?: { isFollowUp: boolean }) {
    try {
      const isFollowUp = options?.isFollowUp ?? false;
      let context: MessageContext | undefined;
      if (!isFollowUp) {
        const mode = this.plugin.conversation.getState().contextMode;
        context = await this.buildContextForMode(mode);
      }
      await this.plugin.conversation.send(text, { context });
    } catch (err) {
      new Notice(`讲解发起失败: ${err instanceof Error ? err.message : String(err)}`);
      console.error('[llm-tts] handleSend error', err);
    }
  }

  private async buildContextForMode(
    mode: ContextMode,
  ): Promise<MessageContext | undefined> {
    if (!this.activeFile || this.activeFile.extension !== 'md') {
      new Notice('当前没有打开的 .md 笔记');
      return undefined;
    }
    if (this.headings.length === 0) {
      new Notice('当前笔记没有解析到 # / ## / ### 标题');
      return undefined;
    }

    let content: string;
    let headingPath: string[];
    let scope: ContextMode = mode;

    if (mode === 'h3-single') {
      const value = this.selectedH3Value ?? this.firstOfLevel(3);
      if (value === undefined) {
        new Notice('没有可用的 ### 知识点');
        return undefined;
      }
      content = await this.sliceHeadingBlock(value);
      headingPath = this.pathOf(value);
    } else if (mode === 'h2-block') {
      const value = this.selectedH2Value ?? this.firstOfLevel(2);
      if (value === undefined) {
        new Notice('没有可用的 ## 节');
        return undefined;
      }
      content = await this.sliceHeadingBlock(value);
      headingPath = this.pathOf(value);
    } else {
      // all-h3
      const h3Values = this.headings
        .filter((h) => h.level === 3)
        .map((h) => h.index);
      const blocks: string[] = [];
      for (const v of h3Values) {
        const b = await this.sliceHeadingBlock(v);
        if (b) blocks.push(b);
      }
      content = blocks.join('\n\n');
      headingPath = this.pathOf(this.headings[0]?.index ?? 0);
    }

    if (!content.trim()) {
      new Notice(
        '选中的标题块没有正文（可能只有标题本身）。试试切换"全章知识点"或换一个标题。',
        6000,
      );
      return undefined;
    }

    if (content.length > MAX_CONTEXT_CHARS) {
      content = content.slice(0, MAX_CONTEXT_CHARS);
      new Notice(`内容较长，已截断到 ${MAX_CONTEXT_CHARS} 字符`, 4000);
    }

    return {
      scope,
      path: this.activeFile.path,
      headingPath,
      content,
    };
  }

  private firstOfLevel(level: number): number | undefined {
    return this.headings.find((h) => h.level === level)?.index;
  }

  /**
   * Slice from a heading's start line up to (but not including) the next
   * heading at the same or higher level.
   */
  private async sliceHeadingBlock(idx: number): Promise<string> {
    const head = this.headings[idx];
    if (!head) return '';

    const raw = await this.getFileContent();
    const lines = raw.split('\n');

    let endLine = lines.length - 1;
    for (let i = idx + 1; i < this.headings.length; i++) {
      if (this.headings[i].level <= head.level) {
        endLine = this.headings[i].startLine - 1;
        break;
      }
    }
    if (endLine < head.startLine) endLine = head.startLine;
    return lines.slice(head.startLine, endLine + 1).join('\n').trim();
  }

  /** Heading chain from root down to (and including) this heading. */
  private pathOf(idx: number): string[] {
    const target = this.headings[idx];
    if (!target) return [];
    const chain: string[] = [target.text];
    let currentLevel = target.level;
    for (let i = idx - 1; i >= 0; i--) {
      const h = this.headings[i];
      if (h.level < currentLevel) {
        chain.unshift(h.text);
        currentLevel = h.level;
        if (currentLevel === 1) break;
      }
    }
    return chain;
  }

  private async renderMarkdown(el: HTMLElement, markdown: string): Promise<void> {
    if (!this.renderComponent || !markdown) {
      el.setText(markdown);
      return;
    }

    const tmp = el.ownerDocument.createElement('div');
    try {
      await MarkdownRenderer.render(
        this.app,
        markdown,
        tmp,
        this.app.workspace.getActiveFile()?.path ?? '',
        this.renderComponent,
      );
      el.empty();
      el.replaceChildren(...Array.from(tmp.childNodes));
      if (!el.hasChildNodes()) el.setText(markdown);
    } catch {
      el.setText(markdown);
    }
  }
}
