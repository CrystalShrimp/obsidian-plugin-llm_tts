import { Notice, setIcon } from 'obsidian';
import {
  ChatboxActiveFile,
  ChatboxController,
  ChatboxHeadingOption,
  ChatboxMessage,
  ChatboxProps,
} from './types';
import type { ContextMode } from '../../types';

interface RenderedMessage {
  el: HTMLElement;
  bodyEl: HTMLElement;
  bubbleEl: HTMLElement;
  step1El: HTMLElement;
  actionsEl: HTMLElement;
  id: string;
  role: ChatboxMessage['role'];
  lastRenderedText: string;
  lastStreaming: boolean;
  lastContextKey?: string;
  markdownScheduled: boolean;
  lastStep1Text?: string;
  step1MarkdownScheduled?: boolean;
}

const STREAMING_CURSOR = '▋';

const ROLE_LABEL: Record<ChatboxMessage['role'], string> = {
  user: '我',
  assistant: '老师',
  system: '系统',
};

const ROLE_ICON: Record<ChatboxMessage['role'], string> = {
  user: 'user',
  assistant: 'graduation-cap',
  system: 'info',
};

const MODE_LABEL: Record<ContextMode, string> = {
  'h3-single': '单个知识点',
  'h2-block': '整节',
  'all-h3': '全章知识点',
};

const MODE_DESC: Record<ContextMode, string> = {
  'h3-single': '把光标所在的某个 ### 知识点作为上下文',
  'h2-block': '把光标所在的整个 ## 节（含下属所有知识点）作为上下文',
  'all-h3': '把本章所有 ### 知识点拼起来作为上下文',
};

// Zero-width chars that trim() won't strip but render invisibly. Built from
// code points so the source file itself never contains zero-width chars
// (which would be invisible and easy to break during editing).
const ZERO_WIDTH_RE = new RegExp(
  '[' + '\\s' + String.fromCodePoint(0x200b, 0x200c, 0x200d, 0xfeff) + ']',
  'g',
);

export function mountChatbox(
  root: HTMLElement,
  initialProps: ChatboxProps,
): ChatboxController {
  let props = initialProps;

  root.empty();
  root.addClass('llm-tts-chatbox');

  // Header
  const headerEl = root.createDiv({ cls: 'llm-tts-chatbox__header' });
  const titleEl = headerEl.createEl('span', { cls: 'llm-tts-chatbox__title' });
  const promptSelect = headerEl.createEl('select', {
    cls: 'llm-tts-chatbox__prompt-select',
    attr: { 'aria-label': '切换 prompt' },
  });
  promptSelect.addEventListener('change', () => {
    const id = promptSelect.value;
    if (id) props.onSelectPrompt(id);
  });
  const statusEl = headerEl.createDiv({ cls: 'llm-tts-chatbox__status' });

  // Body
  const scrollEl = root.createDiv({ cls: 'llm-tts-chatbox__scroll' });
  const listEl = scrollEl.createDiv({ cls: 'llm-tts-chatbox__list' });
  const emptyEl = listEl.createDiv({ cls: 'llm-tts-chatbox__empty' });

  // Error
  const errorEl = root.createDiv({ cls: 'llm-tts-chatbox__error' });
  errorEl.hide();

  // Collapsed Panel State
  let isCollapsed = false;

  // Context header
  const contextHeader = root.createDiv({ cls: 'llm-tts-chatbox__ctx' });
  const ctxFileRow = contextHeader.createDiv({ cls: 'llm-tts-chatbox__ctx-info' });
  const ctxModes = contextHeader.createDiv({ cls: 'llm-tts-chatbox__ctx-modes' });
  const ctxSelectorRow = contextHeader.createDiv({
    cls: 'llm-tts-chatbox__ctx-selector',
  });
  const ctxHint = contextHeader.createDiv({ cls: 'llm-tts-chatbox__ctx-hint' });

  // Composer
  const composerEl = root.createDiv({ cls: 'llm-tts-chatbox__composer' });
  const textarea = composerEl.createEl('textarea', {
    cls: 'llm-tts-chatbox__textarea',
  });
  textarea.rows = 2;
  textarea.placeholder =
    initialProps.placeholder ??
    '问一个 CPA 知识点，Enter 发送，Shift+Enter 换行';
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
  textarea.addEventListener('focus', () => {
    props.onRefreshActiveFile?.();
  });

  const buttonRow = composerEl.createDiv({ cls: 'llm-tts-chatbox__buttons' });
  const sendBtn = buttonRow.createEl('button', {
    cls: 'llm-tts-chatbox__btn llm-tts-chatbox__btn--primary',
  });
  sendBtn.createSpan({ text: '讲解并朗读' });
  sendBtn.addEventListener('click', () => submit());

  const stopBtn = buttonRow.createEl('button', {
    cls: 'llm-tts-chatbox__btn',
  });
  stopBtn.createSpan({ text: '停止' });
  stopBtn.addEventListener('click', () => props.onStop());

  const regenerateBtn = buttonRow.createEl('button', {
    cls: 'llm-tts-chatbox__btn',
  });
  regenerateBtn.createSpan({ text: '重新生成' });
  regenerateBtn.addEventListener('click', () => props.onRegenerate());

  const replayBtn = buttonRow.createEl('button', {
    cls: 'llm-tts-chatbox__btn',
    attr: { 'aria-label': '重新朗读上一条老师讲解' },
  });
  replayBtn.createSpan({ text: '重听' });
  replayBtn.addEventListener('click', () => props.onReplayLast());

  const clearBtn = buttonRow.createEl('button', {
    cls: 'llm-tts-chatbox__btn llm-tts-chatbox__btn--ghost',
  });
  clearBtn.createSpan({ text: '清空' });
  clearBtn.addEventListener('click', () => {
    if (listEl.querySelectorAll('.llm-tts-chatbox__msg').length === 0) return;
    props.onClear();
  });

  const rendered = new Map<string, RenderedMessage>();
  let autoScroll = true;

  scrollEl.addEventListener('scroll', () => {
    const distanceFromBottom =
      scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    autoScroll = distanceFromBottom < 80;
  });

  function submit() {
    if (props.isSending || props.status === 'streaming' || props.status === 'thinking') {
      return;
    }
    const typed = textarea.value.trim();
    const hasContext = Boolean(props.activeFile) && (
      props.contextMode === 'h2-block' ? props.h2Options.length > 0 : props.h3Options.length > 0
    );
    if (!typed && !hasContext) {
      new Notice(
        '打开一份带 ### 知识点的笔记，或输入问题后再发送',
        3000,
      );
      return;
    }
    const finalText =
      typed ||
      '结合上面给的教材原文，用大白话给我讲讲这个知识点。';
    textarea.value = '';
    void props.onSendMessage(finalText, { isFollowUp: !!typed });
  }

  function render() {
    root.toggleClass('is-collapsed', isCollapsed);
    titleEl.setText(props.title ?? 'CPA 知识点讲解');
    renderPromptSelect();
    renderStatus();
    renderError();
    renderMessages();
    renderContextHeader();
    renderButtons();
    maybeScroll();
  }

  function renderPromptSelect() {
    const current = promptSelect.value;
    promptSelect.empty();
    if (props.promptOptions.length === 0) {
      const opt = promptSelect.createEl('option', {
        text: '（未配置 prompt）',
        value: '',
      });
      opt.disabled = true;
      promptSelect.disabled = true;
      return;
    }
    promptSelect.disabled = false;
    props.promptOptions.forEach((p) => {
      const opt = promptSelect.createEl('option', {
        value: p.id,
        text: p.name,
      });
      if (props.activePromptId === p.id) opt.selected = true;
    });
    if (current && props.promptOptions.some((p) => p.id === current)) {
      promptSelect.value = current;
    }
  }

  function renderStatus() {
    statusEl.empty();
    const map: Record<string, string> = {
      idle: '',
      thinking: '准备讲解…',
      streaming: '讲解中…',
      speaking: '朗读中…',
      paused: '已暂停',
      error: '出错',
    };
    statusEl.setText(map[props.status] ?? '');
    statusEl.className = `llm-tts-chatbox__status is-${props.status}`;
  }

  function renderError() {
    // Strip zero-width chars + standard whitespace before the visibility
    // check. Some LLM gateways return JSON error bodies that start with a
    // BOM (U+FEFF); SpeechSynthesis occasionally emits U+200B in event.error.
    // Without this, renderError shows an empty-looking orange bar.
    const raw = props.error ?? '';
    const visible = raw.replace(ZERO_WIDTH_RE, '');
    if (!visible) {
      errorEl.hide();
      errorEl.empty();
      return;
    }
    errorEl.empty();
    const contentWrap = errorEl.createDiv({ cls: 'llm-tts-chatbox__error-content' });
    const iconSpan = contentWrap.createEl('span', { cls: 'llm-tts-chatbox__error-icon' });
    setIcon(iconSpan, 'alert-circle');

    const span = contentWrap.createEl('span', { cls: 'llm-tts-chatbox__error-text' });
    span.textContent = '发生错误，详情请按 Ctrl+Shift+I 查看控制台';

    const dismiss = errorEl.createEl('button', {
      cls: 'llm-tts-chatbox__btn llm-tts-chatbox__btn--ghost llm-tts-chatbox__error-close',
      text: '关闭',
    });
    dismiss.addEventListener('click', () => props.onStop());
    errorEl.show();
  }

  function renderMessages() {
    const incoming = props.messages;
    const incomingIds = new Set(incoming.map((m) => m.id));

    for (const id of Array.from(rendered.keys())) {
      if (!incomingIds.has(id)) {
        rendered.get(id)?.el.remove();
        rendered.delete(id);
      }
    }

    let previous: HTMLElement | null = null;
    for (const message of incoming) {
      let entry = rendered.get(message.id);
      if (!entry) {
        const created = createMessageElement(message);
        entry = {
          el: created.el,
          bodyEl: created.bodyEl,
          bubbleEl: created.bubbleEl,
          step1El: created.step1El,
          actionsEl: created.actionsEl,
          id: message.id,
          role: message.role,
          lastRenderedText: '',
          lastStreaming: false,
          markdownScheduled: false,
          lastStep1Text: '',
          step1MarkdownScheduled: false,
        };
        rendered.set(message.id, entry);
      } else if (entry.role !== message.role) {
        entry.el.remove();
        rendered.delete(message.id);
        continue;
      }

      const expectedPrev = previous?.dataset.id ?? '';
      if (entry.el.dataset.prev !== expectedPrev) {
        entry.el.dataset.prev = expectedPrev;
        if (previous) previous.after(entry.el);
        else listEl.prepend(entry.el);
      }

      updateMessageContent(entry, message);
      updateMessageActions(entry, message);
      previous = entry.el;
    }

    const hasMessages = rendered.size > 0;
    emptyEl.toggleClass('is-hidden', hasMessages);
    emptyEl.setText(
      '打开任意 CPA 笔记，问一个不懂的知识点，老师会用大白话讲给你听、并自动朗读。\n顶部可以选择“单个知识点 / 整节 / 全章知识点”作为讲解的参考范围。',
    );
  }

  function createMessageElement(message: ChatboxMessage): {
    el: HTMLElement;
    bodyEl: HTMLElement;
    bubbleEl: HTMLElement;
    step1El: HTMLElement;
    actionsEl: HTMLElement;
  } {
    const el = listEl.createDiv({
      cls: `llm-tts-chatbox__msg is-${message.role}`,
    });
    el.dataset.id = message.id;

    const avatarEl = el.createDiv({ cls: 'llm-tts-chatbox__avatar' });
    const iconWrap = avatarEl.createEl('span');
    setIcon(iconWrap, ROLE_ICON[message.role]);

    const bodyEl = el.createDiv({ cls: 'llm-tts-chatbox__body' });
    const metaEl = bodyEl.createDiv({ cls: 'llm-tts-chatbox__meta' });
    metaEl.createEl('span', {
      cls: 'llm-tts-chatbox__role',
      text: ROLE_LABEL[message.role],
    });
    metaEl.createEl('span', {
      cls: 'llm-tts-chatbox__time',
      text: formatTime(message.createdAt),
    });

    const contextPlaceholder = bodyEl.createDiv({
      cls: 'llm-tts-chatbox__msg-ctx is-hidden',
    });

    const bubbleEl = bodyEl.createDiv({ cls: 'llm-tts-chatbox__bubble' });
    const step1El = bodyEl.createDiv({
      cls: 'llm-tts-chatbox__step1-container is-hidden',
    });
    const actionsEl = bodyEl.createDiv({
      cls: 'llm-tts-chatbox__actions is-hidden',
    });

    (el as HTMLElement & { _ctxHolder?: HTMLElement })._ctxHolder =
      contextPlaceholder;

    return { el, bodyEl, bubbleEl, step1El, actionsEl };
  }

  function updateMessageContent(
    entry: RenderedMessage,
    message: ChatboxMessage,
  ) {
    const ctxKey = message.context
      ? `${message.context.scope}::${message.context.path}::${message.context.headingPath.join('/')}`
      : '';
    if (ctxKey !== entry.lastContextKey) {
      entry.lastContextKey = ctxKey;
      const holder = (
        entry.el as HTMLElement & { _ctxHolder?: HTMLElement }
      )._ctxHolder;
      if (holder) {
        holder.empty();
        if (message.context) {
          const scopeLabel =
            message.context.scope === 'h3-single'
              ? '知识点'
              : message.context.scope === 'h2-block'
                ? '整节'
                : '全章';
          const icon = holder.createEl('span', {
            cls: 'llm-tts-chatbox__msg-ctx-icon',
          });
          setIcon(icon, 'book-open');
          holder.createEl('span', {
            cls: 'llm-tts-chatbox__msg-ctx-label',
            text: `${scopeLabel} › ${message.context.headingPath.join(' › ')}`,
          });
          holder.removeClass('is-hidden');
        } else {
          holder.addClass('is-hidden');
        }
      }
    }

    const textChanged = entry.lastRenderedText !== message.content;
    const streamingChanged = entry.lastStreaming !== Boolean(message.streaming);
    if (!textChanged && !streamingChanged) return;

    entry.lastRenderedText = message.content;
    entry.lastStreaming = Boolean(message.streaming);

    if (message.streaming) {
      entry.bubbleEl.empty();
      entry.bubbleEl.setText(message.content || '');
      if (message.content) {
        entry.bubbleEl.createEl('span', {
          cls: 'llm-tts-chatbox__cursor',
          text: STREAMING_CURSOR,
        });
      }
      entry.markdownScheduled = false;
      return;
    }

    if (message.role === 'assistant' && props.renderMarkdown) {
      if (entry.markdownScheduled) return;
      entry.markdownScheduled = true;
      entry.bubbleEl.empty();
      entry.bubbleEl.setText(message.content || '');
      Promise.resolve(props.renderMarkdown(entry.bubbleEl, message.content))
        .catch(() => {
          entry.bubbleEl.empty();
          entry.bubbleEl.setText(message.content);
        })
        .finally(() => {
          entry.markdownScheduled = false;
        });
      return;
    }

    entry.bubbleEl.empty();
    entry.bubbleEl.setText(message.content || '');
  }

  function updateMessageActions(
    entry: RenderedMessage,
    message: ChatboxMessage,
  ) {
    const isLast =
      props.messages[props.messages.length - 1]?.id === message.id;
    const showCopy = Boolean(message.content?.trim());
    const showReplay =
      message.role === 'assistant' && !message.streaming && Boolean(message.content?.trim());
    const showRegenerate =
      message.role === 'assistant' && !message.streaming && isLast && !props.isSending;
    const showStep1Toggle = Boolean(message.step1Text?.trim());

    if (!showCopy && !showReplay && !showRegenerate && !showStep1Toggle) {
      entry.actionsEl.addClass('is-hidden');
      entry.actionsEl.empty();
      return;
    }

    entry.actionsEl.removeClass('is-hidden');
    entry.actionsEl.empty();

    if (showStep1Toggle) {
      const btn = entry.actionsEl.createEl('button', {
        cls: 'llm-tts-chatbox__action-btn llm-tts-chatbox__action-btn--step1',
        attr: { 'aria-label': '显示/隐藏讲义' },
      });
      const icon = btn.createEl('span');
      setIcon(icon, 'file-text');
      btn.addEventListener('click', () => {
        const isHidden = entry.step1El.hasClass('is-hidden');
        if (isHidden) {
          entry.step1El.removeClass('is-hidden');
          if (message.step1Text && entry.lastStep1Text !== message.step1Text) {
            entry.lastStep1Text = message.step1Text;
            if (props.renderMarkdown) {
              entry.step1MarkdownScheduled = true;
              entry.step1El.empty();
              entry.step1El.createDiv({
                cls: 'llm-tts-chatbox__step1-header',
                text: '📖 讲义原文'
              });
              const mdBody = entry.step1El.createDiv({ cls: 'llm-tts-chatbox__step1-body' });
              Promise.resolve(props.renderMarkdown(mdBody, message.step1Text))
                .catch(() => {
                  mdBody.empty();
                  mdBody.setText(message.step1Text || '');
                })
                .finally(() => {
                  entry.step1MarkdownScheduled = false;
                });
            } else {
              entry.step1El.empty();
              entry.step1El.createDiv({
                cls: 'llm-tts-chatbox__step1-header',
                text: '📖 讲义原文'
              });
              const mdBody = entry.step1El.createDiv({ cls: 'llm-tts-chatbox__step1-body' });
              mdBody.setText(message.step1Text || '');
            }
          }
        } else {
          entry.step1El.addClass('is-hidden');
        }
      });
    }

    if (showCopy) {
      const btn = entry.actionsEl.createEl('button', {
        cls: 'llm-tts-chatbox__action-btn',
        attr: { 'aria-label': '复制' },
      });
      const icon = btn.createEl('span');
      setIcon(icon, 'copy');
      btn.addEventListener('click', () => {
        void props.onCopyMessage(message);
      });
    }

    if (showReplay) {
      const btn = entry.actionsEl.createEl('button', {
        cls: 'llm-tts-chatbox__action-btn',
        attr: { 'aria-label': '朗读这条' },
      });
      const icon = btn.createEl('span');
      setIcon(icon, 'volume-2');
      btn.addEventListener('click', () => {
        void props.onReplayLast();
      });
    }

    if (showRegenerate) {
      const btn = entry.actionsEl.createEl('button', {
        cls: 'llm-tts-chatbox__action-btn',
        attr: { 'aria-label': '重新生成' },
      });
      const icon = btn.createEl('span');
      setIcon(icon, 'refresh-cw');
      btn.addEventListener('click', () => {
        void props.onRegenerate();
      });
    }
  }

  function renderContextHeader() {
    renderFileRow();
    renderModeToggle();
    renderHeadingSelector();
    renderHint();
  }

  function renderFileRow() {
    ctxFileRow.empty();
    const file: ChatboxActiveFile | null | undefined = props.activeFile;
    
    if (!file) {
      ctxFileRow.createEl('span', {
        cls: 'llm-tts-chatbox__ctx-empty',
        text: '未打开 CPA 笔记',
      });
    } else {
      const icon = ctxFileRow.createEl('span', { cls: 'llm-tts-chatbox__ctx-icon' });
      setIcon(icon, 'file-text');
      ctxFileRow.createEl('span', {
        cls: 'llm-tts-chatbox__ctx-path',
        text: file.path,
      });
      ctxFileRow.createEl('span', {
        cls: 'llm-tts-chatbox__ctx-size',
        text: formatSize(file.size),
      });

      const refresh = ctxFileRow.createEl('button', {
        cls: 'llm-tts-chatbox__ctx-refresh',
        attr: { 'aria-label': '重新解析标题' },
      });
      const refreshIcon = refresh.createEl('span');
      setIcon(refreshIcon, 'refresh-cw');
      refresh.addEventListener('click', () => props.onRefreshActiveFile?.());
    }

    const collapse = ctxFileRow.createEl('button', {
      cls: 'llm-tts-chatbox__ctx-refresh',
      attr: { 'aria-label': isCollapsed ? '展开面板' : '收起面板' },
    });
    const collapseIcon = collapse.createEl('span');
    setIcon(collapseIcon, isCollapsed ? 'chevron-up' : 'chevron-down');
    collapse.addEventListener('click', (e) => {
      e.preventDefault();
      isCollapsed = !isCollapsed;
      render();
    });
  }

  function renderModeToggle() {
    ctxModes.empty();
    const modes: ContextMode[] = ['h3-single', 'h2-block', 'all-h3'];
    modes.forEach((mode) => {
      const disabled = isModeDisabled(mode);
      const btn = ctxModes.createEl('button', {
        cls: `llm-tts-chatbox__ctx-mode ${
          props.contextMode === mode ? 'is-active' : ''
        } ${disabled ? 'is-disabled' : ''}`,
        text: MODE_LABEL[mode],
        attr: { title: MODE_DESC[mode] },
      });
      btn.disabled = disabled;
      btn.addEventListener('click', () => {
        if (disabled) {
          new Notice(
            MODE_DESC[mode] + '\n（当前笔记不满足该模式所需标题）',
            4000,
          );
          return;
        }
        props.onChangeContextMode(mode);
      });
    });
  }

  function isModeDisabled(mode: ContextMode): boolean {
    if (!props.activeFile) return true;
    if (mode === 'h3-single') return props.h3Options.length === 0;
    if (mode === 'h2-block') return props.h2Options.length === 0;
    if (mode === 'all-h3') return props.h3Options.length === 0;
    return false;
  }

  function renderHeadingSelector() {
    ctxSelectorRow.empty();

    if (props.contextMode === 'all-h3') {
      ctxSelectorRow.createEl('span', {
        cls: 'llm-tts-chatbox__ctx-selector-label',
        text: `本章共 ${props.h3Options.length} 个知识点`,
      });
      return;
    }

    if (props.contextMode === 'h3-single') {
      if (props.h3Options.length === 0) {
        ctxSelectorRow.createEl('span', {
          cls: 'llm-tts-chatbox__ctx-selector-empty',
          text: '当前笔记没有 ### 知识点',
        });
        return;
      }
      ctxSelectorRow.createEl('span', {
        cls: 'llm-tts-chatbox__ctx-selector-label',
        text: '知识点：',
      });
      const select = ctxSelectorRow.createEl('select', {
        cls: 'llm-tts-chatbox__ctx-select',
      });
      populateSelect(select, props.h3Options, props.selectedH3);
      select.addEventListener('change', () => {
        const v = Number(select.value);
        if (!Number.isNaN(v)) props.onSelectH3(v);
      });
      return;
    }

    // h2-block
    if (props.h2Options.length === 0) {
      ctxSelectorRow.createEl('span', {
        cls: 'llm-tts-chatbox__ctx-selector-empty',
        text: '当前笔记没有 ## 节',
      });
      return;
    }
    ctxSelectorRow.createEl('span', {
      cls: 'llm-tts-chatbox__ctx-selector-label',
      text: '节：',
    });
    const select = ctxSelectorRow.createEl('select', {
      cls: 'llm-tts-chatbox__ctx-select',
    });
    populateSelect(select, props.h2Options, props.selectedH2);
    select.addEventListener('change', () => {
      const v = Number(select.value);
      if (!Number.isNaN(v)) props.onSelectH2(v);
    });
  }

  function populateSelect(
    select: HTMLSelectElement,
    options: ChatboxHeadingOption[],
    selected: number | undefined,
  ) {
    options.forEach((opt) => {
      const optEl = select.createEl('option', {
        value: String(opt.value),
        text: opt.breadcrumb ? `${opt.breadcrumb} › ${opt.label}` : opt.label,
      });
      if (selected === opt.value) optEl.selected = true;
    });
  }

  function renderHint() {
    ctxHint.setText(MODE_DESC[props.contextMode]);
  }

  function renderButtons() {
    const busy =
      props.isSending ||
      props.status === 'thinking' ||
      props.status === 'streaming' ||
      props.status === 'speaking';

    const hasContext = Boolean(props.activeFile) && (
      props.contextMode === 'h2-block' ? props.h2Options.length > 0 : props.h3Options.length > 0
    );
    const canSend = !busy && (textarea.value.trim().length > 0 || hasContext);
    sendBtn.disabled = !canSend;
    sendBtn.toggleClass('is-disabled', !canSend);
    stopBtn.toggleClass('is-hidden', !busy);
    const hasAssistant = props.messages.some((m) => m.role === 'assistant');
    regenerateBtn.toggleClass('is-hidden', busy || !hasAssistant);
    replayBtn.toggleClass('is-hidden', props.status === 'speaking' || !hasAssistant);
  }

  textarea.addEventListener('input', () => {
    const busy =
      props.isSending ||
      props.status === 'thinking' ||
      props.status === 'streaming' ||
      props.status === 'speaking';
    const hasContext = Boolean(props.activeFile) && (
      props.contextMode === 'h2-block' ? props.h2Options.length > 0 : props.h3Options.length > 0
    );
    const canSend = !busy && (textarea.value.trim().length > 0 || hasContext);
    sendBtn.disabled = !canSend;
    sendBtn.toggleClass('is-disabled', !canSend);
  });

  function maybeScroll() {
    if (autoScroll) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  }

  render();

  return {
    update(next: ChatboxProps) {
      props = next;
      render();
    },
    destroy() {
      rendered.clear();
      root.empty();
      root.removeClass('llm-tts-chatbox');
    },
  };
}

function formatTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
