import { requestUrl } from 'obsidian';
import { AICallSettings, TTSResult } from '../types';
import { VolcanoTTSClient } from './VolcanoTTSClient';

export interface SynthesizeInput {
  text: string;
  voiceInstruction?: string;
  signal?: AbortSignal;
}

export class TTSClient {
  private volcanoClient: VolcanoTTSClient;

  constructor(private getSettings: () => AICallSettings) {
    this.volcanoClient = new VolcanoTTSClient(getSettings);
  }

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
      return this.synthesizeByCustomHttp(input);
    }

    if (settings.ttsMode === 'cosyvoice-local') {
      return this.synthesizeByCosyVoiceLocal(input);
    }

    if (settings.ttsMode === 'volcano') {
      return this.volcanoClient.synthesize({
        text: input.text,
        signal: input.signal,
      });
    }

    throw new Error(`Unsupported TTS mode: ${settings.ttsMode}`);
  }

  private async synthesizeByCustomHttp(input: SynthesizeInput): Promise<TTSResult> {
    const settings = this.getSettings();

    if (!settings.ttsEndpoint.trim()) {
      throw new Error('TTS endpoint is empty');
    }

    /**
     * Your gateway is expected to accept:
     * POST {ttsEndpoint}
     * { "text", "voice", "lang", "style", "format": "mp3" }
     * and respond with Content-Type: audio/* plus a binary body.
     */
    const response = await requestUrl({
      url: settings.ttsEndpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(settings.ttsApiKey ? { Authorization: `Bearer ${settings.ttsApiKey}` } : {}),
      },
      body: JSON.stringify({
        text: input.text,
        voice: settings.ttsVoice,
        lang: settings.ttsLang,
        style: input.voiceInstruction ?? '',
        format: 'mp3',
      }),
      throw: false,
    });

    if (response.status >= 400) {
      const detail =
        typeof response.text === 'string' ? response.text : JSON.stringify(response.json);
      throw new Error(`TTS ${response.status}: ${detail}`);
    }

    const contentType =
      response.headers?.['content-type'] ??
      response.headers?.['Content-Type'] ??
      'audio/mpeg';

    const arrayBuffer = response.arrayBuffer;
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      throw new Error('TTS response has no audio data');
    }

    return {
      kind: 'audio',
      blob: new Blob([arrayBuffer], { type: contentType }),
      mimeType: contentType,
    };
  }

  private async synthesizeByCosyVoiceLocal(input: SynthesizeInput): Promise<TTSResult> {
    const settings = this.getSettings();
    const cosyvoiceUrl = settings.cosyvoiceUrl?.trim() || 'http://localhost:50000';
    const spkId = settings.cosyvoiceSpkId?.trim() || '中文女';
    const sampleRate = settings.cosyvoiceSampleRate || 22050;

    const params = new URLSearchParams();
    params.append('tts_text', input.text);
    params.append('spk_id', spkId);

    const response = await requestUrl({
      url: `${cosyvoiceUrl}/inference_sft`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      throw: false,
    });

    if (response.status >= 400) {
      const detail =
        typeof response.text === 'string' ? response.text : JSON.stringify(response.json);
      throw new Error(`CosyVoice ${response.status}: ${detail}`);
    }

    const arrayBuffer = response.arrayBuffer;
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      throw new Error('CosyVoice response has no audio data');
    }

    const wavBuffer = pcmToWav(arrayBuffer, sampleRate);

    return {
      kind: 'audio',
      blob: new Blob([wavBuffer], { type: 'audio/wav' }),
      mimeType: 'audio/wav',
    };
  }
}

function pcmToWav(pcmBuffer: ArrayBuffer, sampleRate: number): ArrayBuffer {
  const pcmLength = pcmBuffer.byteLength;
  const buffer = new ArrayBuffer(44 + pcmLength);
  const view = new DataView(buffer);

  /* RIFF identifier */
  writeString(view, 0, 'RIFF');
  /* file length */
  view.setUint32(4, 36 + pcmLength, true);
  /* RIFF type */
  writeString(view, 8, 'WAVE');
  /* format chunk identifier */
  writeString(view, 12, 'fmt ');
  /* format chunk length */
  view.setUint32(16, 16, true);
  /* sample format (raw PCM) */
  view.setUint16(20, 1, true);
  /* channel count (mono) */
  view.setUint16(22, 1, true);
  /* sample rate */
  view.setUint32(24, sampleRate, true);
  /* byte rate (sample rate * block align) */
  view.setUint32(28, sampleRate * 2, true);
  /* block align (channel count * bytes per sample) */
  view.setUint16(32, 2, true);
  /* bits per sample */
  view.setUint16(34, 16, true);
  /* data chunk identifier */
  writeString(view, 36, 'data');
  /* data chunk length */
  view.setUint32(40, pcmLength, true);

  // Copy PCM data
  const pcmView = new Uint8Array(pcmBuffer);
  const wavView = new Uint8Array(buffer, 44);
  wavView.set(pcmView);

  return buffer;
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}
