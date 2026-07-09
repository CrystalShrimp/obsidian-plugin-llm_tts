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
      return this.playBlob(result.blob);
    }

    return this.speakByWebSpeech(result.text, {
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

    const ss = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (ss && ss.speaking && !ss.paused) {
      ss.pause();
    }
  }

  resume() {
    if (this.audio && this.audio.paused) {
      void this.audio.play().catch(() => {});
      return;
    }

    const ss = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (ss && ss.paused) {
      ss.resume();
    }
  }

  stop() {
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
      this.audio.src = '';
      try {
        this.audio.load();
      } catch (e) {}
      this.audio = undefined;
    }

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = undefined;
    }

    const ss = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (ss && (ss.speaking || ss.pending)) {
      ss.cancel();
    }

    this.utterance = undefined;
  }

  destroy() {
    this.stop();
  }

  isPlaying(): boolean {
    const ss = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    return Boolean(
      (this.audio && !this.audio.paused) ||
        (ss && ss.speaking),
    );
  }

  private async playBlob(blob: Blob): Promise<void> {
    this.objectUrl = URL.createObjectURL(blob);
    this.audio = new Audio(this.objectUrl);

    await new Promise<void>((resolve, reject) => {
      if (!this.audio) return resolve();

      this.audio.onended = () => resolve();
      this.audio.onerror = () => {
        const errorDetail = this.audio?.error
          ? ` (错误码: ${this.audio.error.code}, 信息: ${this.audio.error.message})`
          : '';
        reject(new Error(`音频播放失败${errorDetail}`));
      };

      void this.audio.play().catch(reject);
    });
  }

  private async speakByWebSpeech(
    text: string,
    options: { lang?: string; voiceName?: string },
  ): Promise<void> {
    const ss = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (!ss) {
      throw new Error('speechSynthesis is not available in this environment');
    }

    await this.waitForVoices();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = options.lang ?? 'zh-CN';

    const voices = ss.getVoices();
    const matchedVoice = voices.find((voice) => {
      if (!options.voiceName) return false;
      return (
        voice.name === options.voiceName ||
        voice.name.includes(options.voiceName)
      );
    });

    if (matchedVoice) utterance.voice = matchedVoice;

    this.utterance = utterance;

    await new Promise<void>((resolve, reject) => {
      utterance.onend = () => resolve();
      utterance.onerror = (event) =>
        reject(new Error(`Speech synthesis failed: ${event.error}`));

      ss.speak(utterance);
    });
  }

  private async waitForVoices(): Promise<void> {
    const ss = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (!ss) return;

    const voices = ss.getVoices();
    if (voices.length > 0) return;

    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        ss.onvoiceschanged = null;
        resolve();
      }, 1000);

      ss.onvoiceschanged = () => {
        window.clearTimeout(timer);
        ss.onvoiceschanged = null;
        resolve();
      };
    });
  }
}
