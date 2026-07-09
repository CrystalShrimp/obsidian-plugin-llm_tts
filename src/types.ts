export type CallStatus =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'speaking'
  | 'paused'
  | 'error';

export type Role = 'user' | 'assistant' | 'system';

/**
 * CPA note context modes. Documents are organised as
 * `#` 章 / `##` 节 / `###` 知识点.
 */
export type ContextMode = 'h3-single' | 'h2-block' | 'all-h3';

export interface MessageContext {
  /** Which scope was attached. */
  scope: ContextMode;
  /** Vault path of the source file. */
  path: string;
  /** Heading chain from chapter down to the selected node, e.g. ["第一章 概述", "第一节 定义", "知识点3"]. */
  headingPath: string[];
  /** The actual content injected into the LLM context. */
  content: string;
}

export interface CallMessage {
  id: string;
  role: Role;
  text: string;
  createdAt: number;
  /** Optional tone hint for TTS. Populated only when the model returns it. */
  voiceInstruction?: string;
  /** True while the assistant message is still receiving streamed tokens. */
  streaming?: boolean;
  /** Document context attached to this user turn. */
  context?: MessageContext;
  /** Optional original technical text from Step 1. */
  step1Text?: string;
}

export interface LLMReply {
  reply: string;
  voiceInstruction?: string;
}

export type TTSMode = 'custom-http' | 'web-speech' | 'cosyvoice-local' | 'volcano';

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

export interface PromptPreset {
  id: string;
  name: string;
  contentSingle: string;
  contentMulti: string;
  content?: string;
}

export interface AICallSettings {
  /** OpenAI-compatible base URL, e.g. https://api.deepseek.com or http://localhost:11434/v1 */
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;

  /** Library of prompts switchable from the chatbox header. */
  prompts: PromptPreset[];
  /** ID of the currently active prompt preset. */
  activePromptId: string;

  /** Legacy single-persona field. Kept for migration; unused when prompts[].length > 0. */
  persona: string;

  maxHistoryMessages: number;
  temperature: number;

  ttsMode: TTSMode;

  /**
   * Your own TTS gateway that wraps Volcano / Aliyun / Tencent etc.
   * Plugin -> TTS gateway -> vendor, so secrets stay server-side.
   */
  ttsEndpoint: string;
  ttsApiKey: string;
  ttsVoice: string;
  ttsLang: string;

  autoPlay: boolean;

  // CosyVoice 本地配置
  cosyvoiceUrl?: string;
  cosyvoiceSpkId?: string;
  cosyvoiceSampleRate?: number;

  // 火山引擎配置
  volcanoApiKey?: string;
  volcanoAppId?: string;
  volcanoSpeaker?: string;
  volcanoResourceId?: string;
  volcanoSampleRate?: number;

  /** Default context mode when chat panel opens or conversation clears. */
  defaultContextMode: ContextMode;
}

const CPA_GENERAL_SINGLE = [
  '你是一位经验丰富的 CPA 辅导名师。请针对学生提供的单个知识点教材原文，进行高水准的深度技术拆解。',
  '要求输出结构清晰的 Markdown 讲解，包含以下核心部分：',
  '1. **核心考点**：用专业且透彻的语言总结该知识点在考什么，指出容易混淆的概念和考生的盲区。',
  '2. **商业实质**：用硬核逻辑解释会计准则为什么要制定该项规定？背后的商业逻辑和经济实质是什么？',
  '3. **防钻空子逻辑**：从监管和防造假的视角，深入剖析如果不这样规定，企业在实务中会如何利用这个漏洞来钻空子、操纵利润或隐藏负债？',
  '请保持极高的专业度和技术准确性，允许并推荐使用标准会计分录、对比表格和专业学术术语，提供富有深度的专业解答。'
].join('\n');

const CPA_GENERAL_MULTI = [
  '你是一位经验丰富的 CPA 辅导名师。请针对学生输入的这一组零碎知识点大纲，进行逐一的技术拆解。',
  '对于大纲中的每一个知识点，你必须列出并深入剖析以下两个核心问题：',
  '1. 准则规定这么做的**商业实质**和经济实质是什么？',
  '2. 如果不这么规定，企业在实务中会如何利用这个漏洞来**钻空子、操纵利润或隐藏负债**？',
  '请逐条列出并分别展开，保持极高的专业度和技术准确性，允许并推荐使用会计分录与专业学术术语。'
].join('\n');

const CPA_CALC_SINGLE = [
  '你是一位擅长财管和税法计算的 CPA 辅导专家。请针对单个计算类知识点提供深度的技术与公式逻辑拆解。',
  '请输出 Markdown 格式的硬核内容：',
  '1. **计算公式解析**：详细拆解该公式的组成，用金融/税收逻辑解释每个参数的含义，说明为什么要这么乘除加减。',
  '2. **避坑与造假漏洞**：分析该计算方法在实务或考题中最容易在哪一步设陷阱？如果不这样限制，企业如何在财务报表上虚增资产或错记税款？',
  '3. **极速演练**：用一个极简但有代表性的数字案例，写出清晰的计算步骤与最终结果。',
  '请保持极高的专业度，公式解析需严谨透彻。'
].join('\n');

const CPA_CALC_MULTI = [
  '你是一位擅长财管和税法计算的 CPA 辅导专家。请针对这一组零碎的计算知识点大纲进行逐一的深度拆解。',
  '对于大纲中的每一个计算知识点，你必须深入阐明：',
  '1. 公式计算背后的**商业实质**与金融逻辑是什么？',
  '2. 如果没有这一规则约束，企业会如何在实务中**虚增资产、错记税款或粉饰财务报表**？',
  '请逐个列出并清晰展开，允许并推荐使用计算步骤和对比表格。'
].join('\n');

const CPA_LAW_SINGLE = [
  '你是一位擅长用生活化和实务案例剖析法律规则的 CPA 经济法名师。请针对单个法条原文进行深度法律关系剖析。',
  '请输出 Markdown 格式的讲解：',
  '1. **核心法律关系**：清晰理顺法条保护谁、约束谁，权利与义务的边界在哪里。',
  '2. **立法初衷与商业实质**：解释法条设计的初衷是什么？解决实务中的什么商业痛点？',
  '3. **防钻空子逻辑**：深入剖析如果不这么立法，企业、大股东或实际控制人在实务中会如何利用这个漏洞进行利益输送、违规操纵或逃避债务？',
  '请保持法理上的严谨度，结合实务案例进行深度解说。'
].join('\n');

const CPA_LAW_MULTI = [
  '你是一位擅长用生活化和实务案例剖析法律规则的 CPA 经济法名师。请针对这一组法条原文大纲进行逐一深度剖析。',
  '对于大纲中的每一个法条/知识点，你必须阐明：',
  '1. 该法律规则确立的**法理与商业实质**是什么？',
  '2. 如果没有这一规则约束，大股东或实控人在实务中会如何**钻空子逃避负债、掏空企业或进行违规利益输送**？',
  '请逐一展开，条理清晰。'
].join('\n');

function makeId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}_${Date.now().toString(36)}`;
}

export const DEFAULT_PROMPTS: PromptPreset[] = [
  {
    id: 'cpa-general',
    name: 'CPA 通用讲解',
    contentSingle: CPA_GENERAL_SINGLE,
    contentMulti: CPA_GENERAL_MULTI,
    content: CPA_GENERAL_SINGLE,
  },
  {
    id: 'cpa-calc',
    name: 'CPA 计算（财管/税法）',
    contentSingle: CPA_CALC_SINGLE,
    contentMulti: CPA_CALC_MULTI,
    content: CPA_CALC_SINGLE,
  },
  {
    id: 'cpa-law',
    name: 'CPA 法条（经济法）',
    contentSingle: CPA_LAW_SINGLE,
    contentMulti: CPA_LAW_MULTI,
    content: CPA_LAW_SINGLE,
  },
];

export function makePromptId(): string {
  return makeId('p');
}

export const DEFAULT_SETTINGS: AICallSettings = {
  llmBaseUrl: 'https://api.deepseek.com',
  llmApiKey: '',
  llmModel: 'deepseek-chat',

  prompts: DEFAULT_PROMPTS,
  activePromptId: DEFAULT_PROMPTS[0].id,

  persona: CPA_GENERAL_SINGLE,

  maxHistoryMessages: 12,
  temperature: 0.7,

  ttsMode: 'web-speech',
  ttsEndpoint: '',
  ttsApiKey: '',
  ttsVoice: 'zh-CN-XiaoxiaoNeural',
  ttsLang: 'zh-CN',

  autoPlay: true,

  cosyvoiceUrl: 'http://localhost:50000',
  cosyvoiceSpkId: '中文女',
  cosyvoiceSampleRate: 22050,

  volcanoApiKey: '',
  volcanoAppId: '',
  volcanoSpeaker: '',
  volcanoResourceId: 'seed-tts-2.0',
  volcanoSampleRate: 24000,

  defaultContextMode: 'h3-single',
};
