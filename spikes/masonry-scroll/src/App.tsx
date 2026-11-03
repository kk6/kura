import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { layout, visible } from "./masonry";
import { runBench } from "./bench";

const GAP = 6;

// 計測を自動で回すので、画面側のエラーも標準出力に出して終了させる
const fail = (e: unknown) => invoke("report", { json: JSON.stringify({ error: String(e) }) });
window.addEventListener("error", (e) => fail(e.message));
window.addEventListener("unhandledrejection", (e) => fail(e.reason));

type Config = { data_dir: string; bench: boolean; col: number };

export default function App() {
  const [config, setConfig] = useState<Config>();
  const [sizes, setSizes] = useState<[number, number][]>();
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    invoke<Config>("config").then(async (c) => {
      setConfig(c);
      setSizes(await (await fetch(convertFileSrc(`${c.data_dir}/manifest.json`))).json());
    });
  }, []);

  useEffect(() => {
    const el = ref.current!;
    const measure = () => setViewport({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const l = useMemo(
    () => (sizes && viewport.w ? layout(sizes, viewport.w - 32, config!.col, GAP) : undefined),
    [sizes, viewport.w, config],
  );

  useEffect(() => {
    if (l && config?.bench) runBench(ref.current!, l.height).then((r) => invoke("report", { json: JSON.stringify(r) }));
  }, [l, config]);

  const onScroll = () => {
    // スクロールのたびに描き直さず、1フレームに1回だけ反映する
    const el = ref.current!;
    requestAnimationFrame(() => setScrollTop(el.scrollTop));
  };

  // 上下に1画面分ずつ余分に描いておく
  const items = l ? visible(l, scrollTop - viewport.h, scrollTop + viewport.h * 2) : [];

  return (
    <div ref={ref} onScroll={onScroll} style={{ height: "100vh", overflowY: "auto", background: "#F3F3F1" }}>
      <div style={{ position: "relative", height: l ? l.height + 32 : 0, margin: "0 16px" }}>
        {l &&
          items.map((i) => (
            <img
              key={i}
              src={convertFileSrc(`${config!.data_dir}/thumbs/${i}.jpg`)}
              decoding="async"
              alt=""
              style={{
                position: "absolute",
                transform: `translate(${l.x[i]}px, ${l.y[i] + 16}px)`,
                width: l.colWidth,
                height: l.h[i],
                borderRadius: 2,
                background: "#E6E6E2",
              }}
            />
          ))}
      </div>
    </div>
  );
}
