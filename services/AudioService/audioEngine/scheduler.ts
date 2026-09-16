
import { InstrumentDef, SequenceDef, ScheduledEvent, ArpCommand, ChordCommand } from '../../../meta';
import { getFreq, parseDuration } from '../utils';

export class EventScheduler {
    public schedule(
        sequences: Map<string, SequenceDef>,
        instruments: Map<string, InstrumentDef>,
        mixTracks: { source: string, time: number, loop: number }[],
        tempo: number
    ): { events: ScheduledEvent[], totalDuration: number } {
        
        const scheduledEvents: ScheduledEvent[] = [];
        let maxTime = 0;

        // Helper to schedule a single sequence
        const scheduleSequence = (seqName: string, startTime: number) => {
            const seq = sequences.get(seqName);
            if (!seq) return 0;

            let inst = instruments.get(seq.instrumentName);
            if (!inst) inst = instruments.get('default')!;

            let currentTime = startTime;

            seq.commands.forEach(cmd => {
                if (cmd.type === 'arp') {
                    const arpCmd = cmd as ArpCommand;
                    const totalDur = parseDuration(arpCmd.duration, tempo);
                    const stepDur = parseDuration(arpCmd.rate, tempo);
                    const steps = Math.floor(totalDur / stepDur);
                    const pitches = arpCmd.pitches;

                    if (pitches.length > 0) {
                        for (let i = 0; i < steps; i++) {
                            let noteIdx = 0;
                            if (arpCmd.pattern === 'up') noteIdx = i % pitches.length;
                            else if (arpCmd.pattern === 'down') noteIdx = (pitches.length - 1) - (i % pitches.length);
                            else if (arpCmd.pattern === 'upDown') {
                                const cycle = (pitches.length * 2) - 2;
                                const pos = i % cycle;
                                noteIdx = pos < pitches.length ? pos : cycle - pos;
                            } else {
                                noteIdx = Math.floor(Math.random() * pitches.length);
                            }

                            const freq = getFreq(pitches[noteIdx]);
                            scheduledEvents.push(this.createEvent(currentTime + (i * stepDur), freq, stepDur * 0.9, inst!));
                        }
                    }
                    currentTime += totalDur;

                } else if (cmd.type === 'note') {
                    const dur = parseDuration((cmd as any).duration, tempo);
                    const freq = getFreq((cmd as any).pitch);
                    scheduledEvents.push(this.createEvent(currentTime, freq, dur, inst!));
                    currentTime += dur;

                } else if (cmd.type === 'chord') {
                    const dur = parseDuration((cmd as any).duration, tempo);
                    const chord = cmd as ChordCommand;
                    chord.pitches.forEach(pitch => {
                        const freq = getFreq(pitch);
                        scheduledEvents.push(this.createEvent(currentTime, freq, dur, inst!));
                    });
                    currentTime += dur;

                } else if (cmd.type === 'rest') {
                    const dur = parseDuration((cmd as any).duration, tempo);
                    currentTime += dur;
                }
            });

            return currentTime - startTime;
        };

        // Main Loop
        if (mixTracks.length > 0) {
            mixTracks.forEach(track => {
                if (!sequences.has(track.source)) {
                     throw new Error(`Mix refers to undefined sequence: '${track.source}'`);
                }
                let currentStart = track.time;
                for (let i = 0; i < track.loop; i++) {
                    const duration = scheduleSequence(track.source, currentStart);
                    currentStart += duration;
                }
            });
        } else {
            sequences.forEach(seq => scheduleSequence(seq.name, 0));
        }

        // Calculate total duration including release tails
        scheduledEvents.forEach(ev => {
            const end = ev.time + ev.duration + ev.envelope.release;
            if (end > maxTime) maxTime = end;
        });

        return { events: scheduledEvents, totalDuration: maxTime };
    }

    private createEvent(time: number, freq: number, duration: number, inst: InstrumentDef): ScheduledEvent {
        return {
            time,
            freq,
            duration,
            wave: inst.wave,
            envelope: inst.envelope,
            
            filter: inst.filter,
            filterEnvelope: inst.filterEnvelope,
            filterEnvAmount: inst.filterEnvAmount,

            lfo: inst.lfo,
            pan: inst.pan,
            gain: inst.gain,
            fm_wave: inst.fm_wave,
            fm_index: inst.fm_index,
            fm_ratio: inst.fm_ratio,
            detune: inst.detune
        };
    }
}
