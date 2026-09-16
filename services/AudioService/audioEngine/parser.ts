
import { InstrumentDef, SequenceDef, EffectDef, Envelope, FilterDef, LFODef, ExpandedOscillatorType, ParserError } from '../../../meta';
import { parseDuration } from '../utils';
import { getPreset } from './presets';

export interface ParseResult {
    instruments: Map<string, InstrumentDef>;
    sequences: Map<string, SequenceDef>;
    effects: EffectDef[];
    tempo: number;
    masterVolumeConfig: number;
}

export class SPGParser {
    /**
     * 按行剥离注释（# 与 //），但忽略单双引号字符串内部的 # // 与 URL（如 http://）。
     * 旧实现 /( #|\/\/). * /g 会把 preset URL、字符串里的 // 一并切掉导致解析错乱。
     */
    private stripComments(code: string): string {
        return code.split('\n').map((line) => {
            let inSingle = false;
            let inDouble = false;
            for (let i = 0; i < line.length; i++) {
                const ch = line[i];
                if (ch === "'" && !inDouble && line[i - 1] !== '\\') {
                    inSingle = !inSingle;
                    continue;
                }
                if (ch === '"' && !inSingle && line[i - 1] !== '\\') {
                    inDouble = !inDouble;
                    continue;
                }
                if (inSingle || inDouble) continue;
                if (ch === '#') return line.slice(0, i);
                if (ch === '/' && line[i + 1] === '/') {
                    // URL 协议分隔符（http://、https://）不是注释
                    const before = line.slice(0, i);
                    if (/:\s*$/.test(before)) continue;
                    return before;
                }
            }
            return line;
        }).join('\n');
    }

    private parseParams(str: string): Record<string, string> {
        const params: Record<string, string> = {};
        const regex = /(\w+)\s*=\s*(?:["']([^"']+)["']|([^,\s)]+))/g;
        let match;
        while ((match = regex.exec(str)) !== null) {
            params[match[1]] = match[2] || match[3];
        }
        return params;
    }

    private parseEnvelopeStr(envStr: string | null): Envelope | undefined {
        if (!envStr) return undefined;

        const match = envStr.match(/adsr\s*\(([^)]+)\)/);
        if (!match) return undefined;

        const parts = match[1].split(',').map(s => parseFloat(s.trim()));
        return {
            attack: parts[0] ?? 0.01,
            decay: parts[1] ?? 0.1,
            sustain: parts[2] ?? 0.5,
            release: parts[3] ?? 0.1
        };
    }

    private parseFilterStr(filterStr: string | null): FilterDef | undefined {
        if (!filterStr) return undefined;
        const match = filterStr.match(/(lowpass|highpass|bandpass)\s*\(([^)]+)\)/);
        if (!match) return undefined;

        const type = match[1] as BiquadFilterType;
        const args = match[2].split(',').map(s => parseFloat(s.trim()));
        return {
            type: type,
            frequency: args[0] || 1000,
            Q: args[1] || 1
        };
    }

    private parseLFOStr(lfoStr: string | null): LFODef | undefined {
        if (!lfoStr) return undefined;
        const match = lfoStr.match(/(\w+)\s*\(([^)]+)\)/);
        if (!match) return undefined;

        const type = match[1] as OscillatorType;
        const params = this.parseParams(match[2]);

        return {
            type: type,
            frequency: parseFloat(params.freq || params.frequency || "1"),
            amount: parseFloat(params.amount || "10"),
            target: (params.target as any) || 'frequency'
        };
    }

    private parseEffectBlock(content: string, tempo: number): EffectDef[] {
        const effects: EffectDef[] = [];
        // Split by newline OR semicolon for robustness
        const lines = content.split(/[;\n]+/).map(l => l.trim()).filter(l => l.length > 0);
        
        lines.forEach(line => {
            if (line.startsWith('delay')) {
                const paramsMatch = line.match(/\(([^)]+)\)/);
                if (paramsMatch) {
                    const params = this.parseParams(paramsMatch[1]);
                    effects.push({
                        type: 'delay',
                        time: parseDuration(params.time || "0.3", tempo),
                        feedback: parseFloat(params.feedback || "0.3"),
                        mix: parseFloat(params.mix || "0.4")
                    });
                }
            } else if (line.startsWith('reverb')) {
                const paramsMatch = line.match(/\(([^)]+)\)/);
                if (paramsMatch) {
                    const params = this.parseParams(paramsMatch[1]);
                    effects.push({
                        type: 'reverb',
                        decay: parseFloat(params.decay || "2.0"),
                        mix: parseFloat(params.mix || "0.3")
                    });
                }
            } else if (line.startsWith('distortion')) {
                const paramsMatch = line.match(/\(([^)]+)\)/);
                if (paramsMatch) {
                    const params = this.parseParams(paramsMatch[1]);
                    effects.push({
                        type: 'distortion',
                        amount: parseFloat(params.amount || "0.5")
                    });
                }
            }
        });
        return effects;
    }

    public parse(code: string): ParseResult {
        const instruments = new Map<string, InstrumentDef>();
        const sequences = new Map<string, SequenceDef>();
        let effects: EffectDef[] = [];
        let tempo = 120;
        let masterVolumeConfig = 0.5;

        const cleanCode = this.stripComments(code);

        // 1. Config
        const configMatch = cleanCode.match(/config\s*\{([^}]+)\}/);
        if (configMatch) {
            const configBody = configMatch[1];
            const tempoMatch = configBody.match(/tempo:\s*(\d+)/);
            const volMatch = configBody.match(/master_gain:\s*([\d.]+)/);

            if (tempoMatch) tempo = parseInt(tempoMatch[1]);
            if (volMatch) masterVolumeConfig = parseFloat(volMatch[1]);
        }

        // 2. Instruments
        const instRegex = /define_instrument\s*\(\s*name\s*=\s*["']([^"']+)["']\s*\)\s*\{([^}]+)\}/g;
        let match;
        while ((match = instRegex.exec(cleanCode)) !== null) {
            const name = match[1];
            const content = match[2];

            // Check for preset
            const presetMatch = content.match(/preset:\s*["']([^"']+)["']/);
            let baseParams: Partial<InstrumentDef> = {};
            
            // Load preset if exists
            if (presetMatch) {
                const presetName = presetMatch[1];
                const loadedPreset = getPreset(presetName);
                if (loadedPreset) {
                    baseParams = { ...loadedPreset };
                }
            }
            
            // Explicit overrides
            const waveMatch = content.match(/wave:\s*["']([^"']+)["']/);
            const envMatch = content.match(/envelope:\s*["']([^"']+)["']/);
            const filterMatch = content.match(/filter:\s*["']([^"']+)["']/);
            // New Filter Envelope Params
            const filterEnvMatch = content.match(/filter_envelope:\s*["']([^"']+)["']/);
            const filterEnvAmtMatch = content.match(/filter_env_amount:\s*([\d.-]+)/);

            const lfoMatch = content.match(/lfo:\s*["']([^"']+)["']/);
            const panMatch = content.match(/pan:\s*([\d.-]+)/);
            const gainMatch = content.match(/gain:\s*([\d.]+)/);

            // FM Params
            const fmWaveMatch = content.match(/fm_wave:\s*["']([^"']+)["']/);
            const fmIndexMatch = content.match(/fm_index:\s*([\d.]+)/);
            const fmRatioMatch = content.match(/fm_ratio:\s*([\d.]+)/);
            const detuneMatch = content.match(/detune:\s*([\d.]+)/);

            const parsedEnvelope = this.parseEnvelopeStr(envMatch ? envMatch[1] : null);
            const parsedFilter = this.parseFilterStr(filterMatch ? filterMatch[1] : null);
            const parsedFilterEnv = this.parseEnvelopeStr(filterEnvMatch ? filterEnvMatch[1] : null);
            const parsedLFO = this.parseLFOStr(lfoMatch ? lfoMatch[1] : null);

            // Final Merge: Explicit > Preset > Default
            const defaultEnv: Envelope = { attack: 0.01, decay: 0.1, sustain: 0.7, release: 0.2 };

            instruments.set(name, {
                name,
                wave: (waveMatch ? (waveMatch[1] as ExpandedOscillatorType) : baseParams.wave) || 'sine',
                envelope: parsedEnvelope || baseParams.envelope || defaultEnv,
                
                filter: parsedFilter || baseParams.filter,
                filterEnvelope: parsedFilterEnv || baseParams.filterEnvelope,
                filterEnvAmount: filterEnvAmtMatch ? parseFloat(filterEnvAmtMatch[1]) : (baseParams.filterEnvAmount || 0),

                lfo: parsedLFO || baseParams.lfo,
                pan: panMatch ? parseFloat(panMatch[1]) : baseParams.pan,
                gain: gainMatch ? parseFloat(gainMatch[1]) : (baseParams.gain || 0.8),
                
                // FM / Advanced
                fm_wave: fmWaveMatch ? (fmWaveMatch[1] as OscillatorType) : baseParams.fm_wave,
                fm_index: fmIndexMatch ? parseFloat(fmIndexMatch[1]) : baseParams.fm_index,
                fm_ratio: fmRatioMatch ? parseFloat(fmRatioMatch[1]) : baseParams.fm_ratio,
                detune: detuneMatch ? parseFloat(detuneMatch[1]) : baseParams.detune
            });
        }

        // Default fallback
        if (instruments.size === 0) {
            instruments.set('default', {
                name: 'default',
                wave: 'sine',
                envelope: { attack: 0.01, decay: 0.1, sustain: 0.7, release: 0.2 },
                gain: 0.5
            });
        }

        // 3. Effects
        const effectMatch = cleanCode.match(/effect_chain\s*\{([^}]+)\}/);
        if (effectMatch) {
            effects = this.parseEffectBlock(effectMatch[1], tempo);
        }

        // 4. Sequences
        const seqRegex = /sequence\s*\(\s*name\s*=\s*["']([^"']+)["']\s*(?:,\s*instrument\s*=\s*["']([^"']+)["'])?\s*\)\s*\{([^}]+)\}/g;
        while ((match = seqRegex.exec(cleanCode)) !== null) {
            const seqName = match[1];
            const instrumentName = match[2] || 'default';
            const content = match[3];

            // Validate instrument existence, but allow 'default' even if not explicitly defined
            // because we add a fallback 'default' instrument above.
            if (!instruments.has(instrumentName) && instrumentName !== 'default') {
                throw new Error(`Sequence '${seqName}' references undefined instrument '${instrumentName}'`);
            }

            const commands: any[] = [];
            // Robust split: allow semicolons OR newlines
            const lines = content.split(/[;\n]+/).map(l => l.trim()).filter(l => l.length > 0);

            for (const line of lines) {
                if (line.startsWith('arp')) {
                    const paramsStr = line.match(/\((.*)\)/)?.[1];
                    if (paramsStr) {
                        const params = this.parseParams(paramsStr);
                        const chordArrMatch = line.match(/chord\s*=\s*\[(.*?)\]/);
                        const pitches = chordArrMatch ? chordArrMatch[1].split(',').map(p => p.trim().replace(/['"]/g, '')) : [];

                        if (!params.duration) throw new Error(`Arp in sequence '${seqName}' missing 'duration'`);

                        commands.push({
                            type: 'arp',
                            pitches,
                            pattern: (params.pattern as any) || 'up',
                            rate: params.rate || '16n',
                            duration: params.duration
                        });
                    }
                    continue;
                }

                const chordM = line.match(/chord\s*\(\s*\[(.*?)\]\s*,\s*["']?([^"']+)["']?\s*\)/);
                if (chordM) {
                    const pitches = chordM[1].split(',').map(p => p.trim().replace(/['"]/g, ''));
                    const duration = chordM[2];
                    commands.push({ type: 'chord', pitches, duration });
                    continue;
                }
                const noteM = line.match(/note\s*\(\s*["']([^"']+)["']\s*,\s*["']?([^"']+)["']?\s*\)/);
                if (noteM) {
                    commands.push({ type: 'note', pitch: noteM[1], duration: noteM[2] });
                    continue;
                }
                const restM = line.match(/rest\s*\(\s*["']?([^"']+)["']?\s*\)/);
                if (restM) {
                    commands.push({ type: 'rest', duration: restM[1] });
                }
            }
            sequences.set(seqName, { name: seqName, instrumentName, commands });
        }
        
        return { instruments, sequences, effects, tempo, masterVolumeConfig };
    }

    public parseMix(code: string): {source: string, time: number, loop: number}[] {
        const cleanCode = this.stripComments(code); 
        const mixMatch = cleanCode.match(/mix\s*\{([^}]+)\}/);
        const tracks: {source: string, time: number, loop: number}[] = [];

        if (mixMatch) {
            const mixContent = mixMatch[1];
            // Split mix by newlines OR semicolons
            const lines = mixContent.split(/[;\n]+/).map(l => l.trim()).filter(l => l.length > 0);
            
            for (const line of lines) {
                const tMatch = line.match(/track\s*\(([^)]+)\)/);
                if (tMatch) {
                    const params = this.parseParams(tMatch[1]);
                    const seqName = params.source;
                    const startTime = params.time ? parseFloat(params.time) : 0;
                    const loopCount = params.loop ? parseInt(params.loop) : 1;
                    
                    if(seqName) {
                        tracks.push({ source: seqName, time: startTime, loop: loopCount });
                    }
                }
            }
        }
        return tracks;
    }
}
