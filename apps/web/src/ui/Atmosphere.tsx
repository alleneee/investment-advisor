import { useEffect, useRef } from "react";

export function Atmosphere() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
    if (reduced || typeof window.matchMedia !== "function") return;

    const canvas = canvasRef.current;
    if (canvas == null) return;
    const context = canvas.getContext("2d");
    if (context == null) return;

    const size = 128;
    canvas.width = size;
    canvas.height = size;
    let raf = 0;
    let last = 0;

    const paint = (now: number) => {
      raf = requestAnimationFrame(paint);
      if (now - last < 120) return;
      last = now;
      const image = context.createImageData(size, size);
      const pixels = image.data;
      for (let index = 0; index < pixels.length; index += 4) {
        const value = 70 + ((Math.random() * 120) | 0);
        pixels[index] = value;
        pixels[index + 1] = value;
        pixels[index + 2] = value;
        pixels[index + 3] = Math.random() < 0.12 ? 28 : 0;
      }
      context.putImageData(image, 0, 0);
    };

    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="ui-atmosphere" aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
