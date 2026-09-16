
import JSZip from 'jszip';

/* -------------------------------------------------------------------------- */
/*                                基础频率计算                                 */
/* -------------------------------------------------------------------------- */

const noteFreqCache: Record<string, number> = {};
const A4 = 440;
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function getFreq(note: string): number {
  if (noteFreqCache[note]) return noteFreqCache[note];
  
  const match = note.match(/^([A-G][b#]?)(-?\d+)$/);
  if (!match) return 0; // Silent/Rest

  let name = match[1];
  // Normalize flats
  if (name.endsWith('b')) {
      const base = name[0];
      const prevIndex = (NOTES.indexOf(base) - 1 + 12) % 12;
      name = NOTES[prevIndex]; // e.g. Db -> C#
  }

  const octave = parseInt(match[2]);
  
  const semitoneIndex = NOTES.indexOf(name);
  const semitonesFromA4 = (semitoneIndex - NOTES.indexOf('A')) + (octave - 4) * 12;
  const freq = A4 * Math.pow(2, semitonesFromA4 / 12);
  
  noteFreqCache[note] = freq;
  return freq;
}

// 解析 "4n", "1s", "0.5" 到秒
export function parseDuration(dur: string | number, tempo: number): number {
  if (dur === undefined || dur === null) return 0;
  if (typeof dur === 'number') return dur;
  
  const str = dur.toString().toLowerCase().trim();
  if (str.endsWith('ms')) return parseFloat(str) / 1000;
  if (str.endsWith('s')) return parseFloat(str);
  
  // 60 BPM = 1 beat per second
  const beatTime = 60 / tempo; 
  
  if (str === '4n') return beatTime;
  if (str === '8n') return beatTime / 2;
  if (str === '16n') return beatTime / 4;
  if (str === '2n') return beatTime * 2;
  if (str === '1n') return beatTime * 4;
  if (str === '32n') return beatTime / 8;
  
  const floatVal = parseFloat(str);
  if (!isNaN(floatVal)) return floatVal;

  return beatTime;
}

/* -------------------------------------------------------------------------- */
/*                                Wave 编码器                                  */
/* -------------------------------------------------------------------------- */

export function bufferToWave(abuffer: AudioBuffer, len: number): Blob {
  const numOfChan = abuffer.numberOfChannels;
  const length = len * numOfChan * 2 + 44;
  const buffer = new ArrayBuffer(length);
  const view = new DataView(buffer);
  const channels = [];
  let i;
  let sample;
  let offset = 0;
  let pos = 0;

  // write WAVE header
  setUint32(0x46464952); // "RIFF"
  setUint32(length - 8); // file length - 8
  setUint32(0x45564157); // "WAVE"

  setUint32(0x20746d66); // "fmt " chunk
  setUint32(16); // length = 16
  setUint16(1); // PCM (uncompressed)
  setUint16(numOfChan);
  setUint32(abuffer.sampleRate);
  setUint32(abuffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
  setUint16(numOfChan * 2); // block-align
  setUint16(16); // 16-bit (hardcoded in this encoder)

  setUint32(0x61746164); // "data" - chunk
  setUint32(length - pos - 4); // chunk length

  // write interleaved data
  for (i = 0; i < abuffer.numberOfChannels; i++)
    channels.push(abuffer.getChannelData(i));

  let frameIndex = 0;
  // We use frameIndex to iterate samples, and offset to iterate output bytes relative to data chunk start
  while (frameIndex < len) {
    for (i = 0; i < numOfChan; i++) {
      // interleave channels
      const val = channels[i][frameIndex];
      // Check if value is defined and clamp
      sample = Math.max(-1, Math.min(1, val || 0)); 
      // scale to 16-bit signed int
      sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0; 
      view.setInt16(44 + offset, sample, true);
      offset += 2;
    }
    frameIndex++;
  }

  return new Blob([buffer], { type: "audio/wav" });

  function setUint16(data: number) {
    view.setUint16(pos, data, true);
    pos += 2;
  }

  function setUint32(data: number) {
    view.setUint32(pos, data, true);
    pos += 4;
  }
}

/* -------------------------------------------------------------------------- */
/*                                Zip 导出服务                                 */
/* -------------------------------------------------------------------------- */

export const exportProjectBundle = async (sourceCode: string, audioBlob: Blob): Promise<Blob> => {
  const zip = new JSZip();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  
  // 添加源码文件
  zip.file(`project_${timestamp}.spg`, sourceCode);
  
  // 添加音频文件
  zip.file(`audio_${timestamp}.wav`, audioBlob);
  
  // 添加说明文件
  const readme = `Sound Particle Project
Created at: ${new Date().toLocaleString()}

How to use:
1. Open https://sound-particle.app (or your hosted URL)
2. Click "Import Project"
3. Select the .spg file from this archive
`;
  zip.file("README.txt", readme);

  // 生成 ZIP Blob
  return await zip.generateAsync({ type: "blob" });
};
