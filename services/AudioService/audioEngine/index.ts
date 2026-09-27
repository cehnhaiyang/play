
/// <reference lib="dom" />
import { ParserError, ScheduledEvent } from '../../../meta';
import { bufferToWave, clamp } from '../utils';
import { SPGParser, ParseResult, SPGError, SPGWarning } from './parser';
import { EventScheduler } from './scheduler';
import { AudioSynthesizer } from './synthesizer';

/** 效果尾音的额外预留时长 (秒) */
const EFFECT_TAIL = 3.0;
/** 导出时的采样率 */
const RENDER_SAMPLE_RATE = 44100;

export class BrowserAudioEngine {
  // 这些节点在 buildGraph() 里创建（构造函数委托给它），故用明确赋值断言
  private mainCtx!: AudioContext;
  private masterGain!: GainNode;
  private compressor!: DynamicsCompressorNode;
  private limiter!: WaveShaperNode;
  private analyser!: AnalyserNode;

  // Components
  private parser: SPGParser;
  private scheduler: EventScheduler;
  private synthesizer!: AudioSynthesizer;

  // State
  private lastParseResult: ParseResult | null = null;
  private scheduledEvents: ScheduledEvent[] = [];
  private totalDuration: number = 0;
  private activeSources: Set<AudioScheduledSourceNode> = new Set();

  constructor() {
    this.parser = new SPGParser();
    this.scheduler = new EventScheduler();
    this.buildGraph();
  }

  /**
   * 建立（或重建）音频节点图。
   *
   * 独立成方法是为了支持 `dispose()` 之后复用：React StrictMode 在开发模式下会
   * 先挂载、卸载、再挂载，卸载时的 `dispose()` 会关闭 AudioContext；
   * 若引擎实例被复用而不重建，第二次挂载拿到的就是一个已关闭的死上下文，
   * 表现为"完全没有声音"。这里让引擎在被关闭后能自我修复。
   */
  private buildGraph() {
    const Win = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const AudioContextClass = Win.AudioContext || Win.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error('当前环境不支持 Web Audio API');
    }
    this.mainCtx = new AudioContextClass();
    this.synthesizer = new AudioSynthesizer(this.mainCtx);

    // 链路：masterGain -> compressor -> limiter -> analyser -> destination
    this.masterGain = this.mainCtx.createGain();
    this.compressor = this.mainCtx.createDynamicsCompressor();
    this.limiter = this.mainCtx.createWaveShaper();
    this.analyser = this.mainCtx.createAnalyser();

    // 1. 压缩器：降低压缩比、放慢启动，保留瞬态让声音有"呼吸感"
    this.compressor.threshold.value = -18;
    this.compressor.knee.value = 10;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.03;
    this.compressor.release.value = 0.25;

    // 2. 软削波限制器：tanh 饱和，防止数字削波
    this.limiter.curve = this.makeSoftClipCurve(1.0);
    this.limiter.oversample = '4x';

    // 3. 分析器
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.85;
    this.analyser.minDecibels = -90;
    this.analyser.maxDecibels = -10;

    this.masterGain.connect(this.compressor);
    this.compressor.connect(this.limiter);
    this.limiter.connect(this.analyser);
    this.analyser.connect(this.mainCtx.destination);

    this.masterGain.gain.value = this.lastParseResult
      ? clamp(this.lastParseResult.masterVolumeConfig, 0, 2, 0.6)
      : 0.6;
    this.activeSources.clear();
  }

  /** 上下文是否已被关闭（StrictMode 卸载后可能出现） */
  private get isDead(): boolean {
    return !this.mainCtx || this.mainCtx.state === 'closed';
  }

  /** 若上下文已失效则重建整张图 */
  private ensureAlive() {
    if (this.isDead) this.buildGraph();
  }

  /** 生成软削波曲线 */
  private makeSoftClipCurve(amount: number): Float32Array<ArrayBuffer> {
    const n = 4410;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; ++i) {
      const x = (i * 2) / n - 1;
      curve[i] = Math.tanh(amount * x);
    }
    return curve;
  }

  /**
   * 取分析器节点。
   * 这里也要确保上下文存活：StrictMode 重挂载时组件会重新取一次分析器，
   * 若返回的是已关闭上下文里的旧节点，示波器就再也读不到数据了。
   */
  public getAnalyser() {
    this.ensureAlive();
    return this.analyser;
  }
  public getContext() { return this.mainCtx; }
  public getDuration() { return this.totalDuration; }

  /** 把解析异常转换为带行号的 ParserError */
  private toParserError(e: unknown): ParserError {
    if (e instanceof SPGError) {
      return { message: e.message, line: e.line };
    }
    const message = e instanceof Error ? e.message : '未知的编译错误';
    return { message, line: 0 };
  }

  public compile(code: string): ParserError | null {
    if (!code || code.trim().length === 0) {
      return { message: '代码为空', line: 1 };
    }
    try {
      const parsed = this.parser.parse(code);
      const { events, totalDuration } = this.scheduler.schedule(
        parsed.sequences,
        parsed.instruments,
        parsed.mix,
        parsed.tempo,
        parsed.swing
      );

      // 先落盘本次解析结果，警告才能在"没有事件"这条失败路径上也拿得到
      this.lastParseResult = parsed;

      if (events.length === 0) {
        return { message: '代码编译通过，但没有产生任何音符事件', line: 0 };
      }

      this.scheduledEvents = events;
      // 效果链会拖出尾音，导出时需要留出余量
      this.totalDuration = totalDuration + (parsed.effects.length > 0 ? EFFECT_TAIL : 0.5);

      this.masterGain.gain.value = clamp(parsed.masterVolumeConfig, 0, 2, 0.6);
      return null;
    } catch (e: unknown) {
      return this.toParserError(e);
    }
  }

  /**
   * 最近一次成功编译产生的非致命提示。
   *
   * 典型场景是"某个 sequence 没被 mix 引用，因此不会发声"——
   * 代码语法完全正确、编译通过、界面显示 READY，但用户听不到那一轨，
   * 只能靠提示告诉他原因。
   */
  public getWarnings(): SPGWarning[] {
    return this.lastParseResult?.warnings ?? [];
  }

  public async playRealtime() {
    if (!this.lastParseResult) throw new Error('没有可播放的已编译代码');
    // StrictMode 卸载会关闭上下文，这里按需重建后再播放
    this.ensureAlive();

    if (this.mainCtx.state === 'suspended') await this.mainCtx.resume();

    // 先停掉上一次的播放，避免声音叠加
    this.stop();

    const now = this.mainCtx.currentTime;
    // 留一点调度余量，避免首个音符因调度延迟被截断
    const buffer = 0.08;
    const playEvents = this.scheduledEvents.map((e) => ({ ...e, time: e.time + now + buffer }));

    this.synthesizer.scheduleEvents(
      this.mainCtx,
      this.masterGain,
      playEvents,
      this.lastParseResult.effects,
      this.registerSource.bind(this)
    );
  }

  private registerSource(node: AudioScheduledSourceNode) {
    this.activeSources.add(node);
    node.onended = () => {
      this.activeSources.delete(node);
    };
  }

  public stop() {
    // 上下文已关闭时任何节点操作都会抛错，直接返回
    if (this.isDead) return;

    // 1. 停掉所有活动音源
    this.activeSources.forEach((source) => {
      try {
        source.onended = null;
        source.stop();
      } catch {
        /* 已停止的节点再 stop 会抛异常，忽略 */
      }
    });
    this.activeSources.clear();

    // 2. 重置 masterGain 以立刻掐断混响/延迟尾音。
    //    效果链是挂在 masterGain 下游的，断开它即可让整条链失去输入而静音，
    //    无需逐节点追踪（节点会随引用消失被回收）。
    try { this.masterGain.disconnect(); } catch { /* ignore */ }
    this.masterGain = this.mainCtx.createGain();
    this.masterGain.gain.value = this.lastParseResult
      ? clamp(this.lastParseResult.masterVolumeConfig, 0, 2, 0.6)
      : 0.5;
    this.masterGain.connect(this.compressor);
  }

  /** 释放音频上下文（组件卸载时调用）。之后再次播放会自动重建节点图。 */
  public async dispose() {
    this.stop();
    try {
      if (this.mainCtx && this.mainCtx.state !== 'closed') await this.mainCtx.close();
    } catch {
      /* ignore */
    }
  }

  public async renderOffline(): Promise<Blob> {
    if (!this.lastParseResult) throw new Error('没有可导出的已编译代码');

    const sampleRate = RENDER_SAMPLE_RATE;
    const length = Math.max(1, Math.ceil((this.totalDuration || 1) * sampleRate));

    const Win = window as unknown as {
      OfflineAudioContext?: typeof OfflineAudioContext;
      webkitOfflineAudioContext?: typeof OfflineAudioContext;
    };
    const OfflineCtxClass = Win.OfflineAudioContext || Win.webkitOfflineAudioContext;
    if (!OfflineCtxClass) throw new Error('当前环境不支持离线音频渲染');

    // 立体声输出，与实时链路保持一致
    const offlineCtx = new OfflineCtxClass(2, length, sampleRate);

    const offMaster = offlineCtx.createGain();
    const offComp = offlineCtx.createDynamicsCompressor();
    const offLimiter = offlineCtx.createWaveShaper();

    // 复制实时链路的全部参数，保证导出与试听一致
    offComp.threshold.value = this.compressor.threshold.value;
    offComp.knee.value = this.compressor.knee.value;
    offComp.ratio.value = this.compressor.ratio.value;
    offComp.attack.value = this.compressor.attack.value;
    offComp.release.value = this.compressor.release.value;

    offLimiter.curve = this.limiter.curve;
    offLimiter.oversample = '4x';

    // 旧实现漏了这一行，导出音量与试听不一致
    offMaster.gain.value = clamp(this.lastParseResult.masterVolumeConfig, 0, 2, 0.6);

    offMaster.connect(offComp);
    offComp.connect(offLimiter);
    offLimiter.connect(offlineCtx.destination);

    // 离线上下文采样率可能不同，需要独立合成器实例
    const offlineSynth = new AudioSynthesizer(offlineCtx);
    offlineSynth.scheduleEvents(
      offlineCtx,
      offMaster,
      this.scheduledEvents,
      this.lastParseResult.effects,
      () => { /* 离线渲染无需跟踪音源 */ }
    );

    const renderedBuffer = await offlineCtx.startRendering();
    return bufferToWave(renderedBuffer, length);
  }
}
