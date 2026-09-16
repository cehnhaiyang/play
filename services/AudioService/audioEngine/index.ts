
/// <reference lib="dom" />
import { ParserError, ScheduledEvent } from '../../../meta';
import { bufferToWave } from '../utils';
import { SPGParser, ParseResult } from './parser';
import { EventScheduler } from './scheduler';
import { AudioSynthesizer } from './synthesizer';

export class BrowserAudioEngine {
  private mainCtx: AudioContext;
  private masterGain: GainNode;
  private compressor: DynamicsCompressorNode;
  private limiter: WaveShaperNode; // 新增：限制器
  private analyser: AnalyserNode;
  
  // Components
  private parser: SPGParser;
  private scheduler: EventScheduler;
  private synthesizer: AudioSynthesizer;

  // State
  private lastParseResult: ParseResult | null = null;
  private scheduledEvents: ScheduledEvent[] = [];
  private totalDuration: number = 0;
  private activeSources: Set<AudioScheduledSourceNode> = new Set();

  constructor() {
    const Win = window as any;
    const AudioContextClass = Win.AudioContext || Win.webkitAudioContext;
    this.mainCtx = new AudioContextClass();
    
    // Components Init
    this.parser = new SPGParser();
    this.scheduler = new EventScheduler();
    this.synthesizer = new AudioSynthesizer(this.mainCtx);

    // Chain: masterGain -> compressor -> limiter -> analyser -> destination
    this.masterGain = this.mainCtx.createGain();
    this.compressor = this.mainCtx.createDynamicsCompressor();
    this.limiter = this.mainCtx.createWaveShaper();
    this.analyser = this.mainCtx.createAnalyser();
    
    // 1. Compressor Settings (Optimized for Music)
    // 降低压缩比，增加 Attack 时间保留瞬态，使声音更有"呼吸感"
    this.compressor.threshold.value = -18;
    this.compressor.knee.value = 10;
    this.compressor.ratio.value = 4; // 从 12 降到 4，避免过度挤压
    this.compressor.attack.value = 0.03; // 30ms，保留打击乐头的冲击力
    this.compressor.release.value = 0.25;

    // 2. Limiter / Soft Clipper (Saturator)
    // 使用双曲正切曲线模拟模拟设备的饱和失真，防止数字削波
    this.limiter.curve = this.makeSoftClipCurve(1.0);
    this.limiter.oversample = '4x';

    // Analyser Settings (Tuned for better visualization)
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.85; 
    this.analyser.minDecibels = -90;
    this.analyser.maxDecibels = -10;

    // Connect Chain
    this.masterGain.connect(this.compressor);
    this.compressor.connect(this.limiter); // 压缩后进入限制器
    this.limiter.connect(this.analyser);
    this.analyser.connect(this.mainCtx.destination);
    
    this.masterGain.gain.value = 0.6; // 稍微提升一点增益，因为有限制器保护
  }

  // 生成软削波曲线（new Float32Array(n) 底层恒为 ArrayBuffer，显式标注以满足 WaveShaperNode.curve 的类型）
  private makeSoftClipCurve(amount: number): Float32Array<ArrayBuffer> {
    const k = amount;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      // Soft clipping function: tanh
      curve[i] = Math.tanh(k * x);
    }
    return curve;
  }

  public getAnalyser() { return this.analyser; }
  public getContext() { return this.mainCtx; }

  // Registers a source node to be tracked for stop()
  private registerSource(node: AudioScheduledSourceNode) {
      this.activeSources.add(node);
      node.onended = () => {
          this.activeSources.delete(node);
      };
  }

  public compile(code: string): ParserError | null {
    if (!code || code.trim().length === 0) {
        return { message: "Code is empty", line: 1 };
    }
    try {
      // 1. Parse Code
      this.lastParseResult = this.parser.parse(code);
      
      // 2. Parse Mix (extract tracks) and Schedule
      const mixTracks = this.parser.parseMix(code);
      
      const { events, totalDuration } = this.scheduler.schedule(
          this.lastParseResult.sequences,
          this.lastParseResult.instruments,
          mixTracks,
          this.lastParseResult.tempo
      );
      
      this.scheduledEvents = events;
      this.totalDuration = totalDuration;

      // Add tail for effects if any
      if (this.lastParseResult.effects.length > 0) {
          this.totalDuration += 3.0;
      }
      
      // Update Master Gain
      this.masterGain.gain.value = this.lastParseResult.masterVolumeConfig;

      return null;
    } catch (e: any) {
      return { message: e.message || "Unknown compilation error", line: 0 };
    }
  }

  public async playRealtime() {
    if (!this.lastParseResult) throw new Error("No compiled code available");

    if (this.mainCtx.state === 'suspended') await this.mainCtx.resume();
    
    // Stop previous sounds properly
    this.stop();

    const now = this.mainCtx.currentTime;
    const buffer = 0.1;
    
    // Offset events to start shortly after now
    const playEvents = this.scheduledEvents.map(e => ({...e, time: e.time + now + buffer}));
    
    // Delegate synthesis to sub-module
    this.synthesizer.scheduleEvents(
        this.mainCtx, 
        this.masterGain, 
        playEvents, 
        this.lastParseResult.effects, 
        this.registerSource.bind(this)
    );
  }

  public stop() {
    // 1. Stop all active oscillators/sources
    this.activeSources.forEach(source => {
        try { source.stop(); } catch (e) { /* ignore */ }
    });
    this.activeSources.clear();

    // 2. Reset Master Gain to kill reverb tails instantly
    this.masterGain.disconnect();
    
    // Re-create master gain
    this.masterGain = this.mainCtx.createGain();
    
    // Restore volume from config or default
    if (this.lastParseResult) {
        this.masterGain.gain.value = this.lastParseResult.masterVolumeConfig;
    } else {
        this.masterGain.gain.value = 0.5;
    }

    // Reconnect Chain
    this.masterGain.connect(this.compressor);
  }

  public async renderOffline(): Promise<Blob> {
    if (!this.lastParseResult) throw new Error("No compiled code to export");

    const sampleRate = 44100;
    const length = Math.ceil((this.totalDuration || 1) * sampleRate);
    
    const Win = window as any;
    const OfflineCtxClass = Win.OfflineAudioContext || Win.webkitOfflineAudioContext;
    const offlineCtx = new OfflineCtxClass(2, length, sampleRate);
    
    // Setup offline master chain
    const offMaster = offlineCtx.createGain();
    const offComp = offlineCtx.createDynamicsCompressor();
    const offLimiter = offlineCtx.createWaveShaper();

    // Copy settings
    offComp.threshold.value = this.compressor.threshold.value;
    offComp.knee.value = this.compressor.knee.value;
    offComp.ratio.value = this.compressor.ratio.value;
    offComp.attack.value = this.compressor.attack.value;
    offComp.release.value = this.compressor.release.value;

    offLimiter.curve = this.limiter.curve;
    offLimiter.oversample = '4x';
    
    offMaster.connect(offComp);
    offComp.connect(offLimiter);
    offLimiter.connect(offlineCtx.destination);

    // Schedule
    this.synthesizer.scheduleEvents(
        offlineCtx, 
        offMaster, 
        this.scheduledEvents, 
        this.lastParseResult.effects,
        () => {} // No need to track sources for offline
    );

    const renderedBuffer = await offlineCtx.startRendering();
    return bufferToWave(renderedBuffer, length);
  }
}
