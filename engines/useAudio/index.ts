
import { useAudioProjects } from './useAudioProjects';
import { useAudioEngine } from './useAudioEngine';
import { useAudioTools } from './useAudioTools';
import { useAudioChat } from './useAudioChat';

export const useAudio = () => {
    const projects = useAudioProjects();
    const engine = useAudioEngine();
    const tools = useAudioTools();
    const chat = useAudioChat();

    return {
        projects,
        engine,
        tools,
        chat
    };
};