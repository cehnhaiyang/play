import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  analyser: AnalyserNode | null;
  isActive: boolean;
}

const Visualizer: React.FC<VisualizerProps> = ({ analyser, isActive }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);

  useEffect(() => {
    if (!analyser || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // High DPI scaling（窗口/容器尺寸变化时重算，否则拉伸模糊）
    const dpr = window.devicePixelRatio || 1;
    const resizeCanvas = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resizeCanvas();
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resizeCanvas) : null;
    resizeObserver?.observe(canvas);

    const bufferLength = analyser.frequencyBinCount;
    const dataArrayTime = new Uint8Array(bufferLength);
    const dataArrayFreq = new Uint8Array(bufferLength);

    const draw = () => {
      animationRef.current = requestAnimationFrame(draw);
      const width = canvas.clientWidth || 1;
      const height = canvas.clientHeight || 1;

      // 1. Fade out background (creating trails)
      ctx.fillStyle = isActive ? 'rgba(26, 32, 44, 0.3)' : 'rgb(26, 32, 44)';
      ctx.fillRect(0, 0, width, height);

      if (!isActive) {
        // Draw a flat line when idle
        ctx.beginPath();
        ctx.strokeStyle = '#2d3748';
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();
        return;
      }

      // Get Data
      analyser.getByteTimeDomainData(dataArrayTime);
      analyser.getByteFrequencyData(dataArrayFreq);

      const centerX = width / 2;
      const centerY = height / 2;

      // 2. Draw Frequency Spectrum (Mirrored Bars from Center)
      // Use lower frequencies (first half of buffer usually)
      const bars = 64; 
      const barWidth = (width / bars) / 2;
      const step = Math.floor(bufferLength / bars / 2); // Sampling step

      for (let i = 0; i < bars; i++) {
          const value = dataArrayFreq[i * step];
          const percent = value / 256;
          const barHeight = (height * 0.6) * percent;

          // Color gradient based on height
          const hue = 180 + (percent * 60); // Cyan to Blue/Purple
          ctx.fillStyle = `hsla(${hue}, 100%, 60%, 0.4)`;
          
          // Right side
          ctx.fillRect(centerX + (i * barWidth), centerY - barHeight / 2, barWidth - 1, barHeight);
          // Left side
          ctx.fillRect(centerX - ((i + 1) * barWidth), centerY - barHeight / 2, barWidth - 1, barHeight);
      }

      // 3. Draw Waveform (Oscilloscope) with Glow
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#00e5ff'; // Cyan
      ctx.shadowBlur = 10;
      ctx.shadowColor = '#00e5ff';
      
      ctx.beginPath();
      const sliceWidth = width * 1.0 / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArrayTime[i] / 128.0;
        const y = v * height / 2;

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          // Smooth curve
          const prevX = x - sliceWidth;
          const prevY = (dataArrayTime[i - 1] / 128.0) * height / 2;
          const xc = (prevX + x) / 2;
          const yc = (prevY + y) / 2;
          ctx.quadraticCurveTo(prevX, prevY, xc, yc);
        }

        x += sliceWidth;
      }

      ctx.lineTo(width, height / 2);
      ctx.stroke();
      
      // Reset Shadow for next frame
      ctx.shadowBlur = 0;
    };

    draw();

    return () => {
      resizeObserver?.disconnect();
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [analyser, isActive]);

  return (
    <div className="w-full h-full bg-gray-850 rounded-lg overflow-hidden border border-gray-750 shadow-inner relative">
      <canvas
        ref={canvasRef}
        className="w-full h-full block"
      />
      {/* Overlay Scanline Effect */}
      <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] z-10 bg-[length:100%_4px,6px_100%]" />
    </div>
  );
};

export default Visualizer;
