import type { CallStatus, ContextMode } from '../../types';

export interface ChatboxMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
  streaming?: boolean;
  context?: {
    scope: ContextMode;
    path: string;
    headingPath: string[];
  };
  step1Text?: string;
}

export interface ChatboxActiveFile {
  path: string;
  basename: string;
  size: number;
}

export interface ChatboxHeadingOption {
  /** Index into the resolved headings array. */
  value: number;
  label: string;
  /** Parent breadcrumb like "第一章 › 第一节". */
  breadcrumb?: string;
}

export interface ChatboxPromptOption {
  id: string;
  name: string;
}

export interface ChatboxProps {
  title?: string;
  status: CallStatus;
  error?: string;
  messages: ChatboxMessage[];
  isSending?: boolean;
  isSpeaking?: boolean;
  placeholder?: string;

  activeFile?: ChatboxActiveFile | null;
  contextMode: ContextMode;

  /** Available ### knowledge points. */
  h3Options: ChatboxHeadingOption[];
  /** Available ## sections. */
  h2Options: ChatboxHeadingOption[];
  /** Currently selected H3 value (index into headings). */
  selectedH3?: number;
  /** Currently selected H2 value. */
  selectedH2?: number;

  /** Available prompt presets in the library. */
  promptOptions: ChatboxPromptOption[];
  activePromptId?: string;

  renderMarkdown?: (
    el: HTMLElement,
    markdown: string,
  ) => Promise<void> | void;

  onSendMessage: (text: string, options?: { isFollowUp: boolean }) => void | Promise<void>;
  onStop: () => void;
  onReplayLast: () => void | Promise<void>;
  onClear: () => void;
  onCopyMessage: (message: ChatboxMessage) => void | Promise<void>;
  onRegenerate: () => void | Promise<void>;
  onChangeContextMode: (mode: ContextMode) => void;
  onSelectH3: (value: number) => void;
  onSelectH2: (value: number) => void;
  onSelectPrompt: (promptId: string) => void;
  onRefreshActiveFile: () => void | Promise<void>;
}

export interface ChatboxController {
  update(props: ChatboxProps): void;
  destroy(): void;
}
