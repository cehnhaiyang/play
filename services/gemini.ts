
import { GoogleGenAI, Type, Modality } from "@google/genai";
import { getResolvedApiKey } from './apiKey';
let aiClientKey = '';

// 惰性单例模式：避免在没有 API Key 时应用启动崩溃
let aiClient: GoogleGenAI | null = null;

const getAiClient = (): GoogleGenAI => {
    const apiKey = getResolvedApiKey();
    if (!apiKey) {
        throw new Error("API Key 未配置。请先在悬浮面板中填写并保存 API Key。");
    }

    if (!aiClient || aiClientKey !== apiKey) {
        aiClient = new GoogleGenAI({ apiKey });
        aiClientKey = apiKey;
    }

    return aiClient;
};

/* -------------------------------------------------------------------------- */
/*                                基础工具函数                                 */
/* -------------------------------------------------------------------------- */

/**
 * 辅助函数：清洗 JSON 字符串（去除 Markdown 代码块标记）
 */
const cleanJsonString = (text: string): string => {
  if (!text) return "";
  // 去除 ```json, ``` 以及可能的首尾空白
  return text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();
};

/**
 * 辅助函数：清洗代码块字符串（去除 Markdown 代码块标记）
 */
const cleanCodeBlock = (text: string): string => {
    if (!text) return "";
    // 尝试提取 Markdown 代码块 (```spg ... ``` 或 ``` ... ```)
    const codeBlockRegex = /```(?:spg|[\w]*)?\n([\s\S]*?)```/;
    const match = text.match(codeBlockRegex);
    
    if (match && match[1]) {
        return match[1].trim();
    }
    // 如果没有代码块，则尝试移除开头和结尾的可能的 Markdown 标记
    return text.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
};

/* -------------------------------------------------------------------------- */
/*                                提示词常量                                   */
/* -------------------------------------------------------------------------- */

// 系统提示词：告诉AI如何生成 .spg 语法
const SPG_SYSTEM_PROMPT = `
你是一位世界级的音频工程师和作曲家，精通 "Sound Particle Generator" (SPG) 语言。
你的目标是根据用户的自然语言描述，编写出**高保真、极具音乐性**的 SPG 代码。

### 高音质与交响乐设计指南 (Symphony & Sound Design)

1.  **交响乐编曲 (Symphony)**:
    *   **分层 (Layering)**: 交响乐必须包含多个声部。例如：旋律(Violin/Flute/Trumpet) + 和声(Strings/Brass) + 低音(Cello/Bass) + 打击乐(Timpani)。
    *   **声像 (Panning)**: 模仿真实管弦乐队座位。第一小提琴(pan=-0.5), 第二小提琴(pan=-0.3), 中提琴(pan=0), 大提琴(pan=0.4), 低音提琴(pan=0.6), 铜管(pan=0.2), 定音鼓(pan=0)。
    *   **动态 (Dynamics)**: 使用 \`gain\` 控制主次。旋律声部音量应略大(0.8)，伴奏略小(0.5-0.6)。
    *   **演奏法**: 弦乐断奏(Staccato)使用短 Duration，连奏(Legato)使用长 Attack/Release。

2.  **电子乐设计 (Electronic)**:
    *   使用 Detune (5-15 cents) 制造 Pad 和 Lead 的厚度。
    *   多使用 \`filter_envelope\` 和 \`filter_env_amount\` 制造动态扫频。
    *   空间感：务必使用 \`effect_chain\` 中的 \`reverb\` 和 \`delay\`。

### SPG 语言核心文档 (Strict Syntax)

SPG 代码由四个部分组成：Config, Instruments, Sequence, Mix。

#### 1. 全局配置 (Config)
config { 
  tempo: 120 
  master_gain: 0.6 
}

#### 2. 乐器定义 (Define Instrument)
使用 \`define_instrument(name="...") { ... }\`。

**可用预设 (preset)**:
*   **管弦乐**: "violin" (小提琴), "cello" (大提琴), "strings_section" (弦乐群), "brass_ensemble" (铜管群), "flute" (长笛), "clarinet" (单簧管), "timpani" (定音鼓), "harp" (竖琴)。
*   **电子/流行**: "piano", "guitar", "synth_pad", "kick", "bass", "acid", "plucked_synth"。

**自定义参数**:
*   \`wave\`: "sine", "square", "sawtooth", "triangle", "white_noise"。
*   \`envelope\`: \`adsr(attack, decay, sustain, release)\`。
*   \`filter\`: \`lowpass(freq, Q)\`。
*   \`filter_envelope\`: \`adsr(a, d, s, r)\`。
*   \`filter_env_amount\`: 调制深度(Hz)。
*   \`lfo\`: \`sine(freq=5, amount=10, target=frequency)\` (target: frequency/filter/gain/pan)。
*   \`gain\`: 0.0-1.0。
*   \`pan\`: -1.0 到 1.0。
*   \`detune\`: 音分(cents)，用于制造厚度或合唱效果。
*   \`fm_wave\`, \`fm_index\`, \`fm_ratio\`: FM合成。

**示例：史诗弦乐**
define_instrument(name="epic_strings") {
  preset: "strings_section"
  gain: 0.7
  pan: -0.2
  effect_chain { reverb(decay=4.0, mix=0.5) } 
}

#### 3. 序列 (Sequence)
定义旋律片段。\`sequence(name="...", instrument="...") { ... }\`
命令：
*   \`note("C4", "4n");\`
*   \`rest("8n");\`
*   \`chord(["C4", "E4", "G4"], "2n");\`
*   \`arp(chord=["C4", "E4", "G4"], pattern="up", rate="16n", duration="1n");\`

#### 4. 效果链 (Effect Chain)
effect_chain {
  delay(time=0.375, feedback=0.3, mix=0.2)
  reverb(decay=3.0, mix=0.4)
}

#### 5. 混音 (Mix)
安排播放顺序和层叠。
mix {
  track(source="melody_seq", time=0, loop=1)
  track(source="bass_seq", time=0, loop=1)
}

### 输出约束
1.  **只输出代码**，无 Markdown 标记。
2.  若用户请求“交响乐”或“史诗音乐”，**必须**创建至少 3 个不同乐器（如 Strings, Brass, Percussion）并同时播放。
`;

const SPG_FIX_PROMPT = `
你是一个代码修复专家。之前的 SPG 代码在编译时发生了错误。
请根据错误信息修复代码。

要求：
1. 仅返回修复后的完整代码。
2. 确保修复了报错指出的具体问题。
3. 保持原有音乐创意不变，只修正语法。
`;

/* -------------------------------------------------------------------------- */
/*                                核心功能函数                                 */
/* -------------------------------------------------------------------------- */

/**
 * 使用 Gemini 2.5 Flash 模型进行图片文字提取 (OCR)
 */
export const extractTextFromImage = async (imageBase64: string, mimeType: string, systemInstruction?: string): Promise<string> => {
  try {
    const ai = getAiClient();
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: mimeType,
              data: imageBase64,
            },
          },
          {
            text: "请提取这张图片中的所有文字。保持原有的格式和换行。只输出提取的文字内容，不要添加任何解释或Markdown标记。如果图片中没有文字，请回答'未检测到文字'。",
          },
        ],
      },
      config: {
        systemInstruction: systemInstruction
      }
    });

    return response.text || "未检测到文字或无法提取。";
  } catch (error: any) {
    console.error("Gemini OCR Error:", error);
    throw new Error(error.message || "文字提取失败：请检查图片是否清晰，或确认 API Key 是否有效。");
  }
};

/**
 * 翻译文本
 */
export const translateText = async (text: string, targetLang: string, systemInstruction?: string): Promise<string> => {
  try {
    const ai = getAiClient();
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: {
        parts: [{
          text: `请将以下文本翻译成${targetLang}。保持原文的语气和格式。仅输出翻译后的内容：\n\n${text}`
        }]
      },
      config: {
        systemInstruction: systemInstruction
      }
    });
    return response.text || "翻译失败";
  } catch (error: any) {
    console.error("Translation Error:", error);
    throw new Error(error.message || "翻译服务暂时不可用，请检查网络连接。");
  }
};

/**
 * 文件智能摘要
 */
export const summarizeFiles = async (fileContents: string[], systemInstruction?: string): Promise<string> => {
  try {
    const ai = getAiClient();
    const combinedText = fileContents.join("\n\n--- Next File ---\n\n");
    // 截断过长的文本防止超出 Token 限制 (简单估算)
    const truncatedText = combinedText.slice(0, 100000); 

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: {
        parts: [{
          text: `请对以下文件内容进行智能摘要。如果内容较多，请分点列出关键信息。忽略分隔符。保持客观简洁：\n\n${truncatedText}`
        }]
      },
      config: {
        systemInstruction: systemInstruction
      }
    });
    return response.text || "无法生成摘要";
  } catch (error: any) {
    console.error("Summarize Error:", error);
    throw new Error(error.message || "摘要生成失败，可能是内容过多或包含敏感信息。");
  }
};

/**
 * 根据多张图片生成连贯的故事
 * 返回格式：{ title: string, pages: string[] }
 */
export const generateStoryFromImages = async (
  images: { base64: string, mimeType: string }[], 
  systemInstruction?: string
): Promise<{ title: string, pages: string[] }> => {
  try {
    const ai = getAiClient();
    const parts: any[] = [];
    images.forEach(img => {
      parts.push({
        inlineData: {
          mimeType: img.mimeType,
          data: img.base64
        }
      });
    });

    parts.push({
      text: `请按顺序查看上述 ${images.length} 张图片。你需要发挥想象力，根据这些画面创作一个连贯、生动的故事。
      
      要求：
      1. 首先为这个故事取一个富有吸引力的标题。
      2. 故事必须连贯，前后呼应。
      3. 为每一张图片写一段剧情描述。
      4. 返回的结果必须是一个严格的 JSON 对象，格式如下：
         {
           "title": "故事标题",
           "pages": ["第1张图的剧情", "第2张图的剧情", ...]
         }
      5. 语言风格生动有趣，适合阅读。
      6. 不要使用 Markdown 代码块包裹，直接返回 JSON 字符串。`
    });

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: { parts: parts },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            pages: { 
              type: Type.ARRAY,
              items: { type: Type.STRING }
            }
          },
          required: ["title", "pages"]
        },
        systemInstruction: systemInstruction
      }
    });

    const rawText = response.text;
    if (!rawText) throw new Error("API 返回为空");
    
    const cleanJson = cleanJsonString(rawText);
    
    try {
        const result = JSON.parse(cleanJson);
        if (result.title && Array.isArray(result.pages)) {
          return result;
        }
    } catch (e) {
        console.error("JSON Parse Error:", e, "Raw:", rawText);
    }
    
    throw new Error("模型返回格式错误，未能生成有效的故事结构。");

  } catch (error: any) {
    console.error("Gemini Story Error:", error);
    throw new Error(error.message || "故事生成失败，请检查图片内容是否合规。");
  }
};

/**
 * 文本转语音 (TTS)
 */
export const generateSpeech = async (text: string): Promise<string | undefined> => {
  try {
    const ai = getAiClient();
    // 限制 TTS 文本长度，避免超时
    const safeText = text.slice(0, 500); 
    
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: safeText }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' }, // 使用 Kore 声音，比较温和
          },
        },
      },
    });

    return response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  } catch (error: any) {
    console.error("TTS Error:", error);
    throw new Error(error.message || "语音生成失败");
  }
};

// 音频解码工具函数
export const decodeAudioData = async (
  base64String: string,
  audioContext: AudioContext
): Promise<AudioBuffer> => {
  const binaryString = atob(base64String);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  
  // Gemini TTS 返回的是 raw PCM (24kHz, mono)
  const dataInt16 = new Int16Array(bytes.buffer);
  const sampleRate = 24000;
  const numChannels = 1;
  const frameCount = dataInt16.length;
  
  const buffer = audioContext.createBuffer(numChannels, frameCount, sampleRate);
  const channelData = buffer.getChannelData(0);
  
  for (let i = 0; i < frameCount; i++) {
    // 归一化到 [-1.0, 1.0]
    channelData[i] = dataInt16[i] / 32768.0;
  }
  
  return buffer;
};

/**
 * 生成 SPG 音频合成代码
 */
export const generateSyntax = async (userDescription: string): Promise<string> => {
  try {
    const ai = getAiClient();
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      config: {
        systemInstruction: SPG_SYSTEM_PROMPT,
        temperature: 0.7, 
      },
      contents: userDescription,
    });

    return cleanCodeBlock(response.text || "");
  } catch (error: any) {
    console.error("SPG Generation Error:", error);
    throw new Error(error.message || "SPG 代码生成失败");
  }
};

/**
 * 修复 SPG 音频合成代码
 */
export const fixSyntax = async (brokenCode: string, errorMessage: string): Promise<string> => {
    try {
        const ai = getAiClient();
        const prompt = `Code:\n${brokenCode}\n\nError:\n${errorMessage}`;
        
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            config: {
                systemInstruction: SPG_FIX_PROMPT,
                temperature: 0.2, 
            },
            contents: prompt,
        });

        return cleanCodeBlock(response.text || "");
    } catch (error: any) {
        console.error("SPG Fix Error:", error);
        throw new Error(error.message || "代码修复失败");
    }
};
