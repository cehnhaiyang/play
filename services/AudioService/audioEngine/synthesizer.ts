
/// <reference lib="dom" />
import { ScheduledEvent, EffectDef } from '../../../meta';

export class AudioSynthesizer {
    private whiteNoiseBuffer: AudioBuffer | null = null;
    private pinkNoiseBuffer: AudioBuffer | null = null;

    constructor(ctx: BaseAudioContext) {
        this.initNoiseBuffers(ctx);
    }

    private initNoiseBuffers(ctx: BaseAudioContext) {
        const duration = 2.0; 
        const sampleRate = ctx.sampleRate;
        const bufferSize = sampleRate * duration;

        // White Noise
        this.whiteNoiseBuffer = ctx.createBuffer(1, bufferSize, sampleRate);
        const whiteData = this.whiteNoiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            whiteData[i] = Math.random() * 2 - 1;
        }

        // Pink Noise
        this.pinkNoiseBuffer = ctx.createBuffer(1, bufferSize, sampleRate);
        const pinkData = this.pinkNoiseBuffer.getChannelData(0);
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < bufferSize; i++) {
            const white = Math.random() * 2 - 1;
            b0 = 0.99886 * b0 + white * 0.0555179;
            b1 = 0.99332 * b1 + white * 0.0750759;
            b2 = 0.96900 * b2 + white * 0.1538520;
            b3 = 0.86650 * b3 + white * 0.3104856;
            b4 = 0.55000 * b4 + white * 0.5329522;
            b5 = -0.7616 * b5 - white * 0.0168981;
            pinkData[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
            pinkData[i] *= 0.11;
            b6 = white * 0.115926;
        }
    }

    public buildEffectChain(ctx: BaseAudioContext, inputNode: AudioNode, outputNode: AudioNode, effects: EffectDef[]) {
        let currentNode = inputNode;

        effects.forEach(effect => {
            if (effect.type === 'delay') {
                const delayNode = ctx.createDelay();
                delayNode.delayTime.value = effect.time;
                const feedbackNode = ctx.createGain();
                feedbackNode.gain.value = effect.feedback;
                const wetGain = ctx.createGain();
                wetGain.gain.value = effect.mix;
                const dryGain = ctx.createGain();
                dryGain.gain.value = 1 - effect.mix;

                // Tape Delay Effect: Filter the feedback loop
                const filter = ctx.createBiquadFilter();
                filter.type = "lowpass"; 
                filter.frequency.value = 2000; // Darker repeats
                filter.Q.value = 0.5;

                currentNode.connect(dryGain);
                
                // Wet path
                currentNode.connect(delayNode);
                delayNode.connect(filter);
                filter.connect(feedbackNode);
                feedbackNode.connect(delayNode);
                filter.connect(wetGain);

                const merger = ctx.createGain();
                dryGain.connect(merger);
                wetGain.connect(merger);
                currentNode = merger;

            } else if (effect.type === 'distortion') {
                const dist = ctx.createWaveShaper();
                dist.curve = this.makeDistortionCurve(effect.amount * 400);
                dist.oversample = '4x';
                
                const compGain = ctx.createGain();
                compGain.gain.value = 1 / (1 + effect.amount);
                
                currentNode.connect(dist);
                dist.connect(compGain);
                currentNode = compGain;

            } else if (effect.type === 'reverb') {
                const convolver = ctx.createConvolver();
                
                // Better Reverb Generation (Smooth Exponential Decay with Filtering)
                const duration = effect.decay;
                const rate = ctx.sampleRate;
                const length = rate * duration;
                const impulse = ctx.createBuffer(2, length, rate);
                const impulseL = impulse.getChannelData(0);
                const impulseR = impulse.getChannelData(1);

                for (let i = 0; i < length; i++) {
                    const t = i / length;
                    // Decay curve
                    const decay = Math.pow(1 - t, 2.5); 
                    
                    // Simple Lowpass via moving average approximation logic in noise generation
                    // Or just plain noise. To fix metallic sound, we rely on the density.
                    const noiseL = (Math.random() * 2 - 1);
                    const noiseR = (Math.random() * 2 - 1);
                    
                    impulseL[i] = noiseL * decay;
                    impulseR[i] = noiseR * decay;
                }
                convolver.buffer = impulse;

                // Add a pre-tone filter to reverb to make it less harsh
                const revFilter = ctx.createBiquadFilter();
                revFilter.type = 'lowpass';
                revFilter.frequency.value = 5000; // Dampen high freq reverb

                const wet = ctx.createGain();
                wet.gain.value = effect.mix;
                const dry = ctx.createGain();
                dry.gain.value = 1 - effect.mix;

                currentNode.connect(dry);
                
                currentNode.connect(revFilter);
                revFilter.connect(convolver);
                convolver.connect(wet);

                const merge = ctx.createGain();
                wet.connect(merge);
                dry.connect(merge);
                currentNode = merge;
            }
        });

        currentNode.connect(outputNode);
    }

    private makeDistortionCurve(amount: number) {
        const n_samples = 44100;
        const curve = new Float32Array(n_samples);
        const deg = Math.PI / 180;
        for (let i = 0; i < n_samples; ++i) {
            const x = (i * 2) / n_samples - 1;
            curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
        }
        return curve;
    }

    public scheduleEvents(
        ctx: BaseAudioContext, 
        destination: AudioNode, 
        events: ScheduledEvent[], 
        effects: EffectDef[],
        registerSource: (node: AudioScheduledSourceNode) => void
    ) {
        const masterBus = ctx.createGain();
        masterBus.gain.value = 1.0;

        if (effects.length > 0) {
            this.buildEffectChain(ctx, masterBus, destination, effects);
        } else {
            masterBus.connect(destination);
        }

        events.forEach(event => {
            // Unison Logic:
            // If detune > 0 and not noise, we create 3 oscillators (SuperSaw style)
            // Left (-detune), Center (0), Right (+detune)
            const isNoise = event.wave === 'white_noise' || event.wave === 'pink_noise';
            const useUnison = !isNoise && event.detune && event.detune > 0;
            const voices = useUnison ? 3 : 1;

            for (let v = 0; v < voices; v++) {
                // 1. Source Logic
                let sourceNode: AudioScheduledSourceNode;
                let fmModulator: OscillatorNode | null = null;
                let fmGain: GainNode | null = null;
                
                // Voice Spread Logic
                let currentDetune = 0;
                let currentPanOffset = 0;
                let voiceGainScale = 1.0;

                if (useUnison) {
                    const detuneAmt = event.detune || 0;
                    if (v === 0) { currentDetune = -detuneAmt; currentPanOffset = -0.3; voiceGainScale = 0.6; } // Left
                    if (v === 1) { currentDetune = 0; currentPanOffset = 0; voiceGainScale = 0.7; }           // Center
                    if (v === 2) { currentDetune = detuneAmt; currentPanOffset = 0.3; voiceGainScale = 0.6; } // Right
                }

                if (isNoise) {
                    sourceNode = ctx.createBufferSource();
                    (sourceNode as AudioBufferSourceNode).buffer =
                        event.wave === 'white_noise' ? this.whiteNoiseBuffer : this.pinkNoiseBuffer;
                    (sourceNode as AudioBufferSourceNode).loop = true;
                } else {
                    sourceNode = ctx.createOscillator();
                    (sourceNode as OscillatorNode).type = event.wave as OscillatorType;
                    (sourceNode as OscillatorNode).frequency.value = event.freq;
                    (sourceNode as OscillatorNode).detune.value = currentDetune;

                    if (event.fm_wave && event.fm_ratio) {
                        fmModulator = ctx.createOscillator();
                        fmModulator.type = event.fm_wave as OscillatorType;
                        fmModulator.frequency.value = event.freq * event.fm_ratio;
                        // Apply slight detune to FM too for thickness
                        fmModulator.detune.value = currentDetune; 

                        fmGain = ctx.createGain();
                        fmGain.gain.value = event.fm_index || 0;

                        fmModulator.connect(fmGain);
                        fmGain.connect((sourceNode as OscillatorNode).frequency);
                    }
                }

                // 2. Filter (with Envelope Support)
                let filterNode: BiquadFilterNode | null = null;
                if (event.filter) {
                    filterNode = ctx.createBiquadFilter();
                    filterNode.type = event.filter.type;
                    
                    const baseFreq = event.filter.frequency;
                    // Slightly offset filter cutoff for unison voices adds stereo width
                    const freqOffset = useUnison ? (v - 1) * 50 : 0; 
                    
                    filterNode.frequency.setValueAtTime(baseFreq + freqOffset, event.time);
                    filterNode.Q.value = event.filter.Q;

                    if (event.filterEnvelope && event.filterEnvAmount && event.filterEnvAmount !== 0) {
                        const fe = event.filterEnvelope;
                        const amt = event.filterEnvAmount;
                        const t = event.time;

                        const fAttackEnd = t + fe.attack;
                        const fDecayEnd = fAttackEnd + fe.decay;
                        const fReleaseStart = t + event.duration;
                        const fReleaseEnd = fReleaseStart + fe.release;

                        const nyquist = ctx.sampleRate / 2;
                        const peakFreq = Math.min(Math.max(baseFreq + amt, 10), nyquist);
                        const sustainFreq = Math.min(Math.max(baseFreq + (amt * fe.sustain), 10), nyquist);

                        filterNode.frequency.setValueAtTime(baseFreq, t);
                        filterNode.frequency.exponentialRampToValueAtTime(peakFreq, fAttackEnd);
                        filterNode.frequency.exponentialRampToValueAtTime(sustainFreq, fDecayEnd);
                        filterNode.frequency.setValueAtTime(sustainFreq, fReleaseStart);
                        filterNode.frequency.exponentialRampToValueAtTime(baseFreq, fReleaseEnd);
                    }
                }

                // 3. Amp Envelope (VCA)
                const gainNode = ctx.createGain();

                // 4. Panner
                let pannerNode: StereoPannerNode | null = null;
                // Combine event pan with unison spread
                let finalPan = (event.pan || 0) + currentPanOffset;
                finalPan = Math.max(-1, Math.min(1, finalPan)); // Clamp

                if (finalPan !== 0) {
                    pannerNode = ctx.createStereoPanner();
                    pannerNode.pan.value = finalPan;
                }

                // 5. Connect Chain
                let curr: AudioNode = sourceNode;
                
                if (filterNode) { curr.connect(filterNode); curr = filterNode; }
                curr.connect(gainNode);
                curr = gainNode;
                if (pannerNode) { curr.connect(pannerNode); curr = pannerNode; }
                curr.connect(masterBus);

                // 6. Automation (Amp Envelope)
                const env = event.envelope;
                const t = event.time;
                const attackEnd = t + env.attack;
                const decayEnd = attackEnd + env.decay;
                
                // Scale gain by voice count to prevent clipping
                const totalGain = event.gain * voiceGainScale;
                const sustainLevel = totalGain * env.sustain;
                const releaseStart = t + event.duration;
                const releaseEnd = releaseStart + env.release;

                const ZERO = 0.0001;
                
                gainNode.gain.setValueAtTime(ZERO, t);
                gainNode.gain.exponentialRampToValueAtTime(Math.max(totalGain, ZERO), attackEnd);
                gainNode.gain.exponentialRampToValueAtTime(Math.max(sustainLevel, ZERO), decayEnd);
                gainNode.gain.setValueAtTime(Math.max(sustainLevel, ZERO), releaseStart);
                gainNode.gain.exponentialRampToValueAtTime(ZERO, releaseEnd);
                gainNode.gain.setValueAtTime(0, releaseEnd + 0.01); 

                // 7. LFO
                if (event.lfo) {
                    const lfo = ctx.createOscillator();
                    lfo.type = event.lfo.type;
                    lfo.frequency.value = event.lfo.frequency;

                    const lfoGain = ctx.createGain();
                    lfoGain.gain.value = event.lfo.amount;

                    lfo.connect(lfoGain);

                    if (event.lfo.target === 'frequency' && !isNoise) {
                        lfoGain.connect((sourceNode as OscillatorNode).frequency);
                    } else if (event.lfo.target === 'filter' && filterNode) {
                        lfoGain.connect(filterNode.frequency);
                    } else if (event.lfo.target === 'gain') {
                        lfoGain.connect(gainNode.gain);
                    } else if (event.lfo.target === 'pan' && pannerNode) {
                        lfoGain.connect(pannerNode.pan);
                    }

                    lfo.start(t);
                    lfo.stop(releaseEnd);

                    if (ctx instanceof AudioContext) {
                        registerSource(lfo);
                    }
                }

                sourceNode.start(t);
                sourceNode.stop(releaseEnd + 0.1);

                if (fmModulator) {
                    fmModulator.start(t);
                    fmModulator.stop(releaseEnd + 0.1);
                }

                if (ctx instanceof AudioContext) {
                    registerSource(sourceNode);
                    if (fmModulator) registerSource(fmModulator);
                }
            }
        });
    }
}
