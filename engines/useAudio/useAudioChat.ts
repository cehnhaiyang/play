
import { useState, useCallback } from 'react';
import { generateSyntax, fixSyntax } from '../../services/gemini';
import { Message } from '../../meta';

export const useAudioChat = () => {
    const [isProcessing, setIsProcessing] = useState(false);

    /**
     * 发送生成请求
     */
    const sendMessage = useCallback(async (content: string): Promise<{
        success: boolean;
        code?: string;
        replyMessage: Message;
    }> => {
        setIsProcessing(true);
        try {
            const code = await generateSyntax(content);
            const replyMessage: Message = { 
                role: 'model', 
                content: `已为您生成音频配置代码。正在自动加载到编辑器...`, 
                timestamp: Date.now() 
            };
            return { success: true, code, replyMessage };
        } catch (error: any) {
            let errorMsg = "生成失败，请重试。";
            if (error instanceof Error) {
                if (error.message.includes("API Key")) errorMsg = "错误：未检测到 API Key。请检查环境变量。";
            }
            const replyMessage: Message = { 
                role: 'model', 
                content: errorMsg, 
                timestamp: Date.now() 
            };
            return { success: false, replyMessage };
        } finally {
            setIsProcessing(false);
        }
    }, []);

    /**
     * 触发代码修复
     */
    const triggerFix = useCallback(async (brokenCode: string, error: string): Promise<{
        success: boolean;
        code?: string;
        replyMessage: Message;
    }> => {
        setIsProcessing(true);
        try {
            const fixedCode = await fixSyntax(brokenCode, error);
            const replyMessage: Message = { 
                role: 'model', 
                content: `修复完成！正在应用新代码。`, 
                timestamp: Date.now() 
            };
            return { success: true, code: fixedCode, replyMessage };
        } catch (err) {
             const replyMessage: Message = { 
                role: 'model', 
                content: `自动修复失败。请手动检查代码。`, 
                timestamp: Date.now() 
            };
            return { success: false, replyMessage };
        } finally {
            setIsProcessing(false);
        }
    }, []);

    return {
        isProcessing,
        sendMessage,
        triggerFix
    };
};